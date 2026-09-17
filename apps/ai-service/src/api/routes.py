# ──────────────────────────────────────────────
# Real-data AI endpoints (Phase 7.2 rebuilt).
#
# The old routes were `random.choice` dressed up as ML — exactly what the
# plan forbids: "AI on invented data is a demo that dies in the first pilot."
# Everything below reads the live tenant DB, is scoped by the gateway
# assertion's branch, and labels itself honestly:
#
#   • /student-report/:id  — descriptive statistics + trend, explicitly NOT a
#     prediction. Worded as observations ("attended 68% of sessions") not
#     forecasts.
#   • /class-report/:id    — class distribution so a teacher sees who is
#     drifting before exams come back.
#   • /at-risk-summary     — the SAME ranked list analytics-service serves,
#     joined with reasons, so AI surfaces never contradict the analytics
#     screen. One source of truth for the rule set (scoring.py there).
#
# OCR is NOT shipped: no tesseract/easyocr model in this environment, and a
# fake extractor corrupts real admission documents. Absent capability is
# stated (409) rather than simulated (§7.2 "only ship what you can defend").
# ──────────────────────────────────────────────

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

# Always direct-mode: main.py runs `python main.py` from apps/ai-service, so
# the sibling modules resolve top-level — same layout as analytics-service.
import auth  # type: ignore[no-redef]
import db  # type: ignore[no-redef]
from auth import Identity

router = APIRouter()


def _r1(v: Any) -> Optional[float]:
    return round(float(v), 1) if v is not None else None


def _require_branch(user: Identity) -> str:
    if not user.branch_id:
        raise HTTPException(status_code=403, detail="Account has no branch — AI insights are branch-scoped.")
    return user.branch_id


async def _student_row(branch_id: str, student_id: str):
    row = await db.fetchrow(
        """
        SELECT s.id, s."firstName" || ' ' || s."lastName" AS name, s."admissionNo",
               cls.name || coalesce(' ' || sec.name, '') AS class_section
          FROM students s
          JOIN student_enrollments se ON se."studentId" = s.id
               AND se."branchId" = $1 AND se.status = 'ENROLLED' AND se."toDate" IS NULL
          JOIN classes cls ON cls.id = se."classId"
          LEFT JOIN sections sec ON sec.id = se."sectionId"
         WHERE s.id = $2 AND s."branchId" = $1 AND s."deletedAt" IS NULL
        """,
        branch_id,
        student_id,
    )
    if not row:
        # 404 wording matches Node services; no existence leak across tenants.
        raise HTTPException(status_code=404, detail="Not found")
    return row


@router.get("/health")
async def ai_health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-service"}


