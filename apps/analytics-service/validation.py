# ──────────────────────────────────────────────
# Held-out validation of the at-risk model (GATE 7)
#
# GATE 7, verbatim: "At-risk model validated against held-out historical data
# with reported precision/recall."
#
# Method — a genuine temporal split, no leakage:
#
#     feature window  [split − 365d, split)   →  what the model may see
#     label window    [split, now]            →  what actually happened
#
# The split defaults to the start of the school's most recent published
# examination, so the model always predicts FORWARD from data that already
# existed when it would have run. Two things differ deliberately from the live
# ranked list, and both differences make the score WORSE, never better:
#
#   • the marks feature is truncated to exams published BEFORE the split. The
#     live list legitimately uses the newest marks — a principal flagging risk
#     today should use today's data — but including the label-window exam in a
#     back-test is leakage, and the resulting precision would be a lie.
#   • fee arrears are only those outstanding on invoices RAISED BEFORE the
#     split. A tenant with no invoice history (a freshly seeded demo) reports
#     0% coverage on that feature instead of quietly scoring "no arrears" for
#     everyone and calling the result validation.
#
# Everything is reported: every label definition, every cut-off, the base rate,
# and the feature coverage. Nothing is selected on the way out. A label with
# too few positives to estimate is reported as exactly that, rather than a
# precision figure computed from three students.
# ──────────────────────────────────────────────

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

try:  # package mode
    from . import db, scoring
except ImportError:  # direct mode: python main.py from this directory
    import db  # type: ignore[no-redef]
    import scoring  # type: ignore[no-redef]

# Below this many positives in the label window, precision/recall are reported
# as descriptive-only. Ten is a judgement call, not statistics: it is the point
# below which "precision 1.00" can mean three students and a coin toss.
MIN_POSITIVES = 10

TOP_K_CUTOFFS = (0.10, 0.20, 0.30)


async def _split_point(branch_id: str, label_from: Optional[datetime]) -> tuple[datetime, list[dict[str, Any]]]:
    """The temporal split, plus the exams that define it (for the report)."""
    if label_from is not None:
        return label_from, await _exams(branch_id, label_from=label_from)

    row = await db.fetchrow(
        """
        SELECT ex.id, ex.name, ex."startDate", ex."publishedAt"
          FROM examinations ex
         WHERE ex."branchId" = $1 AND ex."publishedAt" IS NOT NULL
           AND EXISTS (
                 SELECT 1 FROM exam_subjects es
                   JOIN exam_results er ON er."examSubjectId" = es.id
                  WHERE es."examinationId" = ex.id)
         ORDER BY ex."startDate" DESC
         LIMIT 1
        """,
        branch_id,
    )
    if row is None:
        # No published results to learn from — say so rather than invent a date.
        raise ValueError(
            "No published examination with results exists for this branch, so there is no held-out "
            "history to validate against."
        )
    start = row["startDate"]
    assert isinstance(start, datetime)
    return start, await _exams(branch_id, label_from=start)


async def _exams(branch_id: str, *, label_from: datetime) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """
        SELECT ex.name, ex."startDate", ex."publishedAt",
               (SELECT count(*) FROM exam_subjects es
                  JOIN exam_results er ON er."examSubjectId" = es.id
                 WHERE es."examinationId" = ex.id) AS results
          FROM examinations ex
         WHERE ex."branchId" = $1 AND ex."publishedAt" is not null
         ORDER BY ex."startDate"
        """,
        branch_id,
    )
    out = []
    for r in rows:
        start = r["startDate"]
        when = "label" if isinstance(start, datetime) and start >= label_from else "feature"
        out.append({
            "name": r["name"],
            "startDate": start.date().isoformat() if isinstance(start, datetime) else None,
            "publishedAt": r["publishedAt"].date().isoformat() if isinstance(r["publishedAt"], datetime) else None,
            "results": int(r["results"] or 0),
            "window": when,
        })
    return out


