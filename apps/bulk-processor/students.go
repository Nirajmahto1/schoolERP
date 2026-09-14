// ──────────────────────────────────────────────
// Student import (BUILD_PLAN 6.3) — the streaming twin of student-service's
// 3.2 import. Column aliases, validation rules, report shapes, and the
// commit semantics (upsert on branchId+admissionNo, enrollment repair,
// guardian create-once) are mirrored deliberately: the Node path stays for
// small files, this path exists so a 20k-row admission day cannot OOM the
// service.
//
// Rows are processed independently — one bad row never blocks the others —
// and commit is idempotent on (branchId, admissionNo): re-running an import
// after fixing one row does not duplicate the others.
// ──────────────────────────────────────────────

package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// header aliases → canonical keys (identical to the Node importer's table).
var studentAliases = map[string]string{
	"admissionno": "admissionNo", "admission no": "admissionNo", "admission_no": "admissionNo", "admno": "admissionNo", "adm no": "admissionNo",
	"firstname": "firstName", "first name": "firstName", "first_name": "firstName",
	"lastname": "lastName", "last name": "lastName", "last_name": "lastName",
	"dateofbirth": "dateOfBirth", "date of birth": "dateOfBirth", "dob": "dateOfBirth",
	"gender": "gender", "sex": "gender",
	"class": "class", "grade": "class",
	"section": "section", "sec": "section",
	"guardianname": "guardianName", "guardian name": "guardianName", "parentname": "guardianName", "parent name": "guardianName",
	"guardianphone": "guardianPhone", "guardian phone": "guardianPhone", "parentphone": "guardianPhone", "parent phone": "guardianPhone", "mobile": "guardianPhone",
	"rollno": "rollNo", "roll no": "rollNo", "roll": "rollNo",
	"bloodgroup": "bloodGroup", "blood group": "bloodGroup",
	"address": "address",
	"previousschool": "previousSchool", "previous school": "previousSchool",
	"guardianemail": "guardianEmail", "guardian email": "guardianEmail",
	"phone": "phone", "email": "guardianEmail",
}

var phoneRe = regexp.MustCompile(`^[0-9+\- ()]{5,20}$`)

type rowError struct {
	Field   string `json:"field,omitempty"`
	Message string `json:"message"`
}

type rowReport struct {
	Row         int        `json:"row"`
	AdmissionNo string     `json:"admissionNo,omitempty"`
	OK          bool       `json:"ok"`
	Errors      []rowError `json:"errors"`
}

type studentRow struct {
	admissionNo, firstName, lastName, gender                      string
	dob                                                           time.Time
	class, section, guardianName, guardianPhone                   string
	rollNo, bloodGroup, address, phone, prevSchool, guardianEmail string
}

var genderMap = map[string]string{"MALE": "MALE", "FEMALE": "FEMALE", "OTHER": "OTHER", "M": "MALE", "F": "FEMALE"}

