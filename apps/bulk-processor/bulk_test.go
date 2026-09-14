// ──────────────────────────────────────────────
// Bulk processor tests (BUILD_PLAN 6.3)
//
// The pieces that can break silently get tests: the streaming XLSX reader
// (hand-built zips, since the reader is hand-built), row validation parity
// with the Node importer, grade banding, INR grouping, and the PDF writer
// producing structurally valid bytes.
// ──────────────────────────────────────────────

package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strings"
	"testing"
)

// buildXLSX assembles a minimal single-sheet workbook in memory: shared
// strings + one worksheet with the given rows. This is the fixture the
// streaming reader is tested against — no third-party xlsx writer, because
// asserting against a hand-built format is exactly the point.
func buildXLSX(t *testing.T, rows [][]string) []byte {
	t.Helper()
	shared := []string{}
	rowXML := &strings.Builder{}
	rowNo := 0
	for _, row := range rows {
		rowNo++
		rowXML.WriteString(fmt.Sprintf(`<row r="%d">`, rowNo))
		for col, cell := range row {
			idx := len(shared)
			shared = append(shared, cell)
			ref := fmt.Sprintf("%c%d", 'A'+col, rowNo)
			rowXML.WriteString(fmt.Sprintf(`<c r="%s" t="s"><v>%d</v></c>`, ref, idx))
		}
		rowXML.WriteString(`</row>`)
	}
	ssXML := &strings.Builder{}
	for _, s := range shared {
		ssXML.WriteString(fmt.Sprintf(`<si><t>%s</t></si>`, s))
	}
	sheet := `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
		rowXML.String() + `</sheetData></worksheet>`

	buf := &bytes.Buffer{}
	zw := zip.NewWriter(buf)
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
		"xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` + ssXML.String() + `</sst>`,
		"xl/worksheets/sheet1.xml": sheet,
	}
	for name, content := range files {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte(content))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestXLSXStreamingParse(t *testing.T) {
	data := buildXLSX(t, [][]string{
		{"Admission No", "First Name", "Class", "Section", "Date of Birth"},
		{"ADM-001", "Aarav", "5", "A", "2015-04-12"},
		{"", "", "", "", ""}, // blank row must be skipped, not shift parsing
		{"ADM-002", "Diya", "5", "B", "12/04/2015"},
	})
	got := []map[string]string{}
	err := readTabularFile("students.xlsx", data, studentAliases, func(m map[string]string, rowNo int) error {
		got = append(got, m)
		return nil
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 data rows, got %d: %+v", len(got), got)
	}
	if got[0]["admissionNo"] != "ADM-001" || got[0]["firstName"] != "Aarav" {
		t.Errorf("row 1 mis-parsed: %+v", got[0])
	}
	if got[1]["admissionNo"] != "ADM-002" || got[1]["dateOfBirth"] != "12/04/2015" {
		t.Errorf("row 3 mis-parsed (blank-row skip broken): %+v", got[1])
	}
}

func TestXLSXAliasesAndCase(t *testing.T) {
	data := buildXLSX(t, [][]string{
		{"ADM NO", "FIRST NAME", "Gender", "Parent Phone"},
		{"ADM-9", "Kid", "m", "98765 43210"},
	})
	got := []map[string]string{}
	_ = readTabularFile("x.xlsx", data, studentAliases, func(m map[string]string, _ int) error {
		got = append(got, m)
		return nil
	})
	if got[0]["admissionNo"] != "ADM-9" || got[0]["firstName"] != "Kid" ||
		got[0]["gender"] != "m" || got[0]["guardianPhone"] != "98765 43210" {
		t.Errorf("alias mapping broken: %+v", got[0])
	}
}

func TestParseStudentRowValidation(t *testing.T) {
	good := map[string]string{
		"admissionNo": "ADM-1", "firstName": "Aarav", "lastName": "Sharma",
		"dateOfBirth": "2015-04-12", "gender": "M", "class": "5", "section": "A",
		"guardianName": "R Sharma", "guardianPhone": "+91 9876543210",
	}
	row, rep := parseStudentRow(good, 2)
	if !rep.OK {
		t.Fatalf("valid row rejected: %+v", rep.Errors)
	}
	if row.gender != "MALE" {
		t.Errorf("gender normalisation broken: %q", row.gender)
	}

	// Every required field missing at once → every field named.
	_, rep = parseStudentRow(map[string]string{}, 3)
	if rep.OK {
		t.Fatal("empty row passed validation")
	}
	fields := map[string]bool{}
	for _, e := range rep.Errors {
		fields[e.Field] = true
	}
	for _, want := range []string{"admissionNo", "firstName", "lastName", "dateOfBirth", "gender", "class", "section", "guardianName", "guardianPhone"} {
		if !fields[want] {
			t.Errorf("missing field %q not reported: %+v", want, rep.Errors)
		}
	}

	// Bad phone, future DOB, bad gender.
	_, rep = parseStudentRow(map[string]string{
		"admissionNo": "ADM-2", "firstName": "x", "lastName": "y",
		"dateOfBirth": "2099-01-01", "gender": "X", "class": "1", "section": "A",
		"guardianName": "g", "guardianPhone": "not-a-phone",
	}, 4)
	if rep.OK {
		t.Fatal("invalid row passed validation")
	}
	msgs := []string{}
	for _, e := range rep.Errors {
		msgs = append(msgs, e.Message)
	}
	joined := strings.Join(msgs, "; ")
	if !strings.Contains(joined, "phone") || !strings.Contains(joined, "future") || !strings.Contains(joined, "MALE, FEMALE or OTHER") {
		t.Errorf("expected phone/future-DOB/gender errors, got: %s", joined)
	}
}

func TestParseFlexibleDate(t *testing.T) {
	cases := map[string]string{
		"2015-04-12": "2015-04-12",
		"12/04/2015": "2015-04-12", // DD/MM is the Indian default
		"2015/04/12": "2015-04-12",
		"12-04-2015": "2015-04-12",
		"45000":      "2023-03-15", // Excel OADate serial
	}
	for in, want := range cases {
		got, err := parseFlexibleDate(in)
		if err != nil {
			t.Errorf("%q: %v", in, err)
			continue
		}
		if got.Format("2006-01-02") != want {
			t.Errorf("%q → %s, want %s", in, got.Format("2006-01-02"), want)
		}
	}
	if _, err := parseFlexibleDate("not a date"); err == nil {
		t.Error("garbage accepted as date")
	}
}

func TestDuplicateAdmissionDetection(t *testing.T) {
	r1, rep1 := parseStudentRow(map[string]string{
		"admissionNo": "DUP-1", "firstName": "a", "lastName": "a", "dateOfBirth": "2015-01-01",
		"gender": "F", "class": "1", "section": "A", "guardianName": "g", "guardianPhone": "12345",
	}, 2)
	r2, rep2 := parseStudentRow(map[string]string{
		"admissionNo": "dup-1", "firstName": "b", "lastName": "b", "dateOfBirth": "2015-01-01",
		"gender": "F", "class": "1", "section": "A", "guardianName": "g", "guardianPhone": "12345",
	}, 3)
	lk := &studentLookup{classes: map[string]map[string]bool{"1": {"a": true}}}
	reps := []rowReport{rep1, rep2}
	validateStudentRows(lk, []studentRow{r1, r2}, reps)
	if !reps[0].OK {
		t.Errorf("first occurrence flagged: %+v", reps[0].Errors)
	}
	if reps[1].OK {
		t.Fatal("duplicate admission number not caught")
	}
	found := false
	for _, e := range reps[1].Errors {
		if strings.Contains(e.Message, "Duplicate admission number") {
			found = true
		}
	}
	if !found {
		t.Errorf("wrong message: %+v", reps[1].Errors)
	}
}

func TestGradeBands(t *testing.T) {
	cases := map[float64]string{
		95: "A1", 91: "A1", 90: "A2", 85: "A2", 81: "A2", 80: "B1",
		71: "B1", 61: "B2", 51: "C1", 41: "C2", 33: "D", 32: "E", 0: "E",
	}
	for pct, want := range cases {
		if got := gradeFor(pct); got != want {
			t.Errorf("gradeFor(%v) = %s, want %s", pct, got, want)
		}
	}
}

func TestValidateMarksRow(t *testing.T) {
	mc := &marksContext{
		students: map[string]string{"ADM-1": "stu_1"},
		subjects: map[string]marksSubjectInfo{
			"MATH": {subjectID: "s1", examSubID: "es1", maxMarks: 100, name: "MATH"},
			"SCI":  {subjectID: "s2", examSubID: "es2", maxMarks: 50, name: "SCI"},
		},
	}

	// Happy path incl. absent markers, blanks, and a blank unknown column
	// (formatting noise from pasted sheets).
	rep := marksReport{Row: 2, OK: true}
	validateMarksRow(mc, marksRow{admissionNo: "adm-1", marks: map[string]string{
		"MATH": "92", "SCI": "AB", "ENG": "", // ENG not a paper, but blank → skipped
	}}, &rep)
	if !rep.OK {
		t.Errorf("valid marks row rejected: %+v", rep.Errors)
	}

	// Unknown student: validateMarksRow stops at the first fatal error.
	rep = marksReport{Row: 3, OK: true}
	validateMarksRow(mc, marksRow{admissionNo: "GHOST", marks: map[string]string{"MATH": "101"}}, &rep)
	if rep.OK || !strings.Contains(rep.Errors[0].Message, "No student with admission number") {
		t.Errorf("unknown student not flagged: %+v", rep.Errors)
	}

	// Out-of-range + non-numeric on a real student.
	rep = marksReport{Row: 4, OK: true}
	validateMarksRow(mc, marksRow{admissionNo: "ADM-1", marks: map[string]string{
		"MATH": "101", "SCI": "abc",
	}}, &rep)
	if rep.OK {
		t.Fatal("invalid marks row accepted")
	}
	joined := []string{}
	for _, e := range rep.Errors {
		joined = append(joined, e.Message)
	}
	all := strings.Join(joined, "; ")
	for _, want := range []string{"outside 0..", "not a number"} {
		if !strings.Contains(all, want) {
			t.Errorf("expected %q in errors, got: %s", want, all)
		}
	}

	// A non-empty unknown column must be named.
	rep = marksReport{Row: 4, OK: true}
	validateMarksRow(mc, marksRow{admissionNo: "ADM-1", marks: map[string]string{"HINDI": "44"}}, &rep)
	if rep.OK || !strings.Contains(rep.Errors[0].Message, "not a paper") {
		t.Errorf("unknown subject not flagged: %+v", rep.Errors)
	}
}

func TestFmtINR(t *testing.T) {
	cases := map[float64]string{
		0: "0.00", 5: "5.00", 999.5: "999.50", 1000: "1,000.00",
		1234567.89: "12,34,567.89", // Indian grouping — not 1,234,567
		-2500:      "-2,500.00",
	}
	for in, want := range cases {
		if got := fmtINR(in); got != want {
			t.Errorf("fmtINR(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestAssemblePdfStructure(t *testing.T) {
	ops := []drawOp{
		textOp{x: 48, y: 794, size: 16, bold: true, text: "FEE RECEIPT — School (Name)"},
		textOp{x: 48, y: 770, size: 9, text: "Rupees ₹ 1,200.00 paid"}, // ₹ must transliterate, not corrupt
		lineOp{x1: 48, y1: 760, x2: 547, y2: 760},
		textOp{x: 48, y: 740, size: 9, text: "Parens (escaped) and back\\slash"},
	}
	pdf := assemblePdf(ops)
	s := string(pdf)
	if !strings.HasPrefix(s, "%PDF-1.4") {
		t.Error("missing PDF header")
	}
	if !strings.HasSuffix(s, "%%EOF\n") {
		t.Error("missing EOF marker")
	}
	if !strings.Contains(s, "/BaseFont /Helvetica-Bold") {
		t.Error("bold font object missing")
	}
	if !strings.Contains(s, "Rs.") {
		t.Error("₹ transliteration missing")
	}
	if strings.Contains(s, "(Parens \\(escaped\\)") == false {
		t.Error("parens not escaped")
	}
	// xref offsets must point at "N 0 obj" — spot-check object 1.
	xrefAt := strings.Index(s, "xref")
	if xrefAt < 0 {
		t.Fatal("no xref")
	}
	// lines: [xref, "0 N", free-entry, obj1, obj2, ...] — check object 1.
	lines := strings.Split(s[xrefAt:], "\n")
	if len(lines) < 4 {
		t.Fatal("xref too short")
	}
	var off int
	if _, err := fmt.Sscanf(lines[3], "%010d", &off); err != nil {
		t.Fatalf("bad xref entry: %q", lines[3])
	}
	if !strings.HasPrefix(s[off:], "1 0 obj") {
		t.Errorf("xref offset 1 points at %q", s[off:off+20])
	}
}

func TestReceiptPdfRendering(t *testing.T) {
	r := receiptRowQ{
		id: "pay_1", receiptNo: strPtr("RCPT-2026-0001"), amount: 12500,
		method: "UPI", branchName: strPtr("Main Campus"),
		branchAddr: strPtr("MG Road"), firstName: strPtr("Aarav"),
		lastName: strPtr("Sharma"), admissionNo: strPtr("ADM-1"),
	}
	pdf := receiptPdfBytes(nil, r) // nil queryer: allocations fall back to the single-line form
	s := string(pdf)
	if !strings.Contains(s, "RCPT-2026-0001") || !strings.Contains(s, "Main Campus") {
		t.Error("receipt content missing")
	}
	if !strings.Contains(s, "12,500.00") {
		t.Error("Indian grouping missing in receipt total")
	}
	if !strings.HasPrefix(s, "%PDF-1.4") {
		t.Error("not a PDF")
	}
}

func TestReportCardPdfRendering(t *testing.T) {
	rc := &reportCardQ{
		studentID: "s1", admissionNo: "ADM-1", firstName: "Aarav", lastName: "Sharma",
		className: "Class 8", sectionName: "A",
	}
	mark, grade := 92.0, "A1"
	subjects := []rcSubjectRow{
		{subject: "Mathematics", examName: "Term 1", maxMarks: 100, marks: &mark, grade: &grade},
		{subject: "Science", examName: "Term 1", maxMarks: 100, isAbsent: true},
	}
	pdf := reportCardPdfBytes(rc, subjects)
	s := string(pdf)
	for _, want := range []string{"STUDENT REPORT CARD", "Mathematics", "Term 1", "92/100", "AB", "A1", "Only published examinations are shown"} {
		if !strings.Contains(s, want) {
			t.Errorf("report card missing %q", want)
		}
	}
}

func strPtr(s string) *string { return &s }