async def _cohort(branch_id: str, feature_from: datetime, split: datetime, now: datetime) -> list[dict[str, Any]]:
    """One row per currently-enrolled student: as-of-split features + outcomes."""
    rows = await db.fetch(
        """
        WITH cohort AS (
          SELECT s.id AS student_id,
                 s."firstName" || ' ' || s."lastName" AS student_name,
                 s."admissionNo"
            FROM students s
            JOIN student_enrollments se ON se."studentId" = s.id
           WHERE s."deletedAt" IS NULL
             AND se."branchId" = $1 AND se.status = 'ENROLLED' AND se."toDate" IS NULL
             AND se."academicYearId" IN (
                   SELECT id FROM academic_years WHERE "branchId" = $1 AND "isCurrent")
        ),
        -- Features: everything the model may see, strictly before the split.
        feat_att AS (
          SELECT ar."studentId" AS student_id,
                 round(100.0 * count(*) FILTER (WHERE ar.status = 'PRESENT') / nullif(count(*), 0), 1) AS attendance_rate,
                 count(*) FILTER (WHERE ar.status = 'ABSENT') AS absences
            FROM attendance_records ar
            JOIN attendance_sessions s ON s.id = ar."sessionId"
           WHERE s."branchId" = $1 AND s.date >= $2 AND s.date < $3
           GROUP BY 1
        ),
        feat_marks AS (
          SELECT er."studentId" AS student_id,
                 round(100.0 * sum(er."marksObtained") / nullif(sum(es."maxMarks"), 0), 1) AS marks_pct
            FROM exam_results er
            JOIN exam_subjects es ON es.id = er."examSubjectId"
            JOIN examinations ex ON ex.id = es."examinationId"
           WHERE ex."branchId" = $1 AND ex."publishedAt" IS NOT NULL AND ex."startDate" < $3
             AND NOT er."isAbsent" AND NOT er."isExempt"
           GROUP BY 1
        ),
        feat_fees AS (
          SELECT i."studentId" AS student_id,
                 sum(i."totalAmount" - i."paidAmount") AS outstanding,
                 count(*) AS unpaid_invoices
            FROM invoices i
           WHERE i."branchId" = $1 AND i."deletedAt" IS NULL
             AND i.status IN ('PARTIALLY_PAID', 'ISSUED', 'OVERDUE')
             AND i."createdAt" < $3
           GROUP BY 1
        ),
        -- Labels: what actually happened afterwards.
        label_marks AS (
          SELECT er."studentId" AS student_id,
                 round(100.0 * sum(er."marksObtained") / nullif(sum(es."maxMarks"), 0), 1) AS marks_pct
            FROM exam_results er
            JOIN exam_subjects es ON es.id = er."examSubjectId"
            JOIN examinations ex ON ex.id = es."examinationId"
           WHERE ex."branchId" = $1 AND ex."publishedAt" IS NOT NULL
             AND ex."startDate" >= $3 AND ex."startDate" <= $4
             AND NOT er."isAbsent" AND NOT er."isExempt"
           GROUP BY 1
        ),
        label_att AS (
          SELECT ar."studentId" AS student_id,
                 round(100.0 * count(*) FILTER (WHERE ar.status = 'PRESENT') / nullif(count(*), 0), 1) AS attendance_rate
            FROM attendance_records ar
            JOIN attendance_sessions s ON s.id = ar."sessionId"
           WHERE s."branchId" = $1 AND s.date >= $3 AND s.date <= $4
           GROUP BY 1
        )
        SELECT c.student_id, c.student_name, c."admissionNo",
               fa.attendance_rate, fa.absences,
               fm.marks_pct,
               ff.outstanding, ff.unpaid_invoices,
               lm.marks_pct AS label_marks_pct,
               la.attendance_rate AS label_attendance_rate
          FROM cohort c
          LEFT JOIN feat_att   fa ON fa.student_id = c.student_id
          LEFT JOIN feat_marks fm ON fm.student_id = c.student_id
          LEFT JOIN feat_fees  ff ON ff.student_id = c.student_id
          LEFT JOIN label_marks lm ON lm.student_id = c.student_id
          LEFT JOIN label_att   la ON la.student_id = c.student_id
        """,
        branch_id,
        feature_from,
        split,
        now,
    )
    return [dict(r) for r in rows]


