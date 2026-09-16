# ──────────────────────────────────────────────
# Zero-dependency PDF 1.4 writer — Python port of packages/domain/src/pdf.ts
# (BUILD_PLAN 7.1: "Export to Excel/PDF").
#
# The Node receipt/invoice writer and the Go batch writer already share this
# design: one page of positioned text and hairlines, base-14 Helvetica, no
# compression, no images, no font embedding — renders everywhere with zero
# native deps. This third member of the family adds pagination, because a
# report is a table with more rows than one page holds.
#
# Content model is deliberately tiny: text ops + line ops. Callers build the
# layout; this module measures, escapes, and serializes. Escape \ ( ) in text;
# that is the whole hard part.
# ──────────────────────────────────────────────

from __future__ import annotations

PAGE_W = 595  # A4 @ 72dpi
PAGE_H = 842
MARGIN = 48

# Transliterate to WinAnsi (CP1252): the fonts declare /WinAnsiEncoding, so
# smart punctuation must be emitted as its CP1252 byte, and anything WinAnsi
# lacks (₹) is spelled out. Without this, latin-1 encoding silently turns
# em-dashes and ellipses into '?'.
_WINANSI = {
    "\u2014": chr(0x97),  # em dash
    "\u2013": chr(0x96),  # en dash
    "\u2018": chr(0x91),
    "\u2019": chr(0x92),
    "\u201c": chr(0x93),
    "\u201d": chr(0x94),
    "\u2026": chr(0x85),
    "\u2022": chr(0x95),
    "\u20b9": "Rs.",  # rupee sign — WinAnsi has no glyph for it
}


def _to_winansi(s: str) -> str:
    out = []
    for ch in s:
        mapped = _WINANSI.get(ch)
        if mapped is not None:
            out.append(mapped)
        elif ord(ch) <= 0xFF:
            out.append(ch)
        else:
            out.append("?")
    return "".join(out)


def esc(s: str) -> str:
    """Escape the two characters PDF string literals care about."""
    return _to_winansi(s).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


# Helvetica character widths (per 1000 units) for the ASCII range we print.
_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 500, 500, 333, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500]
_REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 500, 500, 334, 260, 334, 584, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 500, 500, 500, 500]


def _build_widths(arr: list[int]) -> dict[int, int]:
    return {32 + i: w for i, w in enumerate(arr)}


_WIDTHS = {"regular": _build_widths(_REGULAR), "bold": _build_widths(_BOLD)}


def text_width(text: str, size: float, bold: bool = False) -> float:
    widths = _WIDTHS["bold" if bold else "regular"]
    total = 0
    for ch in text:
        total += widths.get(ord(ch), 556)
    return (total / 1000.0) * size


def clip(text: str, size: float, bold: bool, max_width: float) -> str:
    """Narrow the string until it fits `max_width` at `size`."""
    if text_width(text, size, bold) <= max_width:
        return text
    t = text
    while len(t) > 1 and text_width(t + "\u2026", size, bold) > max_width:
        t = t[:-1]
    return t + "\u2026"


class Pdf:
    """A paginated document: pages of text/line ops, serialized on demand.

    Objects: 1 Catalog, 2 Pages, 3 Helvetica, 4 Helvetica-Bold, then two
    objects per page (the page and its content stream).
    """

    def __init__(self) -> None:
        self._pages: list[list[dict]] = [[]]

    def text(self, x: float, y: float, text: str, size: float = 10, bold: bool = False) -> None:
        if not text:
            return
        self._pages[-1].append({"op": "text", "x": x, "y": y, "size": size, "bold": bold, "text": text})

    def line(self, x1: float, y1: float, x2: float, y2: float) -> None:
        self._pages[-1].append({"op": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2})

    def new_page(self) -> None:
        self._pages.append([])

    @property
    def page_count(self) -> int:
        return len(self._pages)

    @property
    def pages(self) -> list[list[dict]]:
        """Mutable op-lists, so a renderer can stamp footers once the page
        count is known ("Page 2 of 3" cannot be drawn while paginating)."""
        return self._pages

    def _content(self, ops: list[dict]) -> str:
        parts: list[str] = []
        for o in ops:
            if o["op"] == "text":
                font = "F2" if o["bold"] else "F1"
                parts.append(
                    f"BT /{font} {o['size']} Tf 1 0 0 1 {o['x']:.2f} {o['y']:.2f} Tm ({esc(o['text'])}) Tj ET"
                )
            else:
                parts.append(f"{o['x1']:.2f} {o['y1']:.2f} m {o['x2']:.2f} {o['y2']:.2f} l S")
        return "\n".join(parts) + "\n"

    def to_bytes(self) -> bytes:
        streams = [self._content(ops) for ops in self._pages]
        n = len(streams)
        kids = " ".join(f"{5 + 2 * i} 0 R" for i in range(n))
        objects: list[str] = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [{kids}] /Count {n} >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        ]
        for i, content in enumerate(streams):
            objects.append(
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                f"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {6 + 2 * i} 0 R >>"
            )
            objects.append(f"<< /Length {len(content.encode('latin-1'))} >>\nstream\n{content}endstream")

        pdf = "%PDF-1.4\n"
        offsets: list[int] = []
        for i, body in enumerate(objects):
            offsets.append(len(pdf.encode("latin-1")))
            pdf += f"{i + 1} 0 obj\n{body}\nendobj\n"
        xref_start = len(pdf.encode("latin-1"))
        pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
        for off in offsets:
            pdf += f"{off:010d} 00000 n \n"
        pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF"
        return pdf.encode("latin-1")
