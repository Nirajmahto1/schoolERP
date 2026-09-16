# ──────────────────────────────────────────────
# Report builder & scheduled delivery (BUILD_PLAN 7.1)
#
# "A report builder with saved reports and scheduled email/WhatsApp delivery."
#
# Three rules shape this module:
#
#   1. A saved report stores a SPEC, never a query. It names a dashboard kind
#      plus its filters, so the report keeps working when the SQL underneath
#      changes — and a saved report can never be a hole a malicious spec
#      injects SQL through: kinds are looked up in a closed catalogue.
#   2. Every delivery snapshots its bytes. The number a principal was emailed
#      must still be the number they open a week later, even though the school
#      kept collecting fees in the meantime.
#   3. Tokens are hashed at rest (sha256) exactly like identity's invite/reset
#      tokens: the link IS the credential, so a database leak must not become a
#      report leak. Downloads are counted; the link expires.
#
# Nothing here writes school data. The scheduled sweep is the only part of the
# service with an outbound side effect, and it goes through communication-
# service (delivery.py) — analytics never talks to a provider directly.
# ──────────────────────────────────────────────

from __future__ import annotations

import hashlib
import io
import json
import re
import secrets
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Awaitable, Callable, Optional

try:  # package mode: uvicorn analytics_service.main:app
    from . import db, queries
    from .delivery import dispatch_report
    from .pdf import MARGIN, PAGE_H, PAGE_W, Pdf, clip, text_width
except ImportError:  # direct mode: python main.py from this directory
    import db  # type: ignore[no-redef]
    import queries  # type: ignore[no-redef]
    from delivery import dispatch_report  # type: ignore[no-redef]
    from pdf import MARGIN, PAGE_H, PAGE_W, Pdf, clip, text_width  # type: ignore[no-redef]

# A fortnight covers "sent on the 1st, opened on the 10th" without leaving
# stale links alive for a quarter.
TOKEN_TTL_DAYS = 14

# A report is a summary, never a data dump — and a bounded row count is what
# keeps both the XLSX and the snapshot artifact a sane size.
MAX_ROWS = 5_000


# ── Catalogue ──


@dataclass(frozen=True)
class ReportKind:
    key: str
    title: str
    description: str
    # Filter spec for the builder UI: name, type, default, allowed range.
    filters: list[dict[str, Any]]
    fetch: Callable[[str, dict[str, Any]], Awaitable[list[dict[str, Any]]]]


async def _at_risk(branch_id: str, filters: dict[str, Any]) -> list[dict[str, Any]]:
    limit = int(filters.get("limit") or 100)
    rows = await queries.at_risk_students(branch_id, min(limit, MAX_ROWS))
    return [
        {
            "studentName": r["studentName"],
            "admissionNo": r["admissionNo"],
            "class": r["class"],
            "riskLevel": r["riskLevel"],
            "attendanceRate": r["attendanceRate"],
            "averageMarksPct": r["averageMarksPct"],
            "feeOutstanding": r["feeOutstanding"],
            # The reasons ARE the product (§7.2): a ranked list with reasons,
            # never a black-box score.
            "reasons": "; ".join(r.get("reasons") or []),
        }
        for r in rows
    ]


async def _attendance(branch_id: str, filters: dict[str, Any]) -> list[dict[str, Any]]:
    days = int(filters.get("days") or 30)
    return await queries.attendance_heatmap(branch_id, min(max(days, 1), 120))


async def _fee_funnel(branch_id: str, filters: dict[str, Any]) -> list[dict[str, Any]]:
    funnel = await queries.fee_funnel(branch_id, filters.get("academicYearId"))
    rows = [
        {
            "status": status,
            "invoices": int(v["invoices"]),
            "invoiced": float(v["invoiced"]),
            "collected": float(v["collected"]),
            "outstanding": float(v["outstanding"]),
        }
        for status, v in funnel["byStatus"].items()
    ]
    totals = funnel["totals"]
    rows.append(
        {
            "status": "TOTAL",
            "invoices": sum(r["invoices"] for r in rows),
            "invoiced": totals["invoiced"],
            "collected": totals["collected"],
            "outstanding": round(totals["invoiced"] - totals["collected"], 2),
        }
    )
    return rows