def _metrics(flagged: set[str], positives: set[str], total: int) -> dict[str, Any]:
    tp = len(flagged & positives)
    fp = len(flagged - positives)
    fn = len(positives - flagged)
    tn = total - tp - fp - fn
    precision = tp / (tp + fp) if (tp + fp) else None
    recall = tp / (tp + fn) if (tp + fn) else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and (precision + recall) > 0
        else None
    )
    prevalence = len(positives) / total if total else 0.0
    lift = precision / prevalence if precision is not None and prevalence > 0 else None
    return {
        "flagged": len(flagged),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": round(precision, 3) if precision is not None else None,
        "recall": round(recall, 3) if recall is not None else None,
        "f1": round(f1, 3) if f1 is not None else None,
        "lift": round(lift, 2) if lift is not None else None,
    }


def _mode(
    *,
    definition: str,
    positives: set[str],
    ranked: list[dict[str, Any]],
    total: int,
) -> dict[str, Any]:
    """All cut-offs for one label definition. No cut-off is selected out."""
    cutoffs: list[dict[str, Any]] = [
        {"rule": "ANY_SIGNAL", "description": "has at least one risk reason (mirrors the live list's membership)", **_metrics({s["studentId"] for s in ranked if s["reasons"]}, positives, total)},
        {"rule": "HIGH", "description": "two or more critical signals", **_metrics({s["studentId"] for s in ranked if s["riskLevel"] == "HIGH"}, positives, total)},
    ]
    for k in TOP_K_CUTOFFS:
        n = max(1, round(total * k))
        cutoffs.append({
            "rule": f"TOP_{int(k * 100)}PCT",
            "description": f"the {n} highest-ranked students of {total}",
            **_metrics({s["studentId"] for s in ranked[:n]}, positives, total),
        })

    prevalence = len(positives) / total if total else 0.0
    estimable = len(positives) >= MIN_POSITIVES
    out: dict[str, Any] = {
        "definition": definition,
        "positives": len(positives),
        "prevalence": round(prevalence, 4),
        "estimable": estimable,
        "cutoffs": cutoffs,
    }
    if not estimable:
        out["reason"] = (
            f"{len(positives)} positive case(s) in the label window — below the {MIN_POSITIVES} needed to "
            "report precision/recall as a finding. The numbers above are descriptive only; treat them as "
            "an indication that this tenant needs more recorded history (or a wider label window), not as "
            "model performance."
        )
    return out