// parseStudentRow converts one spreadsheet row into a typed row + report.
// All row-local checks (shape, lengths, formats) happen here; cross-row and
// database checks happen in the validate phase.
func parseStudentRow(m map[string]string, rowNo int) (studentRow, rowReport) {
	rep := rowReport{Row: rowNo, AdmissionNo: m["admissionNo"], OK: true}
	fail := func(field, msg string) {
		rep.OK = false
		rep.Errors = append(rep.Errors, rowError{Field: field, Message: msg})
	}

	r := studentRow{
		admissionNo: m["admissionNo"], firstName: m["firstName"], lastName: m["lastName"],
		gender: strings.ToUpper(strings.TrimSpace(m["gender"])),
		class:  m["class"], section: m["section"],
		guardianName: m["guardianName"], guardianPhone: m["guardianPhone"],
		rollNo: m["rollNo"], bloodGroup: m["bloodGroup"], address: m["address"],
		phone: m["phone"], prevSchool: m["previousSchool"], guardianEmail: m["guardianEmail"],
	}

	if r.admissionNo == "" {
		fail("admissionNo", "admissionNo is required")
	} else if len(r.admissionNo) > 40 {
		fail("admissionNo", "admissionNo must be at most 40 characters")
	}
	if r.firstName == "" {
		fail("firstName", "firstName is required")
	} else if len(r.firstName) > 60 {
		fail("firstName", "firstName must be at most 60 characters")
	}
	if r.lastName == "" {
		fail("lastName", "lastName is required")
	} else if len(r.lastName) > 60 {
		fail("lastName", "lastName must be at most 60 characters")
	}

	dobStr := m["dateOfBirth"]
	if dobStr == "" {
		fail("dateOfBirth", "dateOfBirth is required")
	} else if d, err := parseFlexibleDate(dobStr); err != nil {
		fail("dateOfBirth", fmt.Sprintf("dateOfBirth %q is not a date (use YYYY-MM-DD or DD/MM/YYYY)", dobStr))
	} else {
		r.dob = d
		if r.dob.After(time.Now()) {
			fail("dateOfBirth", "dateOfBirth is in the future")
		}
	}

	if g, ok := genderMap[r.gender]; ok {
		r.gender = g
	} else {
		fail("gender", fmt.Sprintf("gender %q must be MALE, FEMALE or OTHER", m["gender"]))
	}
	if r.class == "" {
		fail("class", "class is required")
	}
	if r.section == "" {
		fail("section", "section is required")
	}
	if r.guardianName == "" {
		fail("guardianName", "guardianName is required")
	} else if len(r.guardianName) > 120 {
		fail("guardianName", "guardianName must be at most 120 characters")
	}
	if r.guardianPhone == "" {
		fail("guardianPhone", "guardianPhone is required")
	} else if !phoneRe.MatchString(r.guardianPhone) {
		fail("guardianPhone", fmt.Sprintf("guardianPhone %q does not look like a phone number", r.guardianPhone))
	}

	if r.rollNo != "" && len(r.rollNo) > 10 {
		fail("rollNo", "rollNo must be at most 10 characters")
	}
	if r.bloodGroup != "" && len(r.bloodGroup) > 10 {
		fail("bloodGroup", "bloodGroup must be at most 10 characters")
	}
	if r.address != "" && len(r.address) > 500 {
		fail("address", "address must be at most 500 characters")
	}
	if r.phone != "" && !phoneRe.MatchString(r.phone) {
		fail("phone", fmt.Sprintf("phone %q does not look like a phone number", r.phone))
	}
	if r.prevSchool != "" && len(r.prevSchool) > 200 {
		fail("previousSchool", "previousSchool must be at most 200 characters")
	}
	if r.guardianEmail != "" && len(r.guardianEmail) > 254 {
		fail("guardianEmail", "guardianEmail must be at most 254 characters")
	}
	return r, rep
}

// parseFlexibleDate accepts the formats school offices actually type:
// 2006-01-02, 02/01/2006 (DD/MM — the Indian default), and Excel's OADate
// serial numbers, which some tools emit as "45000.0" strings.
func parseFlexibleDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{"2006-01-02", "02/01/2006", "2006/01/02", "02-01-2006", "2/1/2006", "02/01/06"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	// Excel OADate serial (days since 1899-12-30).
	if serial, err := strconv.ParseFloat(s, 64); err == nil && serial > 20000 && serial < 80000 {
		return time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC).Add(time.Duration(serial * 24 * float64(time.Hour))), nil
	}
	return time.Time{}, fmt.Errorf("unparseable date %q", s)
}

// studentLookup loads current-year class→sections and the set of existing
// admission numbers in one roundtrip each — the streaming replacement for
// the Node importer's findMany-everything.
type studentLookup struct {
	classes     map[string]map[string]bool // classLower → set(sectionLower)
	existing    map[string]bool            // admissionNoUpper → exists
	currentYear string                     // academic year id
}

func loadStudentLookup(t queryer, branchID string) (*studentLookup, error) {
	lk := &studentLookup{classes: map[string]map[string]bool{}, existing: map[string]bool{}}
	err := t.QueryRow(ctx2(), `
		SELECT "id" FROM "academic_years" WHERE "branchId" = $1 AND "isCurrent" = true LIMIT 1`,
		branchID).Scan(&lk.currentYear)
	if err != nil {
		return nil, fmt.Errorf("branch has no current academic year — cannot import")
	}

	rows, err := t.Query(ctx2(), `
		SELECT lower(c."name"), lower(s."name")
		FROM "classes" c JOIN "sections" s ON s."classId" = c."id"
		WHERE c."branchId" = $1 AND c."academicYearId" = $2 AND c."deletedAt" IS NULL`,
		branchID, lk.currentYear)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var cls, sec string
		if err := rows.Scan(&cls, &sec); err != nil {
			rows.Close()
			return nil, err
		}
		if lk.classes[cls] == nil {
			lk.classes[cls] = map[string]bool{}
		}
		lk.classes[cls][sec] = true
	}
	rows.Close()
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	rows2, err := t.Query(ctx2(), `
		SELECT upper("admissionNo") FROM "students" WHERE "branchId" = $1 AND "deletedAt" IS NULL`,
		branchID)
	if err != nil {
		return nil, err
	}
	for rows2.Next() {
		var no string
		if err := rows2.Scan(&no); err != nil {
			rows2.Close()
			return nil, err
		}
		lk.existing[no] = true
	}
	rows2.Close()
	return lk, rows2.Err()
}

