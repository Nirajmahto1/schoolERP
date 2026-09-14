// ──────────────────────────────────────────────
// Batch PDF endpoints (BUILD_PLAN 6.3)
//
//   POST /receipts/batch     → one ZIP, one fee-receipt PDF per payment id
//   POST /report-cards/batch → one ZIP, one report-card PDF per student
//
// "Batch PDF generation without crashing" is the second half of 6.3. Each
// PDF streams straight into the ZIP entry as it is rendered — at no point do
// all documents exist in memory together — and one bad id becomes a
// MANIFEST.txt line, not a 500.
// ──────────────────────────────────────────────

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type batchRequest struct {
	IDs []string `json:"ids"`
}

func readJSONBody(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ── Fee receipts ───────────────────────────────

type receiptRowQ struct {
	id          string
	receiptNo   *string
	paidAt      *time.Time
	amount      float64
	method      string
	gatewayID   *string
	admissionNo *string
	firstName   *string
	lastName    *string
	branchName  *string
	branchAddr  *string
	branchPhone *string
	chequeNo    *string
}

type allocRow struct {
	feeHead   string
	invoiceNo string
	amount    float64
}

// loadPayments fetches the payment rows (with student/branch/cheque joins)
// for the requested ids in one roundtrip, and reports ids that matched
// nothing so the manifest can name them.
func loadPayments(t queryer, ids []string) ([]receiptRowQ, []string, error) {
	if len(ids) == 0 {
		return nil, nil, fmt.Errorf("ids array is required")
	}
	if len(ids) > 2000 {
		return nil, nil, fmt.Errorf("batch limited to 2000 receipts per call")
	}
	rows, err := t.Query(ctx2(), `
		SELECT p."id", p."receiptNo", p."paidAt", p."amount"::float8, p."method"::text, p."gatewayPaymentId",
		       s."admissionNo", s."firstName", s."lastName",
		       b."name", b."address", b."phone", ch."chequeNumber"
		FROM "payments" p
		JOIN "branches" b ON b."id" = p."branchId"
		LEFT JOIN "students" s ON s."id" = p."studentId"
		LEFT JOIN "cheque_payments" ch ON ch."paymentId" = p."id"
		WHERE p."id" = any($1)`, ids)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	out := []receiptRowQ{}
	missing := map[string]bool{}
	for _, id := range ids {
		missing[id] = true
	}
	for rows.Next() {
		var r receiptRowQ
		if err := rows.Scan(&r.id, &r.receiptNo, &r.paidAt, &r.amount, &r.method, &r.gatewayID,
			&r.admissionNo, &r.firstName, &r.lastName,
			&r.branchName, &r.branchAddr, &r.branchPhone, &r.chequeNo); err != nil {
			return nil, nil, err
		}
		delete(missing, r.id)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	missList := make([]string, 0, len(missing))
	for id := range missing {
		missList = append(missList, id)
	}
	sort.Strings(missList)
	return out, missList, nil
}

// loadAllocations resolves how a payment split across invoices/fee heads —
// the receipt's line rows. Zero allocations (a payment not yet allocated,
// e.g. an advance) falls back to a single "Fee payment" line.
func loadAllocations(t queryer, paymentID string) ([]allocRow, error) {
	rows, err := t.Query(ctx2(), `
		SELECT COALESCE(l."name", 'Fee'), COALESCE(i."invoiceNo", '—'), a."amount"::float8
		FROM "payment_allocations" a
		JOIN "invoices" i ON i."id" = a."invoiceId"
		LEFT JOIN "invoice_lines" il ON il."invoiceId" = i."id"
		LEFT JOIN "fee_heads" l ON l."id" = il."feeHeadId"
		WHERE a."paymentId" = $1
		ORDER BY a."createdAt" ASC`, paymentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []allocRow{}
	seen := map[string]bool{}
	for rows.Next() {
		var a allocRow
		if err := rows.Scan(&a.feeHead, &a.invoiceNo, &a.amount); err != nil {
			return nil, err
		}
		// One line per invoice+head pair: the join fans out across an
		// invoice's lines, and a receipt line per head is the accounting
		// reality; dedupe on (invoice, head) keeps it one row.
		key := a.invoiceNo + "|" + a.feeHead
		if !seen[key] {
			seen[key] = true
			out = append(out, a)
		}
	}
	return out, rows.Err()
}

// methodLabel mirrors the Node METHOD_LABEL map.
func methodLabel(m string) string {
	labels := map[string]string{
		"CASH": "Cash", "CHEQUE": "Cheque", "UPI": "UPI",
		"BANK_TRANSFER": "Bank transfer", "CARD": "Card", "ONLINE": "Online",
	}
	if l, ok := labels[m]; ok {
		return l
	}
	return m
}

// fmtINR renders Indian-style grouping: 12,34,567.89. The rule: last three
// digits are the first group, everything before them groups in pairs.
func fmtINR(n float64) string {
	s := fmt.Sprintf("%.2f", n)
	intPart, dec := s[:len(s)-3], s[len(s)-3:]
	neg := ""
	if strings.HasPrefix(intPart, "-") {
		neg = "-"
		intPart = intPart[1:]
	}
	if len(intPart) > 3 {
		last3 := intPart[len(intPart)-3:]
		rest := intPart[:len(intPart)-3]
		var pairs []string
		for len(rest) > 2 {
			pairs = append([]string{rest[len(rest)-2:]}, pairs...)
			rest = rest[:len(rest)-2]
		}
		if rest != "" {
			pairs = append([]string{rest}, pairs...)
		}
		intPart = strings.Join(append(pairs, last3), ",")
	}
	return neg + intPart + dec
}

// receiptPdfBytes renders one receipt in the same layout as fee-service's
// renderReceiptPdf, through the shared Go PDF primitives.
func receiptPdfBytes(t queryer, r receiptRowQ) []byte {
	// Allocations need a live connection; a nil queryer (unit tests) renders
	// the single-line fallback form.
	var allocs []allocRow
	if t != nil {
		allocs, _ = loadAllocations(t, r.id)
	}
	rows := make([]struct{ label, invoice, amount string }, 0, len(allocs))
	for _, a := range allocs {
		rows = append(rows, struct{ label, invoice, amount string }{a.feeHead, a.invoiceNo, fmtINR(a.amount)})
	}
	if len(rows) == 0 {
		rows = append(rows, struct{ label, invoice, amount string }{"Fee payment", "—", fmtINR(r.amount)})
	}

	schoolLines := []string{}
	if v := deref(r.branchAddr); v != "" {
		schoolLines = append(schoolLines, v)
	}
	if v := deref(r.branchPhone); v != "" {
		schoolLines = append(schoolLines, "Ph: "+v)
	}
	studentLine := "—"
	if r.firstName != nil {
		studentLine = fmt.Sprintf("%s %s (%s)", *r.firstName, *r.lastName, deref(r.admissionNo))
	}
	receiptNo := deref(r.receiptNo)
	if receiptNo == "" {
		receiptNo = "UNNUMBERED"
	}
	date := "—"
	if r.paidAt != nil {
		date = r.paidAt.Format("02 Jan 2006")
	}
	modeLine := "Payment mode: " + methodLabel(r.method)
	if v := deref(r.chequeNo); v != "" {
		modeLine += " — Cheque No. " + v
	}

	ops := []drawOp{}
	right := func(y, size float64, bold bool, txt string) {
		w := textWidth(txt, size, bold)
		ops = append(ops, textOp{x: pageW - margin - w, y: y, size: size, bold: bold, text: txt})
	}

	y := float64(pageH - margin)
	ops = append(ops, textOp{x: margin, y: y, size: 16, bold: true,
		text: clip(deref(r.branchName), 16, true, float64(pageW-margin*2-180))})
	y -= 20
	for _, l := range schoolLines {
		ops = append(ops, textOp{x: margin, y: y, size: 9, text: clip(l, 9, false, 340)})
		y -= 12
	}
	ry := float64(pageH - margin)
	right(ry, 11, true, "FEE RECEIPT")
	right(ry-16, 10, true, "No: "+receiptNo)
	right(ry-30, 9, false, "Date: "+date)
	y -= 8
	ops = append(ops, lineOp{x1: margin, y1: y, x2: pageW - margin, y2: y})
	y -= 26
	ops = append(ops, textOp{x: margin, y: y, size: 10, bold: true,
		text: clip("Student: "+studentLine, 10, true, float64(pageW-margin*2-220))})
	if w := textWidth(modeLine, 10, false); modeLine != "" {
		ops = append(ops, textOp{x: pageW - margin - w, y: y, size: 10, text: modeLine})
	}
	y -= 6
	ops = append(ops, lineOp{x1: margin, y1: y, x2: pageW - margin, y2: y})
	y -= 16
	ops = append(ops, textOp{x: margin + 4, y: y, size: 9, bold: true, text: "FEE HEAD"})
	ops = append(ops, textOp{x: 260, y: y, size: 9, bold: true, text: "INVOICE"})
	right(y, 9, true, "AMOUNT (INR)")
	y -= 6
	ops = append(ops, lineOp{x1: margin, y1: y, x2: pageW - margin, y2: y})
	y -= 16
	for _, row := range rows {
		ops = append(ops, textOp{x: margin + 4, y: y, size: 9, text: clip(row.label, 9, false, 200)})
		ops = append(ops, textOp{x: 260, y: y, size: 9, text: clip(row.invoice, 9, false, 140)})
		right(y, 9, false, row.amount)
		y -= 16
	}
	y -= 2
	ops = append(ops, lineOp{x1: margin, y1: y, x2: pageW - margin, y2: y})
	y -= 18
	right(y, 10, true, "TOTAL PAID")
	right(y, 10, true, fmtINR(r.amount))
	if v := deref(r.gatewayID); v != "" {
		ops = append(ops, textOp{x: margin, y: margin + 20, size: 8, text: "Gateway reference: " + v})
	}
	ops = append(ops, textOp{x: margin, y: margin + 8, size: 8,
		text: "This is a computer-generated receipt and does not require a signature. Please retain for your records."})
	return assemblePdf(ops)
}

func handleReceiptsBatch(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, _ *AssertionClaims) {
	var req batchRequest
	if err := readJSONBody(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON body { ids: string[] } is required"})
		return
	}

	var payments []receiptRowQ
	var missing []string
	err := tx(r.Context(), pool, func(t pgx.Tx) error {
		var e error
		payments, missing, e = loadPayments(t, req.IDs)
		return e
	})
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}

	// One connection for the per-receipt allocation lookups too.
	conn, err := pool.Acquire(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer conn.Release()

	zw := zipWriter(w, "receipts.zip")
	manifest := []string{}
	for _, p := range payments {
		name := "receipt-" + deref(p.receiptNo) + ".pdf"
		if name == "receipt-.pdf" || name == "receipt-UNNUMBERED.pdf" {
			name = "receipt-" + p.id + ".pdf"
		}
		f, zerr := zw.Create(name)
		if zerr != nil {
			return
		}
		_, _ = f.Write(receiptPdfBytes(conn, p))
	}
	for _, id := range missing {
		manifest = append(manifest, "NOT FOUND: "+id)
	}
	if len(manifest) > 0 {
		f, zerr := zw.Create("MANIFEST.txt")
		if zerr != nil {
			return
		}
		_, _ = f.Write([]byte(strings.Join(manifest, "\n") + "\n"))
	}
	_ = zw.Close()
}

// ── Report cards ───────────────────────────────

type reportCardQ struct {
	studentID   string
	admissionNo string
	firstName   string
	lastName    string
	className   string
	sectionName string
}

type rcSubjectRow struct {
	subject   string
	examName  string
	maxMarks  float64
	marks     *float64
	grade     *string
	isAbsent  bool
}

// loadReportCardData fetches everything one student's report card needs:
// identity from the current enrollment, then every PUBLISHED exam result of
// the current academic year. Unpublished results NEVER appear here — the
// report card is the most visible artefact of the publication rule.
func loadReportCardData(t queryer, branchID, studentID string) (*reportCardQ, []rcSubjectRow, error) {
	rc := &reportCardQ{studentID: studentID}
	err := t.QueryRow(ctx2(), `
		SELECT s."admissionNo", s."firstName", s."lastName", c."name", sec."name"
		FROM "students" s
		JOIN "student_enrollments" e ON e."studentId" = s."id" AND e."status" = 'ENROLLED'
		JOIN "academic_years" y ON y."id" = e."academicYearId" AND y."isCurrent" = true
		JOIN "classes" c ON c."id" = e."classId"
		JOIN "sections" sec ON sec."id" = e."sectionId"
		WHERE s."id" = $1 AND s."branchId" = $2 AND s."deletedAt" IS NULL`,
		studentID, branchID).
		Scan(&rc.admissionNo, &rc.firstName, &rc.lastName, &rc.className, &rc.sectionName)
	if err != nil {
		return nil, nil, fmt.Errorf("student %s has no current enrollment", studentID)
	}

	rows, err := t.Query(ctx2(), `
		SELECT sub."name", x."name", es."maxMarks"::float8,
		       r."marksObtained"::float8, r."grade"::text, r."isAbsent"
		FROM "exam_results" r
		JOIN "exam_subjects" es ON es."id" = r."examSubjectId"
		JOIN "examinations" x ON x."id" = es."examinationId"
		JOIN "subjects" sub ON sub."id" = es."subjectId"
		WHERE r."studentId" = $1 AND x."branchId" = $2 AND x."status" = 'PUBLISHED'
		ORDER BY x."startDate" ASC, sub."name" ASC`,
		studentID, branchID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []rcSubjectRow{}
	for rows.Next() {
		var s rcSubjectRow
		if err := rows.Scan(&s.subject, &s.examName, &s.maxMarks, &s.marks, &s.grade, &s.isAbsent); err != nil {
			return nil, nil, err
		}
		out = append(out, s)
	}
	return rc, out, rows.Err()
}

// reportCardPdfBytes renders a simple but formal report card: identity
// header, one row per subject (grouped per exam), totals, and the school
// position that the results are final.
func reportCardPdfBytes(rc *reportCardQ, subjects []rcSubjectRow) []byte {
	ops := []drawOp{}
	center := func(y, size float64, bold bool, txt string, width float64) {
		w := textWidth(txt, size, bold)
		ops = append(ops, textOp{x: (pageW - w) / 2, y: y, size: size, bold: bold, text: txt})
	}

	center(float64(pageH-margin), 16, true, "STUDENT REPORT CARD", 0)
	y := float64(pageH - margin - 28)
	center(y, 10, false, fmt.Sprintf("%s %s  ·  %s  (%s)", rc.firstName, rc.lastName, rc.className+"-"+rc.sectionName, rc.admissionNo), 0)
	y -= 24

	ops = append(ops, lineOp{x1: margin, y1: y, x2: pageW - margin, y2: y})
	y -= 18
	ops = append(ops, textOp{x: margin + 4, y: y, size: 9, bold: true, text: "SUBJECT"})
	ops = append(ops, textOp{x: 240, y: y, size: 9, bold: true, text: "EXAM"})
	right := func(yy, size float64, bold bool, txt string) {
		w := textWidth(txt, size, bold)
		ops = append(ops, textOp{x: pageW - margin - w, y: yy, size: size, bold: bold, text: txt})
	}
	right(y, 9, true, "MARK")
	right(y, 9, true, "")
	ops = append(ops, textOp{x: pageW - margin - 60, y: y, size: 9, bold: true, text: "GRADE"})
	y -= 6
	ops = append(ops, lineOp{x1: margin, y1: y, x2: pageW - margin, y2: y})
	y -= 16

	obtained, total := 0.0, 0.0
	for _, s := range subjects {
		mark := "—"
		if s.isAbsent {
			mark = "AB"
		} else if s.marks != nil {
			mark = fmt.Sprintf("%.0f/%.0f", *s.marks, s.maxMarks)
			obtained += *s.marks
			total += s.maxMarks
		}
		grade := deref(s.grade)
		if grade == "" {
			grade = "—"
		}
		ops = append(ops, textOp{x: margin + 4, y: y, size: 9, text: clip(s.subject, 9, false, 190)})
		ops = append(ops, textOp{x: 240, y: y, size: 9, text: clip(s.examName, 9, false, 170)})
		right(y, 9, false, mark)
		ops = append(ops, textOp{x: pageW - margin - 60, y: y, size: 9, text: grade})
		y -= 15
	}

	y -= 4
	ops = append(ops, lineOp{x1: margin, y1: y, x2: pageW - margin, y2: y})
	y -= 18
	right(y, 10, true, "TOTAL")
	right(y, 10, true, fmt.Sprintf("%s / %s", fmtINR(obtained), fmtINR(total)))
	if total > 0 {
		y -= 16
		right(y, 10, true, fmt.Sprintf("PERCENTAGE: %.1f%%", obtained/total*100))
	}
	ops = append(ops, textOp{x: margin, y: margin + 8, size: 8,
		text: "Only published examinations are shown. This is a computer-generated report card."})
	return assemblePdf(ops)
}

func handleReportCardsBatch(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, claims *AssertionClaims) {
	var req batchRequest
	if err := readJSONBody(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON body { ids: string[] } is required"})
		return
	}
	branchID, ok := branchScope(claims)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "assertion has no branchId — report cards are branch-scoped"})
		return
	}

	conn, err := pool.Acquire(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer conn.Release()

	zw := zipWriter(w, "report-cards.zip")
	manifest := []string{}
	done := 0
	for _, id := range req.IDs {
		rc, subjects, lerr := loadReportCardData(conn, branchID, id)
		if lerr != nil {
			manifest = append(manifest, "SKIPPED: "+id+" — "+lerr.Error())
		} else if len(subjects) == 0 {
			manifest = append(manifest, "SKIPPED: "+id+" — no published results yet")
		} else {
			f, zerr := zw.Create(fmt.Sprintf("report-card-%s-%s.pdf", rc.admissionNo, rc.lastName))
			if zerr != nil {
				return
			}
			_, _ = f.Write(reportCardPdfBytes(rc, subjects))
		}
		done++
		if done%500 == 0 {
			log.Printf("report-cards: %d/%d rendered", done, len(req.IDs))
		}
	}
	if len(manifest) > 0 {
		f, zerr := zw.Create("MANIFEST.txt")
		if zerr != nil {
			return
		}
		_, _ = f.Write([]byte(strings.Join(manifest, "\n") + "\n"))
	}
	_ = zw.Close()
}