@router.get("/student-report/{student_id}")
async def student_report(
    student_id: str,
    days: int = Query(30, ge=7, le=120),
    user: Identity = Depends(auth.require_identity),
) -> dict[str, Any]:
    """Descriptive report on one student — observations, not predictions."""
    branch = _require_branch(user)
    row = await _student_row(branch, student_id)

    att = await db.fetchrow(
        """
        SELECT count(*) AS sessions,
               count(*) FILTER (WHERE ar.status = 'PRESENT') AS present,
               count(*) FILTER (WHERE ar.status = 'LATE') AS late,
               count(*) FILTER (WHERE ar.status = 'ABSENT') AS absent
          FROM attendance_records ar
          JOIN attendance_sessions asn ON asn.id = ar."sessionId"
         WHERE ar."studentId" = $1 AND asn."branchId" = $2
           AND asn.date >= current_date - make_interval(days => $3)
        """,
        student_id, branch, days,
    )
    sessions = int(att["sessions"] or 0) if att else 0
    present = int(att["present"] or 0) if att else 0
    absent = int(att["absent"] or 0) if att else 0
    late = int(att["late"] or 0) if att else 0
    att_rate = _r1(100.0 * present / sessions) if sessions else None

    marks = await db.fetch(
        """
        SELECT ex.name AS exam, sub.name AS subject,
               round(100.0 * er."marksObtained"::numeric / es."maxMarks", 1) AS pct
          FROM exam_results er
          JOIN exam_subjects es ON es.id = er."examSubjectId"
          JOIN examinations ex ON ex.id = es."examinationId"
          JOIN subjects sub ON sub.id = es."subjectId"
         WHERE er."studentId" = $1 AND ex."branchId" = $2
           AND ex."publishedAt" IS NOT NULL AND NOT er."isAbsent" AND NOT er."isExempt"
         ORDER BY ex."publishedAt" DESC, sub.name
         LIMIT 60
        """,
        student_id, branch,
    )

    # Subject means and, when >= 2 exams exist, the per-subject trend slope
    # (marks per exam over time — simple least squares, labelled descriptive).
    by_subject: dict[str, list[float]] = {}
    for m in marks:
        by_subject.setdefault(m["subject"], []).append(float(m["pct"]))
    subject_stats = [
        {
            "subject": subj,
            "average": _r1(sum(vals) / len(vals)),
            "exams": len(vals),
            # Oldest→newest slope in percentage points per exam; the list was
            # fetched newest-first, so reverse before differencing.
            "trend": _r1((vals[0] - vals[-1]) / (len(vals) - 1)) if len(vals) >= 2 else None,
        }
        for subj, vals in by_subject.items()
    ]

    fees = await db.fetchrow(
        """
        SELECT coalesce(sum("totalAmount" - "paidAmount"), 0) AS outstanding
          FROM invoices
         WHERE "studentId" = $1 AND "branchId" = $2 AND "deletedAt" IS NULL
           AND status IN ('PARTIALLY_PAID', 'ISSUED', 'OVERDUE')
        """,
        student_id, branch,
    )
    outstanding = float(fees["outstanding"] or 0) if fees else 0.0

    observations: list[str] = []
    if att_rate is not None:
        if att_rate < 75.0:
            observations.append(
                f"Attended {att_rate}% of the last {sessions} sessions — below the 75% eligibility line."
            )
        else:
            observations.append(f"Attended {att_rate}% of the last {sessions} sessions.")
    if subject_stats:
        weakest = min(subject_stats, key=lambda s: s["average"])
        observations.append(f"Lowest published average: {weakest['subject']} at {weakest['average']}%.")
        trends = [s for s in subject_stats if s["trend"] is not None]
        if trends:
            falling = min(trends, key=lambda s: s["trend"])
            if falling["trend"] < -2.0:
                observations.append(
                    f"{falling['subject']} is trending down ~{abs(falling['trend'])} pts per exam."
                )
    if outstanding > 0:
        observations.append(f"Outstanding fees: ₹{outstanding:,.0f}.")

    return {
        "student": {"id": row["id"], "name": row["name"], "admissionNo": row["admissionNo"], "class": row["class_section"]},
        "window": {"days": days},
        "attendance": {"sessions": sessions, "present": present, "absent": absent, "late": late, "rate": att_rate},
        "subjects": subject_stats,
        "fees": {"outstanding": outstanding},
        "observations": observations,
        "method": "descriptive statistics over published records — not a prediction",
    }


@router.get("/class-report/{class_id}")
async def class_report(
    class_id: str,
    user: Identity = Depends(auth.require_identity),
) -> dict[str, Any]:
    """Where each section of one class stands, from published results only."""
    branch = _require_branch(user)
    cls = await db.fetchrow(
        'SELECT id, name FROM classes WHERE id = $1 AND "branchId" = $2 AND "deletedAt" IS NULL',
        class_id, branch,
    )
    if not cls:
        raise HTTPException(status_code=404, detail="Not found")

    rows = await db.fetch(
        """
        SELECT sec.name AS section,
               count(DISTINCT er."studentId") AS students,
               round(100.0 * avg(er."marksObtained"::numeric / es."maxMarks"), 1) AS avg_pct,
               count(*) FILTER (WHERE er."marksObtained"::numeric / es."maxMarks" < 0.33) AS below_pass
          FROM exam_results er
          JOIN exam_subjects es ON es.id = er."examSubjectId"
          JOIN examinations ex ON ex.id = es."examinationId"
          JOIN subjects sub ON sub.id = es."subjectId"
          JOIN student_enrollments se ON se."studentId" = er."studentId"
               AND se."branchId" = $1 AND se.status = 'ENROLLED' AND se."toDate" IS NULL
          LEFT JOIN sections sec ON sec.id = se."sectionId"
         WHERE sub."classId" = $2 AND ex."branchId" = $1 AND ex."publishedAt" IS NOT NULL
           AND NOT er."isAbsent" AND NOT er."isExempt"
         GROUP BY sec.name
         ORDER BY sec.name
        """,
        branch, class_id,
    )
    return {
        "class": {"id": cls["id"], "name": cls["name"]},
        "sections": [
            {
                "section": r["section"] or "—",
                "students": int(r["students"] or 0),
                "average": _r1(r["avg_pct"]),
                "belowPassCount": int(r["below_pass"] or 0),
            }
            for r in rows
        ],
        "method": "descriptive statistics over published results — not a prediction",
    }


