# ──────────────────────────────────────────────
# School ERP — Analytics Service (FastAPI, Phase 7.1)
#
# The stub hardcoded "total_students = 1250" and invented attendance from
# `toordinal() % 18`. Every number here now comes from the tenant DB, scoped
# to the branch in the gateway-minted assertion. Reads only — this service can
# never corrupt the books it reports on.
#
# Dashboards (BUILD_PLAN §7.1): enrollment trend, attendance heatmap, fee
# funnel, performance distribution, teacher workload, branch comparison, and
# the §7.2 at-risk ranked list with reasons. Excel/PDF export included.
# ──────────────────────────────────────────────

from __future__ import annotations

import asyncio
import io
import os
import traceback
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

try:  # package mode: uvicorn analytics_service.main:app
    from . import db, queries, reports, scoring, validation
    from .auth import Identity, public_key_configured, require_identity
except ImportError:  # direct mode: python main.py from this directory
    import db  # type: ignore[no-redef]
    import queries  # type: ignore[no-redef]
    import reports  # type: ignore[no-redef]
    import scoring  # type: ignore[no-redef]
    import validation  # type: ignore[no-redef]
    from auth import Identity, public_key_configured, require_identity  # type: ignore[no-redef]

SERVICE_NAME = "analytics-service"

# The scheduled-report sweep: how often due schedules are checked, and whether
# this process runs the timer at all (tests and one-shot tools set it to 0).
SWEEP_INTERVAL_SECONDS = int(os.getenv("REPORT_SWEEP_INTERVAL_SECONDS", "300"))