async def _enrollment_trend(branch_id: str, filters: dict[str, Any]) -> list[dict[str, Any]]:
    months = int(filters.get("months") or 12)
    return await queries.enrollment_trend(branch_id, min(max(months, 1), 36))


async def _performance(branch_id: str, _filters: dict[str, Any]) -> list[dict[str, Any]]:
    return await queries.performance_distribution(branch_id)


async def _teacher_workload(branch_id: str, _filters: dict[str, Any]) -> list[dict[str, Any]]:
    return await queries.teacher_workload(branch_id)


async def _branch_comparison(branch_id: str, _filters: dict[str, Any]) -> list[dict[str, Any]]:
    return await queries.branch_comparison(branch_id)


REPORT_KINDS: dict[str, ReportKind] = {
    "AT_RISK": ReportKind(
        key="AT_RISK",
        title="Students needing attention",
        description="Ranked at-risk list with the reason for every flag (attendance, marks, fees).",
        filters=[{"name": "limit", "type": "number", "default": 100, "min": 1, "max": MAX_ROWS}],
        fetch=_at_risk,
    ),
    "ATTENDANCE": ReportKind(
        key="ATTENDANCE",
        title="Attendance register (daily)",
        description="Per-day present/absent/late counts and attendance rate for the window.",
        filters=[{"name": "days", "type": "number", "default": 30, "min": 1, "max": 120}],
        fetch=_attendance,
    ),
    "FEE_FUNNEL": ReportKind(
        key="FEE_FUNNEL",
        title="Fee collection funnel",
        description="Invoiced, collected and outstanding by invoice status, with a total row.",
        filters=[{"name": "academicYearId", "type": "academicYear", "default": None}],
        fetch=_fee_funnel,
    ),
    "ENROLLMENT_TREND": ReportKind(
        key="ENROLLMENT_TREND",
        title="Enrollment trend",
        description="Enrollment by month — the board's growth chart.",
        filters=[{"name": "months", "type": "number", "default": 12, "min": 1, "max": 36}],
        fetch=_enrollment_trend,
    ),
    "PERFORMANCE": ReportKind(
        key="PERFORMANCE",
        title="Class performance distribution",
        description="Grade-band distribution per subject over PUBLISHED results.",
        filters=[],
        fetch=_performance,
    ),
    "TEACHER_WORKLOAD": ReportKind(
        key="TEACHER_WORKLOAD",
        title="Teacher workload",
        description="Periods per week, subjects and teaching days per teacher.",
        filters=[],
        fetch=_teacher_workload,
    ),
    "BRANCH_COMPARISON": ReportKind(
        key="BRANCH_COMPARISON",
        title="Branch comparison",
        description="Every branch of the school side by side — the management-office report.",
        filters=[],
        fetch=_branch_comparison,
    ),
}


def catalog() -> list[dict[str, Any]]:
    return [
        {"key": k.key, "title": k.title, "description": k.description, "filters": k.filters}
        for k in REPORT_KINDS.values()
    ]


def kind_or_none(key: str) -> Optional[ReportKind]:
    return REPORT_KINDS.get(key)


# ── Rendering ──


