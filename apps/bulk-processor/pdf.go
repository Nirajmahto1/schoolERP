// ──────────────────────────────────────────────
// Zero-dependency PDF 1.4 writer — a faithful Go port of
// packages/domain/src/pdf.ts, so the Node receipt writer and this batch
// writer agree on structure for the same ops.
//
// One page of positioned text + hairlines; base-14 Helvetica, no
// compression, no images, no font embedding — renders everywhere with zero
// native deps. Escape \ ( ) in text; that is the whole hard part.
// ──────────────────────────────────────────────

package main

import (
	"fmt"
	"strings"
)

const (
	pageW  = 595 // A4 @ 72dpi
	pageH  = 842
	margin = 48
)

// winansiMap mirrors the TS writer: smart punctuation → CP1252 bytes,
// anything WinAnsi lacks (₹) spelled out.
var winansiMap = map[string]string{
	"\u2014": string(rune(0x97)), // em dash
	"\u2013": string(rune(0x96)), // en dash
	"\u2018": string(rune(0x91)),
	"\u2019": string(rune(0x92)),
	"\u201C": string(rune(0x93)),
	"\u201D": string(rune(0x94)),
	"\u2026": string(rune(0x85)),
	"\u2022": string(rune(0x95)),
	"\u20B9": "Rs.", // rupee sign — WinAnsi has no glyph for it
}

func toWinAnsi(s string) string {
	var b strings.Builder
	for _, ch := range s {
		if v, ok := winansiMap[string(ch)]; ok {
			b.WriteString(v)
		} else if ch <= 0xff {
			b.WriteRune(ch)
		} else {
			b.WriteByte('?')
		}
	}
	return b.String()
}

// esc escapes the two characters PDF string literals care about.
func esc(s string) string {
	s = toWinAnsi(s)
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `(`, `\(`)
	s = strings.ReplaceAll(s, `)`, `\)`)
	return s
}

// helvWidths: Helvetica character widths per 1000 units for the printable
// range (32..126), then CP1252 high bytes default to 556.
var helvWidths = [95]float64{
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
	556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
	1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
	333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
	556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 500,
}

var helvBoldWidths = [95]float64{
	278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
	556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
	975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
	333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
	611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 500,
}

func textWidth(text string, size float64, bold bool) float64 {
	var total float64
	for _, ch := range toWinAnsi(text) {
		c := int(ch)
		w := 556.0
		if c >= 32 && c <= 126 {
			if bold {
				w = helvBoldWidths[c-32]
			} else {
				w = helvWidths[c-32]
			}
		}
		total += w
	}
	return total / 1000 * size
}

// clip narrows the string until it fits maxWidth at size.
func clip(text string, size float64, bold bool, maxWidth float64) string {
	if textWidth(text, size, bold) <= maxWidth {
		return text
	}
	runes := []rune(text)
	for len(runes) > 1 && textWidth(string(runes)+"…", size, bold) > maxWidth {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}

type textOp struct {
	x, y, size float64
	bold       bool
	text       string
}

type lineOp struct {
	x1, y1, x2, y2 float64
}

type drawOp interface{ emit() string }

func (o textOp) emit() string {
	if o.text == "" {
		return ""
	}
	f := "F1"
	if o.bold {
		f = "F2"
	}
	return fmt.Sprintf("BT /%s %s Tf 1 0 0 1 %s %s Tm (%s) Tj ET",
		f, trimF(o.size), trimF(o.x), trimF(o.y), esc(o.text))
}

func (o lineOp) emit() string {
	return fmt.Sprintf("%s %s m %s %s l S", trimF(o.x1), trimF(o.y1), trimF(o.x2), trimF(o.y2))
}

func trimF(v float64) string {
	s := fmt.Sprintf("%.2f", v)
	return strings.TrimRight(strings.TrimRight(s, "0"), ".")
}

// assemblePdf serializes the content stream + objects into a valid
// single-page PDF (1 Catalog, 2 Pages, 3 Page, 4 Helvetica, 5 Helvetica-Bold,
// 6 Contents) — same object graph as the TS writer.
func assemblePdf(ops []drawOp) []byte {
	parts := []string{}
	for _, o := range ops {
		if e := o.emit(); e != "" {
			parts = append(parts, e)
		}
	}
	content := strings.Join(parts, "\n") + "\n"

	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>", pageW, pageH),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(content), content),
	}

	var b strings.Builder
	b.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	pos := len("%PDF-1.4\n")
	for i, obj := range objects {
		offsets[i+1] = pos
		b.WriteString(fmt.Sprintf("%d 0 obj\n%s\nendobj\n", i+1, obj))
		pos += len(fmt.Sprintf("%d 0 obj\n%s\nendobj\n", i+1, obj))
	}
	xrefStart := pos
	b.WriteString(fmt.Sprintf("xref\n0 %d\n", len(objects)+1))
	b.WriteString("0000000000 65535 f \n")
	for i := 1; i <= len(objects); i++ {
		b.WriteString(fmt.Sprintf("%010d 00000 n \n", offsets[i]))
	}
	b.WriteString(fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xrefStart))
	return []byte(b.String())
}
