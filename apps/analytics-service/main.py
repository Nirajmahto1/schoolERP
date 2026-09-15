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

import io
import os
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

try:  # package mode: uvicorn analytics_service.main:app
    from . import db, queries
    from .auth import Identity, public_key_configured, require_identity
except ImportError:  # direct mode: python main.py from this directory
    import db  # type: ignore[no-redef]
    import queries  # type: ignore[no-redef]
    from auth import Identity, public_key_configured, require_identity  # type: ignore[no-redef]

SERVICE_NAME = "analytics-service"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail-closed is about auth; the DB pool is lazy — the service can boot
    # before Postgres and report /ready 503 until it connects.
    yield
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
    user: Identity = Depends(require_identity),
) -> list[dict[str, Any]]:
    branch = resolve_branch(user, branchId)
    return await queries.at_risk_students(branch, limit)


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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT_ANALYTICS_SERVICE", "5001")))