// validateStudentRows performs cross-row (duplicate admission numbers within
// the file) and database validation, mutating the reports in place — with
// messages byte-identical to the Node importer's.
func validateStudentRows(lk *studentLookup, rows []studentRow, reports []rowReport) {
	seen := map[string]int{}
	for i := range reports {
		if !reports[i].OK {
			continue
		}
		key := strings.ToUpper(strings.TrimSpace(rows[i].admissionNo))
		if first, dup := seen[key]; dup {
			reports[i].OK = false
			reports[i].Errors = append(reports[i].Errors, rowError{
				Field: "admissionNo", Message: fmt.Sprintf("Duplicate admission number in file (first seen on row %d).", first)})
		} else {
			seen[key] = reports[i].Row
		}
	}
	for i := range reports {
		if !reports[i].OK {
			continue
		}
		r := &rows[i]
		if lk.existing[strings.ToUpper(strings.TrimSpace(r.admissionNo))] {
			reports[i].Errors = append(reports[i].Errors, rowError{
				Message: "Existing student — will be UPDATED on commit."})
		}
		secSet, ok := lk.classes[strings.ToLower(strings.TrimSpace(r.class))]
		if !ok {
			reports[i].OK = false
			reports[i].Errors = append(reports[i].Errors, rowError{
				Field: "class", Message: fmt.Sprintf("Class %q not found for the current academic year.", r.class)})
			continue
		}
		if !secSet[strings.ToLower(strings.TrimSpace(r.section))] {
			reports[i].OK = false
			reports[i].Errors = append(reports[i].Errors, rowError{
				Field: "section", Message: fmt.Sprintf("Section %q not found in class %q.", r.section, r.class)})
		}
	}
}

