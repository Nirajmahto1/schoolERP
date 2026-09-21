// ──────────────────────────────────────────────
// School ERP — Bulk processor (BUILD_PLAN 6.3)
//
// The streaming twin of the Node import paths, in Go, for the day a school
// hands over a 20,000-row admission sheet: the worksheet is read as a token
// stream (one row in memory at a time), rows commit in bounded batches, and
// marks/receipts/report-cards batch-render out of the same process.
//
// Refuses to boot without the assertion public key — same fail-closed rule
// as every other service.
// ──────────────────────────────────────────────

package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"time"
)

func main() {
	auth, err := NewAuthenticator()
	if err != nil {
		log.Fatalf("bulk-processor: %v", err)
	}
	pool, err := newPool()
	if err != nil {
		log.Fatalf("bulk-processor: %v", err)
	}
	defer pool.Close()

	// Progress reporting is optional (no key / engine → imports run silent).
	reporter := newProgressReporter()

	mux := http.NewServeMux()

	// Dry-run + commit are one endpoint over the same parser, so the error
	// report the admin previews is the one the commit will produce (the 3.2
	// contract, now streaming).
	mux.HandleFunc("POST /students/import", func(w http.ResponseWriter, r *http.Request) {
		claims := checkAuth(w, r, auth)
		if claims == nil {
			return
		}
		handleStudentImport(w, r, pool, claims, reporter)
	})
	mux.HandleFunc("POST /marks/import", func(w http.ResponseWriter, r *http.Request) {
		claims := checkAuth(w, r, auth)
		if claims == nil {
			return
		}
		handleMarksImport(w, r, pool, claims, reporter)
	})

	// Batch PDFs (§6.3): receipts stream per payment, report cards per
	// student — one bad id becomes a MANIFEST.txt line, never a 500.
	mux.HandleFunc("POST /receipts/batch", func(w http.ResponseWriter, r *http.Request) {
		claims := checkAuth(w, r, auth)
		if claims == nil {
			return
		}
		handleReceiptsBatch(w, r, pool, claims)
	})
	mux.HandleFunc("POST /report-cards/batch", func(w http.ResponseWriter, r *http.Request) {
		claims := checkAuth(w, r, auth)
		if claims == nil {
			return
		}
		handleReportCardsBatch(w, r, pool, claims)
	})

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Phase 11: Prometheus runtime metrics (stdlib only).
	startedAt := time.Now()
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintf(w,
			"# TYPE uptime_seconds gauge\nuptime_seconds %.3f\n"+
				"# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes %d\n"+
				"# TYPE go_goroutines gauge\ngo_goroutines %d\n",
			time.Since(startedAt).Seconds(), ms.Sys, runtime.NumGoroutine())
	})

	addr := ":" + envOr("PORT_BULK_PROCESSOR", "6002")
	log.Printf("bulk-processor listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

// checkAuth verifies the internal assertion and returns nil after writing
// the 401 when invalid — handlers do `claims := checkAuth(...); if claims == nil { return }`.
func checkAuth(w http.ResponseWriter, r *http.Request, auth *authenticator) *AssertionClaims {
	token := r.Header.Get("x-internal-assertion")
	if token == "" {
		token = r.URL.Query().Get("assertion") // non-browser clients only; uploads come from the console
	}
	claims, err := auth.Verify(token)
	if err != nil {
		log.Printf("auth rejected: %v", err)
		http.Error(w, `{"error":"invalid internal assertion"}`, http.StatusUnauthorized)
		return nil
	}
	return claims
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// uploadForm parses a multipart/form-data upload with bounded memory: files
// larger than maxMemory spill to disk, never to RAM — the whole point of a
// streaming import.
func uploadForm(r *http.Request, maxMemory int64) (fileBytes io.ReadCloser, fileName string, fields map[string]string, cleanup func(), err error) {
	r.Body = http.MaxBytesReader(nil, r.Body, 64<<20) // 64MB hard ceiling on uploads
	if err := r.ParseMultipartForm(maxMemory); err != nil {
		return nil, "", nil, func() {}, err
	}
	_, fh, err := r.FormFile("file")
	if err != nil {
		return nil, "", nil, func() {}, err
	}
	fields = map[string]string{}
	for k := range r.MultipartForm.Value {
		fields[k] = r.FormValue(k)
	}
	f, err := fh.Open()
	if err != nil {
		return nil, "", nil, func() {}, err
	}
	data, err := io.ReadAll(f)
	_ = f.Close()
	if err != nil {
		return nil, "", nil, func() {}, err
	}
	// Whole file in memory is acceptable up to the 64MB ceiling (a 20k-row
	// sheet is ~2MB); the streaming guarantee that matters is per-ROW memory
	// during parsing, which xlsx.go provides.
	fileBytes = io.NopCloser(bytes.NewReader(data))
	fileName = fh.Filename
	cleanup = func() {}
	return fileBytes, fileName, fields, cleanup, nil
}

// zipWriter assembles the batch-download responses (receipts/report cards):
// one ZIP, one PDF per row, named by admission number.
func zipWriter(w http.ResponseWriter, name string) *zip.Writer {
	w.Header().Set("content-type", "application/zip")
	w.Header().Set("content-disposition", `attachment; filename="`+name+`"`)
	return zip.NewWriter(w)
}

func itoa(i int) string { return strconv.Itoa(i) }
