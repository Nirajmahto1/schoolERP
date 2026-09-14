// ──────────────────────────────────────────────
// Marks import (BUILD_PLAN 6.3) — bulk exam-score upload.
//
// Format: one row per student. Required columns: admissionNo. Every other
// recognised column is a SUBJECT CODE holding that student's mark for the
// subject's exam paper in the named examination. This is how mark sheets
// arrive from schools: a grid of names down the side and subjects across
// the top, not a long-format table.
//
// Rules mirrored from exam-service's entry path:
//   • the examination must exist in the branch and must be in ENTRY or
//     SUBMITTED status — VERIFIED/PUBLISHED papers are frozen;
//   • marks must lie within 0..maxMarks for that exam subject;
//   • "AB" or "-" marks the student absent (isAbsent, mark NULL);
//   • grades are derived with the CBSE-style bands the demo seed uses;
//   • every change (insert OR update) writes a MarkEntryAudit row —
//     bulk entry is exactly when the "who changed what" question comes up.
// ──────────────────────────────────────────────

package main

import (
	"fmt"
	"strconv"
	"strings"
)

var marksAliases = map[string]string{
	"admissionno": "admissionNo", "admission no": "admissionNo", "admno": "admissionNo",
}

// gradeBands mirror packages/domain demo-seed (CBSE-style bands).
var gradeBands = []struct {
	grade       string
	min, max    float64
}{
	{"A1", 91, 100}, {"A2", 81, 90}, {"B1", 71, 80}, {"B2", 61, 70},
	{"C1", 51, 60}, {"C2", 41, 50}, {"D", 33, 40}, {"E", 0, 32},
}

func gradeFor(pct float64) string {
	for _, b := range gradeBands {
		if pct >= b.min && pct <= b.max {
			return b.grade
		}
	}
	return "E"
}

type marksRow struct {
	admissionNo string
	marks       map[string]string // subject code → raw cell
}

type marksSubjectInfo struct {
	subjectID string
	examSubID string
	maxMarks  float64
	name      string
}

type marksContext struct {
	examID    string
	examName  string
	status    string
	students  map[string]string       // admissionNoUpper → studentId
	subjects  map[string]marksSubjectInfo // subject code (upper) → info
}

// loadMarksContext resolves the examination, its exam subjects, and the
// branch's students in three roundtrips.
func loadMarksContext(t queryer, branchID, examID string) (*marksContext, error) {
	mc := &marksContext{
		students: map[string]string{},
		subjects: map[string]marksSubjectInfo{},
	}
	err := t.QueryRow(ctx2(), `
		SELECT "id", "name", "status"::text FROM "examinations"
		WHERE "id" = $1 AND "branchId" = $2`, examID, branchID).
		Scan(&mc.examID, &mc.examName, &mc.status)
	if err != nil {
		return nil, fmt.Errorf("examination not found in this branch")
	}
	if mc.status != "ENTRY" && mc.status != "SUBMITTED" {
		return nil, fmt.Errorf("examination is %s — marks can only be imported while ENTRY or SUBMITTED", mc.status)
	}

	rows, err := t.Query(ctx2(), `
		SELECT es."id", es."subjectId", es."maxMarks", s."code"
		FROM "exam_subjects" es JOIN "subjects" s ON s."id" = es."subjectId"
		WHERE es."examinationId" = $1`, examID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var info marksSubjectInfo
		var code string
		if err := rows.Scan(&info.examSubID, &info.subjectID, &info.maxMarks, &code); err != nil {
			rows.Close()
			return nil, err
		}
		info.name = code
		mc.subjects[strings.ToUpper(strings.TrimSpace(code))] = info
	}
	rows.Close()
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	if len(mc.subjects) == 0 {
		return nil, fmt.Errorf("examination has no exam subjects — define papers before importing marks")
	}

	rows2, err := t.Query(ctx2(), `
		SELECT upper("admissionNo"), "id" FROM "students"
		WHERE "branchId" = $1 AND "deletedAt" IS NULL`, branchID)
	if err != nil {
		return nil, err
	}
	for rows2.Next() {
		var no, id string
		if err := rows2.Scan(&no, &id); err != nil {
			rows2.Close()
			return nil, err
		}
		mc.students[no] = id
	}
	rows2.Close()
	return mc, rows2.Err()
}

// parseMarksRow converts one spreadsheet row: admissionNo from its canonical
// column, every other non-empty column treated as a SUBJECT CODE holding
// that student's mark for this examination (the grid layout mark sheets
// actually arrive in).
func parseMarksRow(m map[string]string, rowNo int) marksRow {
	r := marksRow{admissionNo: strings.ToUpper(strings.TrimSpace(m["admissionNo"])), marks: map[string]string{}}
	for k, v := range m {
		if k == "admissionNo" || v == "" {
			continue
		}
		r.marks[strings.ToUpper(strings.TrimSpace(k))] = v
	}
	return r
}

type marksReport struct {
	Row         int        `json:"row"`
	AdmissionNo string     `json:"admissionNo,omitempty"`
	OK          bool       `json:"ok"`
	Errors      []rowError `json:"errors"`
}