async def sweep_loop() -> None:
    """Send due schedules forever. `nextRunAt` is the authority, not the clock.

    The due query only returns schedules whose stored next-run time has passed,
    and each run moves that time forward — so a restart, a long outage, or two
    analytics replicas racing can delay a report but can never send one twice
    or drop it silently. Delivery failures surface in the deliveries list.
    """
    while True:
        try:
            result = await reports.sweep_due()
            if result["due"]:
                print(f"[report-sweep] {result['due']} due, {result['sent']} sent, {result['failed']} failed")
                for entry in result["results"]:
                    if entry.get("error"):
                        print(f"[report-sweep]   {entry.get('report')}: {entry['error']}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # never let a sweep failure kill the timer
            print(f"[report-sweep] failed: {e}\n{traceback.format_exc(limit=3)}")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail-closed is about auth; the DB pool is lazy — the service can boot
    # before Postgres and report /ready 503 until it connects.
    timer: Optional[asyncio.Task[None]] = None
    if SWEEP_INTERVAL_SECONDS > 0:
        timer = asyncio.create_task(sweep_loop())
    yield
    if timer is not None:
        timer.cancel()
        try:
            await timer
        except (asyncio.CancelledError, Exception):
            pass
    await db.close_pool()


app = FastAPI(
    title="School ERP Analytics Service",
    description="Branch-scoped, DB-backed reports and dashboards (Phase 7.1)",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": SERVICE_NAME, "timestamp": datetime.now().isoformat()}


@app.get("/ready")
async def ready():
    if await db.ready():
        return {"status": "ready", "service": SERVICE_NAME}
    raise HTTPException(status_code=503, detail="Database is not reachable.")


def resolve_branch(user: Identity, requested: Optional[str]) -> str:
    """Which branch may this caller see? SUPER_ADMIN can ask; others are pinned."""
    if requested and user.is_super_admin:
        return requested
    if requested and requested != user.branch_id:
        raise HTTPException(status_code=403, detail="You may only view your own branch's analytics.")
    if not user.branch_id:
        raise HTTPException(status_code=403, detail="Account has no branch — analytics is branch-scoped.")
    return user.branch_id


# ── Dashboards ──


@app.get("/analytics/dashboard")
async def dashboard(user: Identity = Depends(require_identity)) -> dict[str, Any]:
    return await queries.dashboard(user.branch_id)  # type: ignore[arg-type]


@app.get("/analytics/enrollment-trend")
async def enrollment_trend(
    months: int = Query(12, ge=1, le=36),
    user: Identity = Depends(require_identity),
) -> list[dict[str, Any]]:
    return await queries.enrollment_trend(user.branch_id, months)  # type: ignore[arg-type]


@app.get("/analytics/attendance")
async def attendance_heatmap(
    days: int = Query(30, ge=1, le=120),
    user: Identity = Depends(require_identity),
) -> list[dict[str, Any]]:
    return await queries.attendance_heatmap(user.branch_id, days)  # type: ignore[arg-type]


@app.get("/analytics/fees")
async def fee_funnel(
    academicYearId: Optional[str] = None,
    user: Identity = Depends(require_identity),
) -> dict[str, Any]:
    return await queries.fee_funnel(user.branch_id, academicYearId)  # type: ignore[arg-type]


@app.get("/analytics/performance")
async def performance_distribution(user: Identity = Depends(require_identity)) -> list[dict[str, Any]]:
    return await queries.performance_distribution(user.branch_id)  # type: ignore[arg-type]


@app.get("/analytics/teacher-workload")
async def teacher_workload(user: Identity = Depends(require_identity)) -> list[dict[str, Any]]:
    return await queries.teacher_workload(user.branch_id)  # type: ignore[arg-type]


@app.get("/analytics/branch-comparison")
async def branch_comparison(
    branchId: Optional[str] = None,  # accepted-and-ignored for non-super-admins
    user: Identity = Depends(require_identity),
) -> list[dict[str, Any]]:
    """The multi-branch management view (Gate 7: 3-branch tenant in < 2s).

    Scoped to the caller's SCHOOL (derived from their branch inside the tenant
    DB) — every branch admin of the school sees the same comparison. This is
    deliberate: the management office buys the product on this screen.
    """
    if not user.branch_id:
        raise HTTPException(status_code=403, detail="Account has no branch — comparison is a multi-branch view.")
    return await queries.branch_comparison(user.branch_id)


@app.get("/analytics/at-risk")
async def at_risk(
    limit: int = Query(50, ge=1, le=500),
    branchId: Optional[str] = None,
    thresholdMode: str = Query("absolute", pattern="^(branch-relative|absolute)$"),
    user: Identity = Depends(require_identity),
) -> list[dict[str, Any]]:
    """The ranked list. Default is the ABSOLUTE regulatory lines: in a healthy
    branch they correctly flag almost nobody — an empty list is the right
    answer. thresholdMode=branch-relative switches to the Gate-7 recalibration
    lens (branch median / p10, same floors), which trades precision for recall;
    measured in docs/ops/gate-7-evidence.md."""
    branch = resolve_branch(user, branchId)
    return await queries.at_risk_students(branch, limit, threshold_mode=thresholdMode)


@app.get("/analytics/at-risk/thresholds")
async def at_risk_thresholds(
    branchId: Optional[str] = None,
    user: Identity = Depends(require_identity),
) -> dict[str, Any]:
    """What the lines are and where they came from — the transparency the
    product promise rests on. A principal can argue with a threshold they can
    read; that is the point of the whole design. Shows both lenses: the
    absolute regulatory default and the branch-relative watch-list lines."""
    branch = resolve_branch(user, branchId)
    absolute = scoring.Thresholds.absolute().describe()
    relative = await queries.at_risk_thresholds(branch)
    relative.pop("mode", None)  # describe() of the relative lens; keep basis
    return {
        "default": {**absolute, "note": "regulatory lines — screen default (high precision)"},
        "branchRelative": relative,
    }


@app.get("/analytics/at-risk/validation")
async def at_risk_validation(
    branchId: Optional[str] = None,
    labelFrom: Optional[date] = Query(default=None, description="Split date (defaults to the latest published examination)"),
    examFailPct: float = Query(33.0, gt=0, le=100),
    attendanceBelow: float = Query(75.0, gt=0, le=100),
    bottomFraction: float = Query(0.10, gt=0, le=0.5),
    featureDays: int = Query(365, ge=90, le=1095),
    thresholdMode: str = Query("absolute", pattern="^(branch-relative|absolute)$"),
    user: Identity = Depends(require_identity),
) -> dict[str, Any]:
    """GATE 7 evidence: back-test the at-risk rules on held-out history.

    A temporal hold-out — features from before the split, outcomes after it —
    scored by the same functions the live ranked list uses (scoring.py), so the
    reported precision/recall describe the model a principal actually sees. The
    response carries every label definition and cut-off, plus feature coverage
    and caveats, so nobody has to take a single number on trust.

    thresholdMode=absolute (default) validates the SHIPPED fixed lines.
    thresholdMode=branch-relative runs the Gate-7 recalibration lens (median /
    10th percentile of this branch's feature window, floored at the regulatory
    minimums) so the recalibration stays measurable against its baseline.
    """
    branch = resolve_branch(user, branchId)
    try:
        return await validation.validate_at_risk(
            branch,
            label_from=datetime.combine(labelFrom, datetime.min.time()) if labelFrom else None,
            exam_fail_pct=examFailPct,
            attendance_below=attendanceBelow,
            bottom_fraction=bottomFraction,
            feature_days=featureDays,
            threshold_mode=thresholdMode,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


# ── Exports (§7.1: "Schools live in Excel") ──


def _xlsx(rows: list[dict[str, Any]], sheet: str) -> StreamingResponse:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet[:31]  # Excel sheet-name cap
    if rows:
        headers = list(rows[0].keys())
        ws.append(headers)
        for r in rows:
            ws.append([r[h] for h in headers])
        for col, h in enumerate(headers, 1):
            width = max(len(h), *(len(str(r[h] or "")) for r in rows)) + 2
            ws.column_dimensions[openpyxl.utils.get_column_letter(col)].width = min(width, 40)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    stamp = date.today().isoformat()
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{sheet}-{stamp}.xlsx"'},
    )


@app.get("/analytics/export/at-risk.xlsx")
async def export_at_risk(
    branchId: Optional[str] = None,
    user: Identity = Depends(require_identity),
):
    branch = resolve_branch(user, branchId)
    rows = await queries.at_risk_students(branch, 500)
    # openpyxl cells take scalars only — flatten the structured reasons list
    # into the sentence the JSON endpoint already carries.
    flat = [{**r, "reasons": "; ".join(r.get("reasons") or [])} for r in rows]
    return _xlsx(flat, "at-risk-students")


@app.get("/analytics/export/attendance.xlsx")
async def export_attendance(
    days: int = Query(30, ge=1, le=120),
    user: Identity = Depends(require_identity),
):
    rows = await queries.attendance_heatmap(user.branch_id, days)  # type: ignore[arg-type]
    return _xlsx(rows, "attendance")


@app.get("/analytics/export/branch-comparison.xlsx")
async def export_branch_comparison(user: Identity = Depends(require_identity)):
    if not user.branch_id:
        raise HTTPException(status_code=403, detail="Account has no branch.")
    rows = await queries.branch_comparison(user.branch_id)
    return _xlsx(rows, "branch-comparison")


# ── Report builder & scheduled delivery (§7.1) ──
#
# A saved report is a SPEC — a catalogue kind plus filters — never SQL, so a
# saved report can never become an injection hole (see reports.py). Every
# route below is branch-scoped: a caller sees, runs, schedules and downloads
# their own branch's reports only, and the rendered artifact is stored so the
# numbers a principal was emailed are the numbers they still open next week.

REPORT_FORMATS = {"XLSX", "PDF"}
REPORT_CADENCES = {"DAILY", "WEEKLY", "MONTHLY"}
REPORT_CHANNELS = {"EMAIL", "WHATSAPP", "SMS", "PUSH"}


def require_branch(user: Identity) -> str:
    if not user.branch_id:
        raise HTTPException(status_code=403, detail="Account has no branch — reports are branch-scoped.")
    return user.branch_id


def _artifact(data: bytes, filename: str, fmt: str) -> StreamingResponse:
    # `Content-Disposition` is latin-1 encoded by the ASGI server, so one
    # non-ASCII character in a generated filename turns a 200 into a 500. The
    # renderers already sanitise; this is the last line of defence for any
    # future caller that builds a name by hand.
    safe = reports.safe_filename(filename, limit=96)
    media = (
        "application/pdf"
        if fmt == "PDF"
        else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    return StreamingResponse(
        io.BytesIO(data),
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{safe}"',
            "Cache-Control": "no-store",
        },
    )


class SavedReportInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str = Field(min_length=1, max_length=60)
    format: str = "XLSX"
    filters: dict[str, Any] = Field(default_factory=dict)


class SavedReportPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    format: Optional[str] = None
    filters: Optional[dict[str, Any]] = None
    isActive: Optional[bool] = None


class ScheduleInput(BaseModel):
    savedReportId: str
    cadence: str
    hourLocal: int = Field(default=7, ge=0, le=23)
    dayOfWeek: Optional[int] = Field(default=None, ge=1, le=7)
    dayOfMonth: Optional[int] = Field(default=None, ge=1, le=28)
    channel: str = "EMAIL"
    targetRoles: list[str] = Field(default_factory=list)
    recipients: list[str] = Field(default_factory=list)


@app.get("/analytics/reports/catalog")
async def report_catalog(user: Identity = Depends(require_identity)) -> dict[str, Any]:
    """The builder UI's palette: which kinds exist and which filters each takes."""
    return {"kinds": reports.catalog()}


@app.get("/analytics/reports")
async def list_reports(user: Identity = Depends(require_identity)) -> list[dict[str, Any]]:
    return await reports.list_saved_reports(require_branch(user))


@app.post("/analytics/reports", status_code=201)
async def create_report(
    body: SavedReportInput, user: Identity = Depends(require_identity)
) -> dict[str, Any]:
    branch = require_branch(user)
    if reports.kind_or_none(body.kind) is None:
        raise HTTPException(status_code=400, detail=f"Unknown report kind {body.kind!r}.")
    if body.format.upper() not in REPORT_FORMATS:
        raise HTTPException(status_code=400, detail=f"Format must be one of {sorted(REPORT_FORMATS)}.")
    return await reports.create_saved_report(
        branch_id=branch,
        name=body.name.strip(),
        kind=body.kind,
        fmt=body.format.upper(),
        filters=body.filters,
        created_by=user.user_id,
    )


@app.get("/analytics/reports/{report_id}")
async def get_report(report_id: str, user: Identity = Depends(require_identity)) -> dict[str, Any]:
    report = await reports.get_saved_report(require_branch(user), report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="No such saved report in this branch.")
    return report


@app.patch("/analytics/reports/{report_id}")
async def update_report(
    report_id: str, body: SavedReportPatch, user: Identity = Depends(require_identity)
) -> dict[str, Any]:
    if body.format is not None and body.format.upper() not in REPORT_FORMATS:
        raise HTTPException(status_code=400, detail=f"Format must be one of {sorted(REPORT_FORMATS)}.")
    report = await reports.update_saved_report(
        branch_id=require_branch(user),
        report_id=report_id,
        name=body.name.strip() if body.name else None,
        fmt=body.format.upper() if body.format else None,
        filters=body.filters,
        is_active=body.isActive,
    )
    if report is None:
        raise HTTPException(status_code=404, detail="No such saved report in this branch.")
    return report


@app.delete("/analytics/reports/{report_id}", status_code=204)
async def delete_report(report_id: str, user: Identity = Depends(require_identity)) -> None:
    # Schedules and their stored deliveries cascade with the report.
    if not await reports.delete_saved_report(require_branch(user), report_id):
        raise HTTPException(status_code=404, detail="No such saved report in this branch.")


@app.post("/analytics/reports/{report_id}/run")
async def run_report(
    report_id: str,
    format: Optional[str] = Query(default=None, description="Override the saved format (XLSX|PDF)"),
    user: Identity = Depends(require_identity),
) -> StreamingResponse:
    """Render a saved report now, with today's numbers."""
    branch = require_branch(user)
    report = await reports.get_saved_report(branch, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="No such saved report in this branch.")
    fmt = (format or str(report["format"])).upper()
    if fmt not in REPORT_FORMATS:
        raise HTTPException(status_code=400, detail=f"Format must be one of {sorted(REPORT_FORMATS)}.")
    try:
        data, filename, _rows = await reports.run_saved_report(branch, report, fmt)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _artifact(data, filename, fmt)


@app.get("/analytics/schedules")
async def list_schedules(user: Identity = Depends(require_identity)) -> list[dict[str, Any]]:
    return await reports.list_schedules(require_branch(user))


@app.post("/analytics/schedules", status_code=201)
async def create_schedule(
    body: ScheduleInput, user: Identity = Depends(require_identity)
) -> dict[str, Any]:
    branch = require_branch(user)
    if body.cadence.upper() not in REPORT_CADENCES:
        raise HTTPException(status_code=400, detail=f"Cadence must be one of {sorted(REPORT_CADENCES)}.")
    if body.channel.upper() not in REPORT_CHANNELS:
        raise HTTPException(status_code=400, detail=f"Channel must be one of {sorted(REPORT_CHANNELS)}.")
    if body.cadence.upper() == "WEEKLY" and body.dayOfWeek is None:
        raise HTTPException(status_code=400, detail="A weekly schedule needs dayOfWeek (1 = Monday).")
    if body.cadence.upper() == "MONTHLY" and body.dayOfMonth is None:
        raise HTTPException(status_code=400, detail="A monthly schedule needs dayOfMonth.")
    if body.dayOfWeek is not None and body.cadence.upper() != "WEEKLY":
        raise HTTPException(status_code=400, detail="dayOfWeek only applies to a weekly cadence.")
    if body.dayOfMonth is not None and body.cadence.upper() != "MONTHLY":
        raise HTTPException(status_code=400, detail="dayOfMonth only applies to a monthly cadence.")
    report = await reports.get_saved_report(branch, body.savedReportId)
    if report is None:
        raise HTTPException(status_code=404, detail="No such saved report in this branch.")
    if not body.targetRoles and not body.recipients:
        raise HTTPException(
            status_code=400,
            detail="A schedule needs at least one target role or recipient address — otherwise nobody can receive it.",
        )
    return await reports.create_schedule(
        branch_id=branch,
        saved_report_id=body.savedReportId,
        cadence=body.cadence.upper(),
        hour_local=body.hourLocal,
        day_of_week=body.dayOfWeek,
        day_of_month=body.dayOfMonth,
        channel=body.channel.upper(),
        target_roles=[r.strip().upper() for r in body.targetRoles if r.strip()],
        recipients=[r.strip() for r in body.recipients if r.strip()],
        created_by=user.user_id,
    )


@app.delete("/analytics/schedules/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: str, user: Identity = Depends(require_identity)) -> None:
    if not await reports.delete_schedule(require_branch(user), schedule_id):
        raise HTTPException(status_code=404, detail="No such schedule in this branch.")


@app.post("/analytics/schedules/sweep")
async def sweep_schedules(user: Identity = Depends(require_identity)) -> dict[str, Any]:
    """Run the delivery sweep now — ops trigger for a missed cron, not the cron.

    Super-admin only: the sweep is tenant-wide (every branch's due schedules,
    not just the caller's), so it is an operator action, not a branch one.
    """
    if not user.is_super_admin:
        raise HTTPException(status_code=403, detail="Only a super admin may run the cross-branch delivery sweep.")
    return await reports.sweep_due()


@app.get("/analytics/deliveries")
async def list_deliveries(
    limit: int = Query(25, ge=1, le=200), user: Identity = Depends(require_identity)
) -> list[dict[str, Any]]:
    return await reports.list_deliveries(require_branch(user), limit)


@app.get("/analytics/reports/download/{token}")
async def download_delivery(token: str) -> StreamingResponse:
    """The emailed link. Deliberately UNGATED — the token IS the credential.

    It is 32 bytes of entropy, single-purpose (one stored artifact), hashed at
    rest so the row cannot be replayed from a leak, and expires. The gateway
    keeps this path public for exactly this reason: a parent-side inbox has no
    session, and demanding one would make the link useless. Downloads are
    counted, and an expired-but-not-yet-purged row answers 410 rather than 200.
    """
    row = await reports.get_delivery_by_token(token)
    if row is None:
        raise HTTPException(status_code=404, detail="This report link is not valid.")
    expires_at = row["expiresAt"]
    if isinstance(expires_at, datetime) and expires_at < datetime.now():
        raise HTTPException(status_code=410, detail="This report link has expired. Ask for a fresh run of the report.")
    await reports.mark_downloaded(str(row["id"]))
    return _artifact(bytes(row["artifact"]), str(row["fileName"]), str(row["format"]))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT_ANALYTICS_SERVICE", "5001")))