def _cell(value: Any) -> Any:
    """Flatten a value into something both XLSX and PDF can print."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, (list, tuple)):
        return "; ".join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, default=str)
    return value


def _display(value: Any) -> str:
    v = _cell(value)
    if isinstance(v, float):
        # Money and rates both read better with grouping; reports are read by
        # humans, and the raw float stays in the JSON endpoints.
        return f"{v:,.2f}" if abs(v) < 1_000_000 else f"{v:,.0f}"
    return str(v)


def _rows_as_strings(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [{k: _display(v) for k, v in row.items()} for row in rows]


def render_xlsx(rows: list[dict[str, Any]], sheet: str, title: Optional[str] = None) -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = (sheet or "report")[:31]  # Excel sheet-name cap
    clean = [{k: _cell(v) for k, v in row.items()} for row in rows]
    if clean:
        headers = list(clean[0].keys())
        if title:
            ws.append([title])
            ws.append([])
        ws.append(headers)
        for r in clean:
            ws.append([r[h] for h in headers])
        for col, h in enumerate(headers, 1):
            width = max(len(str(h)), *(len(str(r[h] or "")) for r in clean)) + 2
            ws.column_dimensions[openpyxl.utils.get_column_letter(col)].width = min(width, 40)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _column_widths(rows: list[dict[str, str]], size: float, usable: float) -> list[float]:
    if not rows:
        return []
    headers = list(rows[0].keys())
    desired = []
    for h in headers:
        widest = max([text_width(h, size, True)] + [text_width(r.get(h, ""), size) for r in rows[:400]])
        desired.append(min(max(widest + 10, 44), usable * 0.4))
    total = sum(desired)
    if total <= usable:
        # Spread the slack so the last column is not a lonely gutter.
        slack = (usable - total) / len(desired)
        return [w + slack for w in desired]
    scale = usable / total
    return [w * scale for w in desired]


def render_pdf(
    rows: list[dict[str, Any]],
    title: str,
    subtitle: str = "",
    note: str = "",
) -> bytes:
    """One table, paginated. A4 portrait, 8.5pt, header row repeated per page."""
    size = 8.5
    usable = PAGE_W - 2 * MARGIN
    pdf = Pdf()

    def header(page_title: str, meta: str) -> float:
        y = PAGE_H - MARGIN
        pdf.text(MARGIN, y, page_title, size=14, bold=True)
        y -= 16
        if meta:
            pdf.text(MARGIN, y, meta, size=8.5)
            y -= 13
        pdf.line(MARGIN, y, PAGE_W - MARGIN, y)
        return y - 8

    meta = " · ".join(x for x in (subtitle, f"generated {date.today().isoformat()}") if x)
    y = header(title, meta)

    if not rows:
        pdf.text(MARGIN, y - 6, "No data for the selected filters.", size=10)
        if note:
            pdf.text(MARGIN, MARGIN + 18, note, size=7.5)
        return pdf.to_bytes()

    str_rows = _rows_as_strings(rows)
    headers = list(str_rows[0].keys())
    widths = _column_widths(str_rows, size, usable)

    def table_header(top: float) -> float:
        x = MARGIN
        for h, w in zip(headers, widths):
            pdf.text(x, top, clip(h, size, True, w), size=size, bold=True)
            x += w
        pdf.line(MARGIN, top - 4, PAGE_W - MARGIN, top - 4)
        return top - 14

    y = table_header(y)
    row_height = 12.5
    lines_used = 0
    for r in str_rows:
        if y < MARGIN + 34:
            pdf.new_page()
            y = header(f"{title} (continued)", meta)
            y = table_header(y)
        x = MARGIN
        for h, w in zip(headers, widths):
            pdf.text(x, y, clip(r.get(h, ""), size, False, w), size=size)
            x += w
        y -= row_height
        lines_used += 1

    # Footers last: "Page 2 of 5" cannot be drawn while paginating.
    total = pdf.page_count
    for i, ops in enumerate(pdf.pages):
        ops.append({"op": "line", "x1": MARGIN, "y1": MARGIN + 20, "x2": PAGE_W - MARGIN, "y2": MARGIN + 20})
        ops.append(
            {
                "op": "text",
                "x": MARGIN,
                "y": MARGIN + 10,
                "size": 7.5,
                "bold": False,
                "text": f"{note} " if note else "",
            }
        )
        ops.append(
            {
                "op": "text",
                "x": PAGE_W - MARGIN - 52,
                "y": MARGIN + 10,
                "size": 7.5,
                "bold": False,
                "text": f"Page {i + 1} of {total}",
            }
        )
    return pdf.to_bytes()


def safe_filename(name: str, limit: int = 40) -> str:
    """A filename that is safe in an HTTP header and as an Excel sheet name.

    Report titles are human text — they contain em dashes, slashes and the odd
    rupee sign. A filename travels in `Content-Disposition`, which is latin-1
    encoded, so a single non-ASCII character turns a 200 into a 500; Excel also
    rejects []:*?/\\ in sheet names. Fold to ASCII and keep one safe alphabet.
    """
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", folded).strip("-.")
    return (cleaned[:limit] or "report")


def render(
    rows: list[dict[str, Any]], fmt: str, title: str, subtitle: str, note: str = ""
) -> tuple[bytes, str]:
    """(bytes, filename) for one report."""
    sheet = safe_filename(title.lower().replace(" ", "-"), limit=31)
    stamp = date.today().isoformat()
    if fmt == "PDF":
        return render_pdf(rows, title, subtitle, note), f"{sheet}-{stamp}.pdf"
    return render_xlsx(rows, sheet, title), f"{sheet}-{stamp}.xlsx"


# ── Saved reports (CRUD) ──


def _json_obj(value: Any) -> dict[str, Any]:
    """asyncpg hands jsonb back as a STRING, not a dict.

    `dict("{\"limit\": 50}")` looks like it would work and instead raises
    `dictionary update sequence element #0 has length 1` — so every read of a
    jsonb column goes through here.
    """
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _report_row(r: Any) -> dict[str, Any]:
    d = dict(r)
    d["filters"] = _json_obj(d.get("filters"))
    for k in ("createdAt", "updatedAt"):
        if isinstance(d.get(k), datetime):
            d[k] = d[k].isoformat()
    return d


async def list_saved_reports(branch_id: str) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """
        SELECT r.id, r.name, r.kind, r.format, r.filters, r."isActive", r."createdAt", r."updatedAt",
               (SELECT count(*) FROM report_schedules s WHERE s."savedReportId" = r.id) AS schedules
          FROM saved_reports r
         WHERE r."branchId" = $1
         ORDER BY r."createdAt" DESC
        """,
        branch_id,
    )
    return [_report_row(r) for r in rows]


async def get_saved_report(branch_id: str, report_id: str) -> Optional[dict[str, Any]]:
    row = await db.fetchrow(
        """
        SELECT r.id, r.name, r.kind, r.format, r.filters, r."isActive", r."createdAt", r."updatedAt"
          FROM saved_reports r
         WHERE r.id = $1 AND r."branchId" = $2
        """,
        report_id,
        branch_id,
    )
    return _report_row(row) if row else None


async def create_saved_report(
    *,
    branch_id: str,
    name: str,
    kind: str,
    fmt: str,
    filters: dict[str, Any],
    created_by: Optional[str],
) -> dict[str, Any]:
    row = await db.fetchrow(
        """
        INSERT INTO saved_reports (id, "branchId", name, kind, format, filters, "createdBy", "updatedAt")
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4::"ReportFormat", $5::jsonb, $6, now())
        RETURNING id, name, kind, format, filters, "isActive", "createdAt", "updatedAt"
        """,
        branch_id,
        name,
        kind,
        fmt,
        json.dumps(filters or {}),
        created_by,
    )
    return _report_row(row)


async def update_saved_report(
    *,
    branch_id: str,
    report_id: str,
    name: Optional[str],
    fmt: Optional[str],
    filters: Optional[dict[str, Any]],
    is_active: Optional[bool],
) -> Optional[dict[str, Any]]:
    row = await db.fetchrow(
        """
        UPDATE saved_reports
           SET name = COALESCE($3, name),
               format = COALESCE($4::"ReportFormat", format),
               filters = COALESCE($5::jsonb, filters),
               "isActive" = COALESCE($6, "isActive"),
               "updatedAt" = now()
         WHERE id = $1 AND "branchId" = $2
        RETURNING id, name, kind, format, filters, "isActive", "createdAt", "updatedAt"
        """,
        report_id,
        branch_id,
        name,
        fmt,
        json.dumps(filters) if filters is not None else None,
        is_active,
    )
    return _report_row(row) if row else None


async def delete_saved_report(branch_id: str, report_id: str) -> bool:
    # Schedules cascade with their report (FK onDelete: Cascade) — deleting the
    # thing you schedule is the clearest way to stop it.
    result = await db.fetchval(
        'DELETE FROM saved_reports WHERE id = $1 AND "branchId" = $2 RETURNING id', report_id, branch_id
    )
    return result is not None


async def run_saved_report(branch_id: str, report: dict[str, Any], fmt: Optional[str] = None) -> tuple[bytes, str, int]:
    """Render a stored spec now. Returns (bytes, filename, row_count)."""
    kind = kind_or_none(str(report["kind"]))
    if kind is None:
        raise ValueError(f"Unknown report kind {report['kind']!r}.")
    rows = await kind.fetch(branch_id, _json_obj(report.get("filters")))
    branch_name = await branch_label(branch_id)
    data, filename = render(
        rows,
        fmt or str(report.get("format") or "XLSX"),
        f"{report['name']} — {kind.title}" if report.get("name") else kind.title,
        branch_name,
        note=f"{kind.title} · branch-scoped · {len(rows)} rows",
    )
    return data, filename, len(rows)


async def branch_label(branch_id: str) -> str:
    name = await db.fetchval("SELECT name FROM branches WHERE id = $1", branch_id)
    return str(name) if name else ""


# ── Schedules ──


def compute_next_run(
    cadence: str,
    hour_local: int,
    day_of_week: Optional[int],
    day_of_month: Optional[int],
    now: Optional[datetime] = None,
) -> datetime:
    """Next due time (server-local, like every other cron in this codebase).

    WEEKLY/MONTHLY collapse onto the first matching day at or after `now`;
    a cadence whose day has already passed this period rolls forward rather
    than firing late.
    """
    now = now or datetime.now()
    today_at = now.replace(hour=min(max(hour_local, 0), 23), minute=0, second=0, microsecond=0)
    if cadence == "DAILY":
        return today_at if today_at > now else today_at + timedelta(days=1)
    if cadence == "WEEKLY":
        target = min(max(day_of_week or 1, 1), 7)  # ISO: 1 = Monday
        ahead = (target - now.isoweekday()) % 7
        candidate = today_at + timedelta(days=ahead)
        return candidate if candidate > now else candidate + timedelta(days=7)
    if cadence == "MONTHLY":
        target = min(max(day_of_month or 1, 1), 28)  # 28: every month has one
        candidate = today_at.replace(day=target)
        if candidate > now:
            return candidate
        year, month = now.year + (1 if now.month == 12 else 0), 1 if now.month == 12 else now.month + 1
        return candidate.replace(year=year, month=month)
    raise ValueError(f"Unknown cadence {cadence!r}.")


def _schedule_row(r: Any) -> dict[str, Any]:
    d = dict(r)
    for k in ("nextRunAt", "lastRunAt", "createdAt"):
        if isinstance(d.get(k), datetime):
            d[k] = d[k].isoformat()
    return d


async def list_schedules(branch_id: str) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """
        SELECT s.id, s."savedReportId", s.cadence, s."hourLocal", s."dayOfWeek", s."dayOfMonth",
               s.channel, s."targetRoles", s.recipients, s."isActive", s."nextRunAt", s."lastRunAt",
               s."lastStatus", s."lastError", s."createdAt",
               r.name AS "reportName", r.kind AS "reportKind", r.format AS "reportFormat"
          FROM report_schedules s
          JOIN saved_reports r ON r.id = s."savedReportId"
         WHERE s."branchId" = $1
         ORDER BY s."nextRunAt" ASC
        """,
        branch_id,
    )
    return [_schedule_row(r) for r in rows]


async def create_schedule(
    *,
    branch_id: str,
    saved_report_id: str,
    cadence: str,
    hour_local: int,
    day_of_week: Optional[int],
    day_of_month: Optional[int],
    channel: str,
    target_roles: list[str],
    recipients: list[str],
    created_by: Optional[str],
    now: Optional[datetime] = None,
) -> Optional[dict[str, Any]]:
    next_run = compute_next_run(cadence, hour_local, day_of_week, day_of_month, now)
    row = await db.fetchrow(
        """
        INSERT INTO report_schedules
          (id, "savedReportId", "branchId", cadence, "hourLocal", "dayOfWeek", "dayOfMonth",
           channel, "targetRoles", recipients, "nextRunAt", "createdBy")
        SELECT gen_random_uuid()::text, $1, $2, $3::"ReportCadence", $4, $5, $6,
               $7::"NotificationChannel", $8::text[], $9::text[], $10, $11
         WHERE EXISTS (SELECT 1 FROM saved_reports WHERE id = $1 AND "branchId" = $2)
        RETURNING id, "savedReportId", cadence, "hourLocal", "dayOfWeek", "dayOfMonth", channel,
                  "targetRoles", recipients, "isActive", "nextRunAt", "lastRunAt", "lastStatus",
                  "lastError", "createdAt"
        """,
        saved_report_id,
        branch_id,
        cadence,
        hour_local,
        day_of_week,
        day_of_month,
        channel,
        target_roles,
        recipients,
        next_run,
        created_by,
    )
    return _schedule_row(row) if row else None


async def delete_schedule(branch_id: str, schedule_id: str) -> bool:
    deleted = await db.fetchval(
        'DELETE FROM report_schedules WHERE id = $1 AND "branchId" = $2 RETURNING id', schedule_id, branch_id
    )
    return deleted is not None


# ── Deliveries & tokens ──


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def create_delivery(
    *,
    schedule_id: str,
    branch_id: str,
    fmt: str,
    file_name: str,
    artifact: bytes,
    row_count: int,
    now: Optional[datetime] = None,
) -> tuple[str, str]:
    """Store the snapshot; return (delivery_id, plaintext token).

    The plaintext exists only in the message we send — the row keeps the hash.
    """
    token = secrets.token_urlsafe(32)
    now = now or datetime.now()
    delivery_id = await db.fetchval(
        """
        INSERT INTO report_deliveries
          (id, "scheduleId", "branchId", "tokenHash", format, "fileName", artifact, "rowCount",
           "sizeBytes", "expiresAt")
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4::"ReportFormat", $5, $6, $7, $8, $9)
        RETURNING id
        """,
        schedule_id,
        branch_id,
        _hash_token(token),
        fmt,
        file_name,
        artifact,
        row_count,
        len(artifact),
        now + timedelta(days=TOKEN_TTL_DAYS),
    )
    return str(delivery_id), token


async def get_delivery_by_token(token: str) -> Optional[dict[str, Any]]:
    row = await db.fetchrow(
        """
        SELECT id, "fileName", format, artifact, "expiresAt", status, downloads
          FROM report_deliveries
         WHERE "tokenHash" = $1
        """,
        _hash_token(token),
    )
    return dict(row) if row else None


async def mark_downloaded(delivery_id: str) -> None:
    await db.fetchval(
        'UPDATE report_deliveries SET downloads = downloads + 1 WHERE id = $1 RETURNING id', delivery_id
    )


async def purge_expired(now: Optional[datetime] = None) -> int:
    now = now or datetime.now()
    purged = await db.fetch(
        'DELETE FROM report_deliveries WHERE "expiresAt" < $1 RETURNING id', now
    )
    return len(purged)


async def list_deliveries(branch_id: str, limit: int = 25) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """
        SELECT d.id, d.format, d."fileName", d."rowCount", d."sizeBytes", d.status, d.recipients,
               d.error, d.downloads, d."expiresAt", d."createdAt",
               r.name AS "reportName", s.channel
          FROM report_deliveries d
          JOIN report_schedules s ON s.id = d."scheduleId"
          JOIN saved_reports r ON r.id = s."savedReportId"
         WHERE d."branchId" = $1
         ORDER BY d."createdAt" DESC
         LIMIT $2
        """,
        branch_id,
        min(max(limit, 1), 200),
    )
    out = []
    for r in rows:
        d = dict(r)
        for k in ("expiresAt", "createdAt"):
            if isinstance(d.get(k), datetime):
                d[k] = d[k].isoformat()
        out.append(d)
    return out


def download_link(token: str, public_base_url: Optional[str] = None) -> str:
    import os

    base = (public_base_url or os.getenv("PUBLIC_BASE_URL", "http://localhost:4000")).rstrip("/")
    return f"{base}/api/v1/analytics/reports/download/{token}"


# ── The sweep ──


async def sweep_due(now: Optional[datetime] = None, limit: int = 25) -> dict[str, Any]:
    """Send every schedule that is due. Idempotent by construction.

    A schedule's nextRunAt only moves when its run completes, and the delivery
    row records the outcome either way — so a crashed sweep delays a report but
    can never silently drop one, and a manual re-run of an already-sent
    schedule is visible in the deliveries list rather than invisible.

    Delivery failures do NOT retry in a tight loop: the next scheduled run
    renders fresh numbers anyway, and the admin sees the failure with the
    reason on the schedules screen.
    """
    now = now or datetime.now()
    due = await db.fetch(
        """
        SELECT s.id, s."savedReportId", s."branchId", s.cadence, s."hourLocal", s."dayOfWeek",
               s."dayOfMonth", s.channel, s."targetRoles", s.recipients, s."nextRunAt", s."createdBy",
               r.name AS "reportName", r.kind, r.format, r.filters, r."isActive" AS "reportActive",
               b.name AS "branchName"
          FROM report_schedules s
          JOIN saved_reports r ON r.id = s."savedReportId"
          LEFT JOIN branches b ON b.id = s."branchId"
         WHERE s."isActive" AND s."nextRunAt" <= $1
         ORDER BY s."nextRunAt" ASC
         LIMIT $2
        """,
        now,
        limit,
    )

    results: list[dict[str, Any]] = []
    sent = failed = 0

    for sch in due:
        schedule_id = str(sch["id"])
        branch_id = str(sch["branchId"])
        entry: dict[str, Any] = {"scheduleId": schedule_id, "report": sch["reportName"], "branchId": branch_id}
        next_run = compute_next_run(
            str(sch["cadence"]), int(sch["hourLocal"]), sch["dayOfWeek"], sch["dayOfMonth"], now
        )

        if not sch["reportActive"]:
            # The report was retired but a schedule survived — fail loudly once
            # rather than resurrecting a report someone switched off.
            entry.update(status="FAILED", error="The saved report is inactive.")
            failed += 1
            await _finish_schedule(schedule_id, now, next_run, "FAILED", entry["error"])
            results.append(entry)
            continue

        try:
            rows = await REPORT_KINDS[str(sch["kind"])].fetch(branch_id, _json_obj(sch["filters"]))
            data, filename = render(
                rows,
                str(sch["format"]),
                sch["reportName"],
                sch["branchName"] or "",
                note=f"{sch['reportName']} · branch-scoped · {len(rows)} rows",
            )
            delivery_id, token = await create_delivery(
                schedule_id=schedule_id,
                branch_id=branch_id,
                fmt=str(sch["format"]),
                file_name=filename,
                artifact=data,
                row_count=len(rows),
                now=now,
            )
        except Exception as e:  # rendering/storage failure: record, move on
            entry.update(status="FAILED", error=f"render failed: {e}")
            failed += 1
            await _finish_schedule(schedule_id, now, next_run, "FAILED", entry["error"])
            results.append(entry)
            continue

        link = download_link(token)
        body = (
            f"Scheduled report: {sch['reportName']}\n"
            f"{len(rows)} rows · {sch['format']} · expires in {TOKEN_TTL_DAYS} days.\n\n"
            f"Open the report: {link}\n\n"
            f"Sent automatically to the roles configured on this schedule."
        )
        ok, recipients, err = await dispatch_report(
            title=f"Report ready: {sch['reportName']}",
            body=body,
            channel=str(sch["channel"]),
            target_roles=list(sch["targetRoles"] or []),
            identity={
                "userId": sch["createdBy"],
                "tenantId": None,
                "branchId": branch_id,
                "schoolId": None,
            },
        )
        await db.fetchval(
            """
            UPDATE report_deliveries
               SET status = $2::"ReportDeliveryStatus", recipients = $3, error = $4
             WHERE id = $1
            RETURNING id
            """,
            delivery_id,
            "DELIVERED" if ok else "FAILED",
            recipients,
            err or None,
        )
        status = "SENT" if ok else "FAILED"
        sent += 1 if ok else 0
        failed += 0 if ok else 1
        entry.update(
            status=status,
            recipients=recipients,
            rows=len(rows),
            deliveryId=delivery_id,
            sizeBytes=len(data),
            error=err or None,
            # The link is logged so an operator can resend it by hand; it is a
            # capability, which is why it is only in this response and the
            # message, never in the delivery row.
            downloadUrl=link,
        )
        await _finish_schedule(schedule_id, now, next_run, status, entry.get("error"))
        results.append(entry)

    purged = await purge_expired(now)
    return {"due": len(due), "sent": sent, "failed": failed, "purgedDeliveries": purged, "results": results}


async def _finish_schedule(
    schedule_id: str, ran_at: datetime, next_run: datetime, status: str, error: Optional[str]
) -> None:
    await db.fetchval(
        """
        UPDATE report_schedules
           SET "lastRunAt" = $2, "lastStatus" = $3, "lastError" = $4, "nextRunAt" = $5
         WHERE id = $1
        RETURNING id
        """,
        schedule_id,
        ran_at,
        status,
        error,
        next_run,
    )
