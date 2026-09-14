// ──────────────────────────────────────────────
// Streaming XLSX reader (BUILD_PLAN 6.3).
//
// An .xlsx is a ZIP of XML. excelize/node-xlsx load the whole sheet into
// memory as [][]string, which is exactly how a 20k-row upload OOMs a
// service. This reads with streaming decoders instead:
//
//   - worksheet XML: xml.Decoder token stream — rows are produced one at a
//     time, memory holds one row
//   - sharedStrings.xml: still buffered once (it is index-addressed, so a
//     full table is unavoidable — but it is strings only)
//   - CSV: bufio.Scanner, one line at a time
//
// Both readers share one contract: a header row (matched case-insensitively
// against aliases), then a callback per data row. The callback returning an
// error aborts the whole file; returning normally just moves on — row-level
// error reporting lives with the caller.
// ──────────────────────────────────────────────

package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
)

// rowHandler receives one data row (header-normalised keys → values).
// Returning an error aborts the whole file.
type rowHandler func(row map[string]string, rowNo int) error

// readTabularFile dispatches on extension: .csv streams line-by-line,
// anything else is treated as XLSX. The first worksheet is used.
func readTabularFile(name string, data []byte, aliases map[string]string, h rowHandler) error {
	if strings.EqualFold(filepath.Ext(name), ".csv") {
		return readCSV(data, aliases, h)
	}
	return readXLSX(data, aliases, h)
}

// ── CSV ──

func readCSV(data []byte, aliases map[string]string, h rowHandler) error {
	r := csv.NewReader(bufio.NewReaderSize(bytes.NewReader(data), 64*1024))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true

	var header []string
	rowNo := 0
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("row %d: %w", rowNo+2, err)
		}
		rowNo++
		if rowNo == 1 {
			header = normaliseHeader(rec, aliases)
			continue
		}
		m := map[string]string{}
		for i, cell := range rec {
			if i < len(header) && header[i] != "" {
				m[header[i]] = strings.TrimSpace(cell)
			}
		}
		if emptyRow(m) {
			continue
		}
		if err := h(m, rowNo+1); err != nil { // sheet rows are 1-indexed; +1 for header
			return err
		}
	}
	if header == nil {
		return errors.New("the file contains no header row")
	}
	return nil
}

// ── XLSX ──

type xlsxRow struct {
	Cells []xlsxCell `xml:"c"`
	R     string    `xml:"r,attr"` // "13" — unused, we count
}

type xlsxCell struct {
	R string `xml:"r,attr"` // "C13"
	T string `xml:"t,attr"` // "s" shared | "str" | "inlineStr" | "" number
	V string `xml:"v"`
	Is struct {
		T string `xml:"t"`
	} `xml:"is"`
}

func readXLSX(data []byte, aliases map[string]string, h rowHandler) error {
	size := int64(len(data))
	zr, err := zip.NewReader(bytes.NewReader(data), size)
	if err != nil {
		return fmt.Errorf("not a readable xlsx: %w", err)
	}

	// sharedStrings: index → text. Buffered once, unavoidable (indexed).
	shared := []string{}
	for _, f := range zr.File {
		if f.Name == "xl/sharedStrings.xml" {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			shared, err = readSharedStrings(rc)
			rc.Close()
			if err != nil {
				return err
			}
			break
		}
	}

	// First worksheet: xl/worksheets/sheet1.xml, else the first sheet* entry.
	var sheet *zip.File
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			sheet = f
			break
		}
	}
	if sheet == nil {
		for _, f := range zr.File {
			if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml") {
				sheet = f
				break
			}
		}
	}
	if sheet == nil {
		return errors.New("the file contains no worksheets")
	}

	rc, err := sheet.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	return streamWorksheet(rc, shared, aliases, h)
}

func readSharedStrings(r io.Reader) ([]string, error) {
	out := []string{}
	dec := xml.NewDecoder(r)
	si := ""
	inSi := false
	inT := false
	text := ""
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return out, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSi, si = true, ""
			case "t":
				inT = true
				text = ""
			}
		case xml.CharData:
			if inT {
				text += string(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				if inSi {
					si += text
				}
				inT = false
			case "si":
				if inSi {
					out = append(out, si)
				}
				inSi = false
			}
		}
	}
	return out, nil
}

// streamWorksheet walks the sheet XML token stream, emitting one
// header-normalised map per row.
func streamWorksheet(r io.Reader, shared []string, aliases map[string]string, h rowHandler) error {
	dec := xml.NewDecoder(r)
	var header []string
	rowNo := 0
	collect := false
	var cur xlsxRow

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "row" {
				collect = true
				cur = xlsxRow{}
			} else if collect && t.Name.Local == "c" {
				var c xlsxCell
				if err := dec.DecodeElement(&c, &t); err != nil {
					return err
				}
				cur.Cells = append(cur.Cells, c)
			}
		case xml.EndElement:
			if t.Name.Local == "row" && collect {
				collect = false
				rowNo++
				if rowNo == 1 {
					header = normaliseHeader(cellsToStrings(cur, shared), aliases)
					continue
				}
				m := map[string]string{}
				for i, v := range cellsToStrings(cur, shared) {
					if i < len(header) && header[i] != "" {
						m[header[i]] = v
					}
				}
				if emptyRow(m) {
					continue
				}
				if err := h(m, rowNo+1); err != nil {
					return err
				}
			}
		}
	}
	if header == nil {
		return errors.New("the file contains no header row")
	}
	return nil
}

// cellsToStrings resolves one row's cells to display strings, honouring the
// sparse r="C13" attribute: a missing cell between two present ones is an
// empty string, not a shift.
func cellsToStrings(row xlsxRow, shared []string) []string {
	out := []string{}
	for _, c := range row.Cells {
		col := columnLetters(c.R)
		for len(out) < col {
			out = append(out, "")
		}
		var v string
		switch c.T {
		case "s": // shared string index
			idx, err := strconv.Atoi(strings.TrimSpace(c.V))
			if err == nil && idx >= 0 && idx < len(shared) {
				v = shared[idx]
			}
		case "inlineStr":
			v = c.Is.T
		default: // "str", numbers, formulas' cached values
			v = c.V
		}
		if len(out) == col { // padded up to col, never past it
			out = append(out, strings.TrimSpace(v))
		} else {
			out[col] = strings.TrimSpace(v)
		}
	}
	return out
}

// columnLetters parses "C13" → 2 (0-based column index).
func columnLetters(ref string) int {
	n := 0
	for _, ch := range ref {
		if ch >= 'A' && ch <= 'Z' {
			n = n*26 + int(ch-'A') + 1
		} else if ch >= 'a' && ch <= 'z' {
			n = n*26 + int(ch-'a') + 1
		} else {
			break
		}
	}
	if n == 0 {
		return 0
	}
	return n - 1
}

// normaliseHeader maps display headers to canonical keys via the alias
// table. Unrecognised columns PASS THROUGH lowercased (marks grids have a
// subject code per column, unknown at header time); the caller drops the
// ones it does not know. Aliased columns get their canonical key.
func normaliseHeader(display []string, aliases map[string]string) []string {
	out := make([]string, len(display))
	for i, name := range display {
		key := strings.ToLower(strings.TrimSpace(name))
		key = strings.Join(strings.Fields(key), " ") // collapse whitespace
		if v, ok := aliases[key]; ok {
			out[i] = v
		} else {
			out[i] = key
		}
	}
	return out
}

func emptyRow(m map[string]string) bool {
	for _, v := range m {
		if v != "" {
			return false
		}
	}
	return true
}
