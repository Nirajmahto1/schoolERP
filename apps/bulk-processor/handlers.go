// ──────────────────────────────────────────────
// Import route handlers (BUILD_PLAN 6.3)
//
// One endpoint per import kind, two modes over it (dry-run | commit) — the
// 3.2 contract. The request carries the worksheet; the parser streams it
// row-by-row; dry-run validates every row and returns the report without
// writing; commit runs per-row transactions (one bad row never blocks the
// rest) and reports created/updated/skipped counts.
// ──────────────────────────────────────────────

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type importResponse struct {
	Mode   string        `json:"mode"`
	Total  int           `json:"total"`
	OK     int           `json:"ok"`
	Failed int           `json:"failed"`
	Errors []rowReport   `json:"errors,omitempty"`
	Committed *committed `json:"committed,omitempty"`
}

type committed struct {
	Created int `json:"created"`
	Updated int `json:"updated"`
	Skipped int `json:"skipped"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func mustRead(rc io.ReadCloser) []byte {
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		return nil
	}
	return b
}

// tallyReports counts ok/failed across the final report state.
func tallyReports(reports []rowReport) (ok, failed int) {
	for i := range reports {
		if reports[i].OK {
			ok++
		} else {
			failed++
		}
	}
	return ok, failed
}

// failingReports returns only the failed rows (the admin fixes these; the
// passing thousands stay out of the response).
func failingReports(reports []rowReport) []rowReport {
	out := []rowReport{}
	for i := range reports {
		if !reports[i].OK {
			out = append(out, reports[i])
		}
	}
	return out
}

func modeOf(fields map[string]string) (string, bool) {
	mode := fields["mode"]
	if mode == "" {
		mode = "dry-run" // safe default: never write unless asked
	}
	if mode != "dry-run" && mode != "commit" {
		return "", false
	}
	return mode, true
}

// branchScope extracts the branch the assertion is entitled to write to.
func branchScope(claims *AssertionClaims) (string, bool) {
	if claims == nil || claims.BranchID == "" {
		return "", false
	}
	return claims.BranchID, true
}

// ── Student import ─────────────────────────────

func handleStudentImport(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, claims *AssertionClaims, reporter *progressReporter) {
	file, name, fields, cleanup, err := uploadForm(r, 8<<20)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid upload: %v", err)})
		return
	}
	defer cleanup()

	branchID, ok := branchScope(claims)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "assertion has no branchId — imports are branch-scoped"})
		return
	}
	mode, ok := modeOf(fields)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mode must be dry-run or commit"})
		return
	}

	// Branch lookups (current-year classes/sections + existing admission
	// numbers) load once; row parsing never touches the database.
	var lk *studentLookup
	if err := tx(r.Context(), pool, func(t pgx.Tx) error {
		var e error
		lk, e = loadStudentLookup(t, branchID)
		return e
	}); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}

	jobID := newJobID("students")
	rows := []studentRow{}
	reports := []rowReport{}

	// Stream: the parser yields one row at a time; nothing here holds the
	// whole worksheet twice.
	if err := readTabularFile(name, mustRead(file), studentAliases, func(m map[string]string, rowNo int) error {
		row, rep := parseStudentRow(m, rowNo)
		rows = append(rows, row)
		reports = append(reports, rep)
		return nil
	}); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("could not read %q: %v", name, err)})
		return
	}
	if len(rows) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "the file contains no data rows"})
		return
	}

	validateStudentRows(lk, rows, reports)
	okCount, failCount := tallyReports(reports)

	if mode == "dry-run" {
		writeJSON(w, http.StatusOK, importResponse{
			Mode: mode, Total: len(reports), OK: okCount, Failed: failCount,
			Errors: failingReports(reports),
		})
		return
	}

	// Commit: per-row transactions. One bad row is recorded and skipped —
	// never blocks the rest — and progress pushes keep the console alive.
	comm := committed{}
	reporter.report(claims, jobID, "starting", 0, len(rows), failCount)
	for i := range rows {
		if !reports[i].OK {
			comm.Skipped++
			reporter.report(claims, jobID, "committing", i+1, len(rows), failCount)
			continue
		}
		action := "skipped"
		if err := tx(r.Context(), pool, func(t pgx.Tx) error {
			var e error
			_, action, e = commitStudentRow(t, branchID, lk.currentYear, claims.Subject, rows[i])
			return e
		}); err != nil {
			reports[i].OK = false
			reports[i].Errors = append(reports[i].Errors, rowError{Message: err.Error()})
			failCount++
		} else {
			switch action {
			case "created":
				comm.Created++
			case "updated":
				comm.Updated++
			default:
				comm.Skipped++
			}
		}
		reporter.report(claims, jobID, "committing", i+1, len(rows), failCount)
	}

	writeJSON(w, http.StatusOK, importResponse{
		Mode: mode, Total: len(reports), OK: okCount, Failed: failCount,
		Errors: failingReports(reports), Committed: &comm,
	})
}

// ── Marks import ───────────────────────────────

func handleMarksImport(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, claims *AssertionClaims, reporter *progressReporter) {
	file, name, fields, cleanup, err := uploadForm(r, 8<<20)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid upload: %v", err)})
		return
	}
	defer cleanup()

	branchID, ok := branchScope(claims)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "assertion has no branchId — imports are branch-scoped"})
		return
	}
	examID := fields["examId"]
	if examID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "examId form field is required"})
		return
	}
	mode, ok := modeOf(fields)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mode must be dry-run or commit"})
		return
	}

	// The context resolves the examination, its papers, and the branch's
	// students up front; rows are then pure validation against it.
	var mc *marksContext
	if err := tx(r.Context(), pool, func(t pgx.Tx) error {
		var e error
		mc, e = loadMarksContext(t, branchID, examID)
		return e
	}); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}

	jobID := newJobID("marks")
	rows := []marksRow{}
	reports := []marksReport{}

	if err := readTabularFile(name, mustRead(file), marksAliases, func(m map[string]string, rowNo int) error {
		row := parseMarksRow(m, rowNo)
		rows = append(rows, row)
		reports = append(reports, marksReport{Row: rowNo, AdmissionNo: row.admissionNo, OK: true})
		return nil
	}); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("could not read %q: %v", name, err)})
		return
	}
	if len(rows) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "the file contains no data rows"})
		return
	}

	for i := range rows {
		validateMarksRow(mc, rows[i], &reports[i])
	}
	okCount, failCount := tallyMarksReports(reports)

	if mode == "dry-run" {
		writeJSON(w, http.StatusOK, importResponse{
			Mode: mode, Total: len(reports), OK: okCount, Failed: failCount,
			Errors: failingMarksReports(reports),
		})
		return
	}

	comm := committed{}
	reporter.report(claims, jobID, "starting", 0, len(rows), failCount)
	for i := range rows {
		if !reports[i].OK {
			comm.Skipped++
			reporter.report(claims, jobID, "committing", i+1, len(rows), failCount)
			continue
		}
		written := 0
		if err := tx(r.Context(), pool, func(t pgx.Tx) error {
			var e error
			written, e = commitMarksRow(t, mc, rows[i], claims.Subject)
			return e
		}); err != nil {
			reports[i].OK = false
			reports[i].Errors = append(reports[i].Errors, rowError{Message: err.Error()})
			failCount++
		} else if written > 0 {
			comm.Updated += written // marks are upserts; count writes as updates
		} else {
			comm.Skipped++ // row valid but every mark already identical
		}
		reporter.report(claims, jobID, "committing", i+1, len(rows), failCount)
	}

	writeJSON(w, http.StatusOK, importResponse{
		Mode: mode, Total: len(reports), OK: okCount, Failed: failCount,
		Errors: failingMarksReports(reports), Committed: &comm,
	})
}

func tallyMarksReports(reports []marksReport) (ok, failed int) {
	for i := range reports {
		if reports[i].OK {
			ok++
		} else {
			failed++
		}
	}
	return ok, failed
}

func failingMarksReports(reports []marksReport) []rowReport {
	out := []rowReport{}
	for i := range reports {
		if !reports[i].OK {
			out = append(out, rowReport{Row: reports[i].Row, AdmissionNo: reports[i].AdmissionNo, OK: false, Errors: reports[i].Errors})
		}
	}
	return out
}