// validateMarksRow checks one parsed row against the context. Kept separate
// from parse so the dry-run report can be produced without any writes.
func validateMarksRow(mc *marksContext, r marksRow, rep *marksReport) {
	if r.admissionNo == "" {
		rep.OK = false
		rep.Errors = append(rep.Errors, rowError{Field: "admissionNo", Message: "admissionNo is required"})
		return
	}
	if _, ok := mc.students[strings.ToUpper(r.admissionNo)]; !ok {
		rep.OK = false
		rep.Errors = append(rep.Errors, rowError{
			Field: "admissionNo", Message: fmt.Sprintf("No student with admission number %q in this branch.", r.admissionNo)})
		return
	}
	for code, raw := range r.marks {
		info, ok := mc.subjects[code]
		if !ok {
			// Blank cells in unknown columns are formatting noise — a sheet
			// pasted with extra columns — and are skipped; a non-blank value
			// under an unknown code is a real error (typo'd subject).
			if strings.TrimSpace(raw) == "" {
				continue
			}
			rep.OK = false
			rep.Errors = append(rep.Errors, rowError{
				Field: code, Message: fmt.Sprintf("Subject %q is not a paper of this examination.", code)})
			continue
		}
		if raw == "" {
			continue // blank = not entered; never overwrites
		}
		up := strings.ToUpper(strings.TrimSpace(raw))
		if up == "AB" || up == "-" {
			continue // absent marker — valid
		}
		mark, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil {
			rep.OK = false
			rep.Errors = append(rep.Errors, rowError{
				Field: code, Message: fmt.Sprintf("Mark %q is not a number (use AB for absent).", raw)})
			continue
		}
		if mark < 0 || mark > info.maxMarks {
			rep.OK = false
			rep.Errors = append(rep.Errors, rowError{
				Field: code, Message: fmt.Sprintf("Mark %.2f is outside 0..%s's max of %.0f.", mark, info.name, info.maxMarks)})
		}
	}
	if len(r.marks) == 0 {
		rep.OK = false
		rep.Errors = append(rep.Errors, rowError{Message: "No subject columns found in this row."})
	}
}

// commitMarksRow upserts each entered mark: insert, or update-with-audit
// when the value changed. exam_results is unique on (examSubjectId,
// studentId); the audit trail records before → after for every change.
func commitMarksRow(t execer, mc *marksContext, r marksRow, changedBy string) (written int, err error) {
	studentID := mc.students[strings.ToUpper(r.admissionNo)]
	for code, raw := range r.marks {
		info, ok := mc.subjects[code]
		if !ok || strings.TrimSpace(raw) == "" {
			continue
		}
		up := strings.ToUpper(strings.TrimSpace(raw))
		var marks *float64
		absent := false
		if up == "AB" || up == "-" {
			absent = true
		} else {
			v, _ := strconv.ParseFloat(strings.TrimSpace(raw), 64)
			marks = &v
		}

		// marksObtained is NOT NULL in the schema; absent students store 0
		// with isAbsent=true (the exam-service entry contract — §3.6), so the
		// bulk path writes exactly what the single-entry path writes.
		markCol := 0.0
		if marks != nil {
			markCol = *marks
		}
		var grade *string
		if marks != nil {
			g := gradeFor(*marks / info.maxMarks * 100)
			grade = &g
		}

		var existingID string
		var before *string // "marksObtained"::text — nil when the column is NULL
		err := t.QueryRow(ctx2(), `
			SELECT "id", "marksObtained"::text FROM "exam_results"
			WHERE "examSubjectId" = $1 AND "studentId" = $2`,
			info.examSubID, studentID).Scan(&existingID, &before)
		hasExisting := err == nil
		if err != nil && !strings.Contains(err.Error(), "no rows") {
			return written, err
		}

		if !hasExisting {
			if _, err := t.Exec(ctx2(), `
				INSERT INTO "exam_results"
					("id", "examSubjectId", "studentId", "marksObtained", "grade", "isAbsent", "enteredBy", "createdAt", "updatedAt")
				VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now(), now())`,
				info.examSubID, studentID, markCol, grade, absent, changedBy); err != nil {
				return written, err
			}
			written++
			continue
		}

		// Existing: only write (and audit) when the value actually changed.
		// `before` is "marksObtained"::text — NULL scans into a nil pointer,
		// a number scans into the string form.
		var beforeF *float64
		if before != nil && *before != "" {
			if v, perr := strconv.ParseFloat(*before, 64); perr == nil {
				beforeF = &v
			}
		}
		same := false
		if absent {
			// absent → absent (stored as marks 0 + isAbsent) is a no-op
			var wasAbsent bool
			if err := t.QueryRow(ctx2(), `SELECT "isAbsent" FROM "exam_results" WHERE "id" = $1`, existingID).Scan(&wasAbsent); err == nil && wasAbsent && beforeF != nil && *beforeF == 0 {
				same = true
			}
		} else if marks != nil && beforeF != nil && *beforeF == *marks {
			same = true
		}
		if same {
			continue
		}

		if _, err := t.Exec(ctx2(), `
			UPDATE "exam_results"
			SET "marksObtained" = $2, "grade" = $3, "isAbsent" = $4, "enteredBy" = $5, "updatedAt" = now()
			WHERE "id" = $1`,
			existingID, markCol, grade, absent, changedBy); err != nil {
			return written, err
		}
		if _, err := t.Exec(ctx2(), `
			INSERT INTO "mark_entry_audits" ("id", "examResultId", "beforeMarks", "afterMarks", "changedBy", "createdAt")
			VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())`,
			existingID, beforeF, markCol, changedBy); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}