async def validate_at_risk(
    branch_id: str,
    *,
    label_from: Optional[datetime] = None,
    now: Optional[datetime] = None,
    exam_fail_pct: float = 33.0,
    attendance_below: float = 75.0,
    bottom_fraction: float = 0.10,
    feature_days: int = 365,
) -> dict[str, Any]:
    """Back-test the shipped scoring rules. Reads only; writes nothing."""
    now = now or datetime.now()
    split, exams = await _split_point(branch_id, label_from)
    feature_from = split - timedelta(days=feature_days)

    rows = await _cohort(branch_id, feature_from, split, now)
    total = len(rows)

    scored: list[dict[str, Any]] = []
    for r in rows:
        level, reasons, critical = scoring.score_student(
            attendance_rate=r["attendance_rate"],
            average_marks_pct=r["marks_pct"],
            fee_outstanding=r["outstanding"],
            unpaid_invoices=int(r["unpaid_invoices"] or 0),
            absences=int(r["absences"] or 0),
            absence_window=f"{feature_days} days before the split",
        )
        scored.append({
            "studentId": str(r["student_id"]),
            "studentName": r["student_name"],
            "admissionNo": r["admissionNo"],
            "attendanceRate": float(r["attendance_rate"]) if r["attendance_rate"] is not None else None,
            "averageMarksPct": float(r["marks_pct"]) if r["marks_pct"] is not None else None,
            "feeOutstanding": float(r["outstanding"] or 0),
            "riskLevel": level,
            "criticalSignals": critical,
            "reasons": reasons,
            "labelMarksPct": float(r["label_marks_pct"]) if r["label_marks_pct"] is not None else None,
            "labelAttendanceRate": (
                float(r["label_attendance_rate"]) if r["label_attendance_rate"] is not None else None
            ),
        })

    # Identical ordering to the live ranked list.
    scored.sort(key=lambda s: scoring.rank_key(
        attendance_rate=s["attendanceRate"],
        average_marks_pct=s["averageMarksPct"],
        fee_outstanding=s["feeOutstanding"],
        student_name=str(s["studentName"]),
    ))

    with_label_marks = [s for s in scored if s["labelMarksPct"] is not None]
    bottom: set[str] = set()
    if with_label_marks:
        ordered = sorted(with_label_marks, key=lambda s: (s["labelMarksPct"], str(s["studentName"])))
        bottom = {s["studentId"] for s in ordered[: max(1, round(len(ordered) * bottom_fraction))]}

    exam_fail = {s["studentId"] for s in scored if s["labelMarksPct"] is not None and s["labelMarksPct"] < exam_fail_pct}
    attendance_low = {
        s["studentId"]
        for s in scored
        if s["labelAttendanceRate"] is not None and s["labelAttendanceRate"] < attendance_below
    }
    composite = exam_fail | attendance_low | bottom

    modes = {
        "EXAM_FAIL": _mode(
            definition=f"overall mark percentage below {exam_fail_pct}% on an examination published in the label window",
            positives=exam_fail,
            ranked=scored,
            total=total,
        ),
        "EXAM_BOTTOM_DECILE": _mode(
            definition=f"bottom {int(bottom_fraction * 100)}% of the cohort on the label-window examination",
            positives=bottom,
            ranked=scored,
            total=total,
        ),
        "ATTENDANCE_BELOW": _mode(
            definition=f"attendance below {attendance_below}% during the label window",
            positives=attendance_low,
            ranked=scored,
            total=total,
        ),
        "COMPOSITE": _mode(
            definition=(
                f"any of: examination below {exam_fail_pct}%, attendance below {attendance_below}%, "
                f"or bottom {int(bottom_fraction * 100)}% of the label-window examination"
            ),
            positives=composite,
            ranked=scored,
            total=total,
        ),
    }

    coverage = {
        "attendance": round(_share(scored, "attendanceRate"), 3),
        "priorExamMarks": round(_share(scored, "averageMarksPct"), 3),
        "feeArrearsAtSplit": round(_share(scored, "feeOutstanding", truthy=True), 3),
        "labelExamMarks": round(_share(scored, "labelMarksPct"), 3),
        "labelAttendance": round(_share(scored, "labelAttendanceRate"), 3),
    }

    caveats: list[str] = []
    if coverage["feeArrearsAtSplit"] == 0:
        caveats.append(
            "No invoices were raised before the split, so the fee signal is absent from the feature window: "
            "this run validates the attendance + prior-marks rules only. On a tenant with real invoice history "
            "the same harness scores all three signals."
        )
    if not any(m["estimable"] for m in modes.values()):
        caveats.append(
            "No label definition reached the minimum positive count for this tenant, so no precision/recall "
            "figure here should be quoted as model performance. Record a year of real attendance, marks and "
            "invoice history and re-run this endpoint before showing numbers to a principal."
        )
    if not with_label_marks:
        caveats.append("No examination was published inside the label window; exam-based labels are empty.")

    return {
        "branchId": branch_id,
        "generatedAt": now.isoformat(),
        "method": {
            "kind": "temporal hold-out",
            "featureWindow": {"from": feature_from.date().isoformat(), "to": split.date().isoformat()},
            "labelWindow": {"from": split.date().isoformat(), "to": now.date().isoformat()},
            "featureDays": feature_days,
            "leakageGuard": (
                "Marks and arrears features are truncated to before the split; the live ranked list uses the "
                "newest data because it flags risk today, not in hindsight."
            ),
            "scoring": "shared with the live ranked list (scoring.py) — same thresholds, same reasons",
            "minPositives": MIN_POSITIVES,
        },
        "split": {
            "labelFrom": split.isoformat(),
            "examinations": exams,
        },
        "cohort": {"students": total},
        "featureCoverage": coverage,
        "modes": modes,
        "caveats": caveats,
    }


def _share(rows: list[dict[str, Any]], key: str, *, truthy: bool = False) -> float:
    if not rows:
        return 0.0
    if truthy:
        return sum(1 for r in rows if r.get(key)) / len(rows)
    return sum(1 for r in rows if r.get(key) is not None) / len(rows)