// commitStudentRow upserts one student inside the caller's transaction:
// user → student → guardian → enrollment. Existing students get
// name/contact updates plus an enrollment repair if the current year has
// none — the exact Node semantics. Per-row transactions mean one bad row
// never blocks the others.
func commitStudentRow(t execer, branchID, yearID, userID string, r studentRow) (studentID string, action string, err error) {
	var existingID string
	err = t.QueryRow(ctx2(), `
		SELECT "id" FROM "students" WHERE "branchId" = $1 AND upper("admissionNo") = upper($2) AND "deletedAt" IS NULL`,
		branchID, r.admissionNo).Scan(&existingID)
	if err != nil && !strings.Contains(err.Error(), "no rows") {
		return "", "", err
	}

	if existingID != "" {
		if _, err := t.Exec(ctx2(), `
			UPDATE "students" SET "firstName" = $2, "lastName" = $3,
			       "bloodGroup" = nullif($4, ''), "phone" = nullif($5, ''),
			       "address" = coalesce(nullif($6, ''), "address")
			WHERE "id" = $1 AND "branchId" = $7`,
			existingID, r.firstName, r.lastName, r.bloodGroup, r.phone, r.address, branchID); err != nil {
			return "", "", err
		}
		// Enrollment repair for the current year.
		var n int
		if err := t.QueryRow(ctx2(), `
			SELECT count(*) FROM "student_enrollments"
			WHERE "studentId" = $1 AND "academicYearId" = $2`, existingID, yearID).Scan(&n); err != nil {
			return "", "", err
		}
		if n == 0 {
			cls, sec, err := classSectionIDs(t, branchID, yearID, r.class, r.section)
			if err != nil {
				return "", "", err
			}
			if _, err := t.Exec(ctx2(), `
				INSERT INTO "student_enrollments"
					("id", "studentId", "academicYearId", "branchId", "classId", "sectionId", "rollNo", "status", "fromDate", "createdBy", "createdAt", "updatedAt")
				VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, nullif($6, ''), 'ENROLLED', now(), $7, now(), now())`,
				existingID, yearID, branchID, cls, sec, r.rollNo, userID); err != nil {
				return "", "", err
			}
		}
		return existingID, "updated", nil
	}

	// New student: user → role → student → guardian → link → enrollment,
	// mirroring the Node importer's nested create.
	var uid string
	err = t.QueryRow(ctx2(), `
		INSERT INTO "users" ("id", "email", "passwordHash", "defaultBranchId", "createdAt", "updatedAt")
		VALUES (gen_random_uuid()::text, $1, '$2b$12$not-a-real-bcrypt-hash', $2, now(), now())
		RETURNING "id"`,
		fmt.Sprintf("%s-%s@student.school-erp.local", branchID, strings.ToLower(r.admissionNo)), branchID).Scan(&uid)
	if err != nil {
		return "", "", err
	}
	if _, err := t.Exec(ctx2(), `
		INSERT INTO "user_role_assignments" ("id", "userId", "roleId", "branchId", "createdAt")
		VALUES (gen_random_uuid()::text, $1, 'sys_student', $2, now())`, uid, branchID); err != nil {
		return "", "", err
	}
	err = t.QueryRow(ctx2(), `
		INSERT INTO "students"
			("id", "userId", "branchId", "admissionNo", "firstName", "lastName", "dateOfBirth", "gender",
			 "bloodGroup", "address", "phone", "previousSchool", "admissionDate", "isActive", "createdAt", "updatedAt")
		VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, nullif($8, ''), coalesce($9, ''),
		        nullif($10, ''), nullif($11, ''), now(), true, now(), now())
		RETURNING "id"`,
		uid, branchID, r.admissionNo, r.firstName, r.lastName, r.dob, r.gender,
		r.bloodGroup, r.address, r.phone, r.prevSchool).Scan(&studentID)
	if err != nil {
		return "", "", err
	}
	var gid string
	err = t.QueryRow(ctx2(), `
		INSERT INTO "guardians" ("id", "fullName", "phone", "email", "isActive", "createdAt", "updatedAt")
		VALUES (gen_random_uuid()::text, $1, $2, nullif($3, ''), true, now(), now())
		RETURNING "id"`,
		r.guardianName, r.guardianPhone, r.guardianEmail).Scan(&gid)
	if err != nil {
		return "", "", err
	}
	if _, err := t.Exec(ctx2(), `
		INSERT INTO "student_guardians" ("id", "studentId", "guardianId", "relation", "isPrimary", "canPickup", "receivesComms", "hasPortalAccess", "createdAt")
		VALUES (gen_random_uuid()::text, $1, $2, 'FATHER', true, false, true, true, now())`,
		studentID, gid); err != nil {
		return "", "", err
	}
	cls, sec, err := classSectionIDs(t, branchID, yearID, r.class, r.section)
	if err != nil {
		return "", "", err
	}
	if _, err := t.Exec(ctx2(), `
		INSERT INTO "student_enrollments"
			("id", "studentId", "academicYearId", "branchId", "classId", "sectionId", "rollNo", "status", "fromDate", "createdBy", "createdAt", "updatedAt")
		VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, nullif($6, ''), 'ENROLLED', now(), $7, now(), now())`,
		studentID, yearID, branchID, cls, sec, r.rollNo, userID); err != nil {
		return "", "", err
	}
	return studentID, "created", nil
}

// classSectionIDs resolves display class/section names to ids for the year.
func classSectionIDs(t queryer, branchID, yearID, class, section string) (string, string, error) {
	var clsID, secID string
	err := t.QueryRow(ctx2(), `
		SELECT c."id", s."id"
		FROM "classes" c JOIN "sections" s ON s."classId" = c."id"
		WHERE c."branchId" = $1 AND c."academicYearId" = $2
		  AND lower(c."name") = lower($3) AND lower(s."name") = lower($4)
		  AND c."deletedAt" IS NULL LIMIT 1`,
		branchID, yearID, strings.TrimSpace(class), strings.TrimSpace(section)).Scan(&clsID, &secID)
	if err != nil {
		return "", "", fmt.Errorf("class/section lookup failed")
	}
	return clsID, secID, nil
}