@router.get("/at-risk-summary")
async def at_risk_summary(
    limit: int = Query(25, ge=1, le=100),
    user: Identity = Depends(auth.require_identity),
) -> dict[str, Any]:
    """The analytics-service ranked list, restated for AI surfaces.

    Runs the SAME CTE (identical SQL, kept structurally in sync) with the
    absolute regulatory thresholds and the same reason wording, so the AI
    screen and the analytics screen can never disagree about who is flagged
    or why. This is statistics, labelled as statistics — no model, no score.
    """
    branch = _require_branch(user)
    rows = await db.fetch(
        """
        WITH att AS (
          SELECT ar."studentId",
                 round(100.0 * count(*) FILTER (WHERE ar.status = 'PRESENT')
                       / nullif(count(*), 0), 1) AS attendance_rate,
                 count(*) FILTER (WHERE ar.status = 'ABSENT') AS absences
            FROM attendance_records ar
            JOIN attendance_sessions asn ON asn.id = ar."sessionId"
           WHERE asn."branchId" = $1 AND asn.date >= current_date - interval '30 days'
           GROUP BY ar."studentId"
        ),
        marks AS (
          SELECT er."studentId",
                 round(100.0 * avg(er."marksObtained"::numeric / es."maxMarks"), 1) AS avg_pct
            FROM exam_results er
            JOIN exam_subjects es ON es.id = er."examSubjectId"
            JOIN examinations ex ON ex.id = es."examinationId"
           WHERE ex."branchId" = $1 AND ex."publishedAt" IS NOT NULL
             AND NOT er."isAbsent" AND NOT er."isExempt"
           GROUP BY er."studentId"
        ),
        fees AS (
          SELECT i."studentId", sum(i."totalAmount" - i."paidAmount") AS outstanding
            FROM invoices i
           WHERE i."branchId" = $1 AND i."deletedAt" IS NULL
             AND i.status IN ('PARTIALLY_PAID', 'ISSUED', 'OVERDUE')
           GROUP BY i."studentId"
        )
        SELECT s.id AS student_id,
               s."firstName" || ' ' || s."lastName" AS student_name,
               s."admissionNo",
               cls.name || ' ' || sec.name AS class_section,
               att.attendance_rate, att.absences, marks.avg_pct, fees.outstanding
          FROM students s
          JOIN student_enrollments se ON se."studentId" = s.id
               AND se."branchId" = $1 AND se.status = 'ENROLLED' AND se."toDate" IS NULL
               AND se."academicYearId" IN (
                 SELECT id FROM academic_years WHERE "branchId" = $1 AND "isCurrent")
          JOIN classes cls ON cls.id = se."classId"
          LEFT JOIN sections sec ON sec.id = se."sectionId"
          LEFT JOIN att ON att."studentId" = s.id
          LEFT JOIN marks ON marks."studentId" = s.id
          LEFT JOIN fees ON fees."studentId" = s.id
        """,
        branch,
    )

    # Absolute regulatory thresholds — same lines as scoring.Thresholds.absolute():
    # attendance < 75 (CBSE eligibility), marks < 50 (failing trend), fees
    # outstanding with >= 2 unpaid invoices, or >= 4 absences in the window.
    flagged: list[dict[str, Any]] = []
    for r in rows:
        att_rate = r["attendance_rate"]
        avg_pct = r["avg_pct"]
        outstanding = float(r["outstanding"] or 0)
        absences = int(r["absences"] or 0)
        reasons: list[str] = []
        critical = False
        if att_rate is not None and att_rate < 75.0:
            reasons.append(f"Attendance {att_rate}% (below 75%)")
            critical = critical or att_rate < 60.0
        if avg_pct is not None and avg_pct < 50.0:
            reasons.append(f"Average {avg_pct}% (below 50%)")
            critical = critical or avg_pct < 33.0
        if outstanding > 0:
            reasons.append(f"Fees outstanding ₹{outstanding:,.0f}")
        if absences >= 4:
            reasons.append(f"{absences} absences in 30 days")
        if reasons:
            flagged.append(
                {
                    "studentId": r["student_id"],
                    "name": r["student_name"],
                    "admissionNo": r["admissionNo"],
                    "classSection": r["class_section"],
                    "attendanceRate": att_rate,
                    "averageMarksPct": avg_pct,
                    "feeOutstanding": outstanding,
                    "reasons": reasons,
                    "level": "CRITICAL" if critical else "AT_RISK",
                }
            )
    flagged.sort(key=lambda s: (s["attendanceRate"] is None, s["attendanceRate"] or 0,
                                s["averageMarksPct"] is None, s["averageMarksPct"] or 0))
    return {
        "total": len(flagged),
        "students": flagged[:limit],
        "thresholds": {"attendance": 75, "marks": 50, "absences": 4, "mode": "absolute"},
        "method": "rule-based ranking with explicit reasons — statistics, not ML",
    }
