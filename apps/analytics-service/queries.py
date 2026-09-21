# ──────────────────────────────────────────────
# Real analytics queries (Phase 7.1) — every query branch-scoped by the
# verified assertion's branchId. SUPER_ADMINs may pass ?branchId= to compare
# branches; everyone else is pinned to their own.
#
# The old stub returned hardcoded numbers ("total_students = 1250"). These are
# the same dashboards against the real tenant schema. Soft-deleted rows are
# excluded everywhere (`deletedAt IS NULL`).
# ──────────────────────────────────────────────

from typing import Any, Optional

try:  # package mode
    from . import db, scoring
except ImportError:  # direct mode: python main.py from this directory
    import db  # type: ignore[no-redef]
    import scoring  # type: ignore[no-redef]

# Day-of-week ordering that survives internationalization: Postgres
# `to_char(date, 'Dy')` is locale-dependent, so order by date, not by name.
DOW_ORDER = "array_position(ARRAY['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'], day)"


async def dashboard(branch_id: str) -> dict[str, Any]:
    """Top-line stats for one branch — every number from a real count."""
    row = await db.fetchrow(
        """
        SELECT
          (SELECT count(*) FROM student_enrollments se
            WHERE se."branchId" = $1 AND se.status = 'ENROLLED'
              AND se."toDate" IS NULL
              AND se."academicYearId" IN (
                SELECT id FROM academic_years
                 WHERE "branchId" = $1 AND "isCurrent")) AS total_students,
          (SELECT count(*) FROM staff
            WHERE "branchId" = $1 AND "deletedAt" IS NULL AND "isActive") AS total_staff,
          (SELECT coalesce(sum(p."amount"), 0) FROM payments p
            WHERE p."branchId" = $1 AND p.status = 'SUCCESS') AS total_revenue,
          (SELECT coalesce(sum(i."totalAmount" - i."paidAmount"), 0) FROM invoices i
            WHERE i."branchId" = $1 AND i."deletedAt" IS NULL
              AND i.status IN ('PARTIALLY_PAID', 'ISSUED', 'OVERDUE')) AS pending_fees,
          (SELECT coalesce(round(
              100.0 * count(*) FILTER (WHERE ar.status = 'PRESENT')
                    / nullif(count(*), 0), 1), 0)
             FROM attendance_records ar
             JOIN attendance_sessions asn ON asn.id = ar."sessionId"
            WHERE asn."branchId" = $1
              AND asn.date >= date_trunc('month', current_date)) AS attendance_rate,
          (SELECT count(*) FROM students s
            WHERE s."branchId" = $1 AND s."deletedAt" IS NULL
              AND s."admissionDate" >= date_trunc('month', current_date)) AS new_admissions_this_month
        """,
        branch_id,
    )
    return dict(row) if row else {}


async def enrollment_trend(branch_id: str, months: int = 12) -> list[dict[str, Any]]:
    """Students admitted per month over the trailing window."""
    rows = await db.fetch(
        """
        SELECT to_char(m, 'YYYY-MM') AS month,
               count(s.id) AS admissions
          FROM generate_series(date_trunc('month', current_date) - make_interval(months => $2 - 1),
                               date_trunc('month', current_date), interval '1 month') AS m
          LEFT JOIN students s
            ON date_trunc('month', s."admissionDate") = m
           AND s."deletedAt" IS NULL AND s."branchId" = $1
         WHERE s.id IS NOT NULL
            OR m >= (SELECT min(date_trunc('month', "createdAt")) FROM students
                      WHERE "branchId" = $1)
         GROUP BY m ORDER BY m
        """,
        branch_id,
        months,
    )
    return [dict(r) for r in rows]


async def attendance_heatmap(branch_id: str, days: int = 30) -> list[dict[str, Any]]:
    """Daily present/absent/late/leave counts + rate for the heatmap."""
    rows = await db.fetch(
        """
        SELECT asn.date,
               count(*) FILTER (WHERE ar.status = 'PRESENT') AS present,
               count(*) FILTER (WHERE ar.status = 'ABSENT') AS absent,
               count(*) FILTER (WHERE ar.status = 'LATE') AS late,
               count(*) FILTER (WHERE ar.status = 'ON_LEAVE') AS on_leave,
               coalesce(round(
                   100.0 * count(*) FILTER (WHERE ar.status = 'PRESENT')
                         / nullif(count(*), 0), 1), 0) AS attendance_rate
          FROM attendance_sessions asn
          JOIN attendance_records ar ON ar."sessionId" = asn.id
         WHERE asn."branchId" = $1
           AND asn.date > current_date - make_interval(days => $2)
         GROUP BY asn.date
         ORDER BY asn.date
        """,
        branch_id,
        days,
    )
    return [dict(r) for r in rows]


async def fee_funnel(branch_id: str, academic_year_id: Optional[str] = None) -> dict[str, Any]:
    """Fee collection funnel: invoiced → collected → pending, per status."""
    year_clause = "AND i.\"academicYearId\" = $2" if academic_year_id else ""
    args: tuple[Any, ...] = (branch_id, academic_year_id) if academic_year_id else (branch_id,)
    rows = await db.fetch(
        f"""
        SELECT status,
               count(*) AS invoices,
               coalesce(sum("totalAmount"), 0) AS invoiced,
               coalesce(sum("paidAmount"), 0) AS collected,
               coalesce(sum("totalAmount" - "paidAmount"), 0) AS outstanding
          FROM invoices i
         WHERE i."branchId" = $1 AND i."deletedAt" IS NULL {year_clause}
         GROUP BY status
         ORDER BY status
        """,
        *args,
    )
    by_status = {r["status"]: dict(r) for r in rows}
    total_invoiced = float(sum(r["invoiced"] for r in by_status.values()))
    total_collected = float(sum(r["collected"] for r in by_status.values()))
    rate = round(100.0 * total_collected / total_invoiced, 1) if total_invoiced else 0
    return {"byStatus": by_status, "totals": {"invoiced": total_invoiced, "collected": total_collected, "collectionRate": rate}}


async def performance_distribution(branch_id: str) -> list[dict[str, Any]]:
    """Grade distribution across PUBLISHED exam results, per subject."""
    rows = await db.fetch(
        """
        SELECT sub.name AS subject,
               count(*) FILTER (WHERE er.grade = 'A1') AS a1,
               count(*) FILTER (WHERE er.grade IN ('A2','B1')) AS b_band,
               count(*) FILTER (WHERE er.grade IN ('B2','C1','C2')) AS c_band,
               count(*) FILTER (WHERE er.grade IN ('D','E1','E2')) AS d_band
          FROM exam_results er
          JOIN exam_subjects es ON es.id = er."examSubjectId"
          JOIN examinations ex ON ex.id = es."examinationId"
          JOIN subjects sub ON sub.id = es."subjectId"
         WHERE ex."branchId" = $1 AND ex."publishedAt" IS NOT NULL AND NOT er."isAbsent" AND NOT er."isExempt"
         GROUP BY sub.name
         ORDER BY sub.name
        """,
        branch_id,
    )
    return [dict(r) for r in rows]


async def teacher_workload(branch_id: str) -> list[dict[str, Any]]:
    """Periods per week per teacher from the live timetable."""
    rows = await db.fetch(
        """
        SELECT st."firstName" || ' ' || st."lastName" AS teacher,
               st."employeeId",
               count(ts.id) AS periods_per_week,
               count(DISTINCT ts.day) AS teaching_days,
               count(DISTINCT s2.id) AS subjects
          FROM staff st
          LEFT JOIN timetable_slots ts ON ts."staffId" = st.id
          LEFT JOIN subjects s2 ON s2.id = ts."subjectId"
         WHERE st."branchId" = $1 AND st."deletedAt" IS NULL AND st."isActive"
         GROUP BY st.id, teacher, st."employeeId"
         ORDER BY periods_per_week DESC
        """,
        branch_id,
    )
    return [dict(r) for r in rows]


async def branch_comparison(branch_id: str) -> list[dict[str, Any]]:
    """The management-office view: every branch of the caller's school side by side.

    The school is derived from the caller's own branch — the access-token
    chain carries branchId but not schoolId, so we resolve Branch.schoolId
    here. Gate 7 requires this to render in under 2s for a 3-branch tenant —
    one query, no N+1.
    """
    rows = await db.fetch(
        """
        WITH my_school AS (
          SELECT "schoolId" FROM branches WHERE id = $1
        )
        SELECT b.id AS branch_id,
               b.name AS branch,
               (SELECT count(*) FROM student_enrollments se
                 WHERE se."branchId" = b.id AND se.status = 'ENROLLED'
                   AND se."toDate" IS NULL
                   AND se."academicYearId" IN (
                     SELECT id FROM academic_years
                      WHERE "branchId" = b.id AND "isCurrent")) AS students,
               (SELECT count(*) FROM staff st
                 WHERE st."branchId" = b.id AND st."deletedAt" IS NULL AND st."isActive") AS staff,
               (SELECT coalesce(sum(p."amount"), 0) FROM payments p
                 WHERE p."branchId" = b.id AND p.status = 'SUCCESS') AS revenue,
               (SELECT coalesce(sum(i."totalAmount" - i."paidAmount"), 0) FROM invoices i
                 WHERE i."branchId" = b.id AND i."deletedAt" IS NULL
                   AND i.status IN ('PARTIALLY_PAID', 'ISSUED', 'OVERDUE')) AS pending_fees,
               (SELECT coalesce(round(
                   100.0 * count(*) FILTER (WHERE ar.status = 'PRESENT')
                         / nullif(count(*), 0), 1), 0)
                  FROM attendance_records ar
                  JOIN attendance_sessions asn ON asn.id = ar."sessionId"
                 WHERE asn."branchId" = b.id
                   AND asn.date >= current_date - interval '30 days') AS attendance_rate_30d
          FROM branches b, my_school ms
         WHERE b."schoolId" = ms."schoolId" AND b."isActive"
         ORDER BY b.name
        """,
        branch_id,
    )
    return [dict(r) for r in rows]


async def at_risk_students(
    branch_id: str, limit: int = 50, threshold_mode: str = "absolute"
) -> list[dict[str, Any]]:
    """Ranked at-risk list WITH reasons — never a black-box score (§7.2).

    Three transparent signals, each contributing reasons:
      • attendance rate over the last 30 days (school-window, not lifetime)
      • average percentage on PUBLISHED exams
      • outstanding fees (any non-paid invoice)

    Default thresholds are ABSOLUTE — the regulatory lines (75% CBSE attendance
    eligibility, 50% failing-trend marks, floored criticals at 60%/33%). When
    the branch is healthy these correctly flag almost nobody; an empty list is
    the right answer, not a failure. thresholdMode="branch-relative" switches
    to the Gate-7 recalibration lens (median = at-risk, p10 = critical, same
    floors) — recall-oriented, for peer-comparison watch lists. The Gate-7 A/B
    measured the trade-off: recall 0.025 → 0.65, precision at/below the base
    rate on synthetic data (docs/ops/gate-7-evidence.md).

    Membership and ordering come from scoring.py (score_student / rank_key),
    not SQL — the live list and the held-out validation must not merely use
    the same numbers, they must run the same code path. The query returns the
    whole scored cohort plus the branch's distribution; Python filters, ranks
    and cuts to `limit`.
    """
    relative = threshold_mode != "absolute"
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
          SELECT i."studentId",
                 sum(i."totalAmount" - i."paidAmount") AS outstanding,
                 count(*) AS unpaid_invoices
            FROM invoices i
           WHERE i."branchId" = $1 AND i."deletedAt" IS NULL
             AND i.status IN ('PARTIALLY_PAID', 'ISSUED', 'OVERDUE')
           GROUP BY i."studentId"
        ),
        -- The branch's own distribution, from the same window the rows see:
        -- median becomes the at-risk line, 10th percentile the critical line.
        -- percentile_cont interpolates; with hundreds of students it is stable.
        dist AS (
          SELECT
            percentile_cont(0.50) WITHIN GROUP (ORDER BY a.attendance_rate) AS att_p50,
            percentile_cont(0.10) WITHIN GROUP (ORDER BY a.attendance_rate) AS att_p10,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY m.avg_pct)         AS marks_p50,
            percentile_cont(0.10) WITHIN GROUP (ORDER BY m.avg_pct)         AS marks_p10
          FROM (SELECT attendance_rate FROM att WHERE attendance_rate IS NOT NULL) a
          CROSS JOIN (SELECT avg_pct FROM marks WHERE avg_pct IS NOT NULL) m
        )
        SELECT s.id AS student_id,
               s."firstName" || ' ' || s."lastName" AS student_name,
               s."admissionNo",
               cls.name || ' ' || sec.name AS class_section,
               att.attendance_rate,
               att.absences,
               marks.avg_pct AS average_marks_pct,
               fees.outstanding,
               fees.unpaid_invoices,
               dist.att_p50, dist.att_p10, dist.marks_p50, dist.marks_p10
          FROM dist
          CROSS JOIN students s
          JOIN student_enrollments se ON se."studentId" = s.id
               AND se."branchId" = $1 AND se.status = 'ENROLLED' AND se."toDate" IS NULL
               AND se."academicYearId" IN (
                 SELECT id FROM academic_years
                  WHERE "branchId" = $1 AND "isCurrent")
          JOIN classes cls ON cls.id = se."classId"
          LEFT JOIN sections sec ON sec.id = se."sectionId"
          LEFT JOIN att ON att."studentId" = s.id
          LEFT JOIN marks ON marks."studentId" = s.id
          LEFT JOIN fees ON fees."studentId" = s.id
        """,
        branch_id,
    )
    if rows:
        first = rows[0]
        thresholds = (
            scoring.Thresholds.branch_relative(
                attendance_p50=first["att_p50"],
                attendance_p10=first["att_p10"],
                marks_p50=first["marks_p50"],
                marks_p10=first["marks_p10"],
            )
            if relative
            else scoring.Thresholds.absolute()
        )
    else:
        thresholds = scoring.Thresholds.absolute()

    out: list[dict[str, Any]] = []
    for r in rows:
        # Thresholds and wording live in scoring.py — the same function the
        # held-out validation uses, so the ranked list a principal sees and the
        # model that was back-tested are provably the same rule set.
        level, reasons, _critical = scoring.score_student(
            attendance_rate=r["attendance_rate"],
            average_marks_pct=r["average_marks_pct"],
            fee_outstanding=r["outstanding"],
            unpaid_invoices=int(r["unpaid_invoices"] or 0),
            absences=int(r["absences"] or 0),
            thresholds=thresholds,
        )
        if not reasons:
            continue  # not at risk under these thresholds — off the list
        out.append({
            "studentId": r["student_id"],
            "studentName": r["student_name"],
            "admissionNo": r["admissionNo"],
            "class": r["class_section"],
            "attendanceRate": float(r["attendance_rate"]) if r["attendance_rate"] is not None else None,
            "averageMarksPct": float(r["average_marks_pct"]) if r["average_marks_pct"] is not None else None,
            "feeOutstanding": float(r["outstanding"] or 0),
            "riskLevel": level,
            "reasons": reasons,
        })
    out.sort(key=lambda s: scoring.rank_key(
        attendance_rate=s["attendanceRate"],
        average_marks_pct=s["averageMarksPct"],
        fee_outstanding=s["feeOutstanding"],
        student_name=str(s["studentName"]),
        thresholds=thresholds,
    ))
    return out[:limit]


async def at_risk_thresholds(branch_id: str) -> dict[str, Any]:
    """The thresholds the at-risk list is scored with, for API exposure.

    Transparency is the product promise (§7.2): a principal can ask what the
    lines are and where they came from without reading code.
    """
    row = await db.fetchrow(
        """
        WITH att AS (
          SELECT ar."studentId",
                 round(100.0 * count(*) FILTER (WHERE ar.status = 'PRESENT')
                       / nullif(count(*), 0), 1) AS attendance_rate
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
        )
        SELECT
          (SELECT count(*) FROM att WHERE attendance_rate IS NOT NULL) AS att_n,
          (SELECT count(*) FROM marks WHERE avg_pct IS NOT NULL)       AS marks_n,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY a.attendance_rate) AS att_p50,
          percentile_cont(0.10) WITHIN GROUP (ORDER BY a.attendance_rate) AS att_p10,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY m.avg_pct)         AS marks_p50,
          percentile_cont(0.10) WITHIN GROUP (ORDER BY m.avg_pct)         AS marks_p10
        FROM (SELECT attendance_rate FROM att WHERE attendance_rate IS NOT NULL) a
        CROSS JOIN (SELECT avg_pct FROM marks WHERE avg_pct IS NOT NULL) m
        """,
        branch_id,
    )
    if row is None or (int(row["att_n"] or 0) == 0 and int(row["marks_n"] or 0) == 0):
        thresholds = scoring.Thresholds.absolute()
        return {**thresholds.describe(), "basis": {"note": "No branch data yet — absolute defaults."}}
    thresholds = scoring.Thresholds.branch_relative(
        attendance_p50=row["att_p50"],
        attendance_p10=row["att_p10"],
        marks_p50=row["marks_p50"],
        marks_p10=row["marks_p10"],
    )
    return {
        **thresholds.describe(),
        "basis": {
            "attendanceStudents": int(row["att_n"] or 0),
            "marksStudents": int(row["marks_n"] or 0),
            "attendanceMedian": _r1(row["att_p50"]),
            "attendanceP10": _r1(row["att_p10"]),
            "marksMedian": _r1(row["marks_p50"]),
            "marksP10": _r1(row["marks_p10"]),
            "rule": "at-risk = median, critical = 10th percentile, floored at 60% attendance / 33% marks",
        },
    }


def _r1(v: Any) -> Optional[float]:
    return round(float(v), 1) if v is not None else None








async def parent_app_adoption(branch_id: str) -> dict[str, Any]:
    """§14.2: parent-app adoption — "this is where pilots visibly succeed or
    fail. Aim for >70% of parents installed within 30 days, and measure it."

    A parent counts as adopted when at least one of their children's guardians
    has an ACTIVE push device registered (a registered FCM token is the
    closest proxy for "installed and opened"; the registry upserts on every
    app start). Per-guardian, not per-user: a family shares one phone.
    """
    row = await db.fetchrow(
        """
        WITH enrolled AS (
          SELECT se."studentId"
            FROM student_enrollments se
           WHERE se."branchId" = $1 AND se.status = 'ENROLLED'
             AND se."toDate" IS NULL
             AND se."academicYearId" IN (
               SELECT id FROM academic_years
                WHERE "branchId" = $1 AND "isCurrent")
        ),
        families AS (
          SELECT DISTINCT sg."guardianId"
            FROM enrolled e
            JOIN student_guardians sg ON sg."studentId" = e."studentId"
           WHERE sg."receivesComms"
        ),
        adopted AS (
          SELECT DISTINCT dt."userId"
            FROM device_tokens dt
            JOIN users u ON u.id = dt."userId"
           WHERE dt."isActive" AND u."deletedAt" IS NULL
             AND u.email NOT LIKE '%@parent.school-erp.local'
        )
        SELECT
          (SELECT count(*) FROM families)::int AS total_families,
          (SELECT count(*) FROM families f
            WHERE f."guardianId" IN (
              SELECT g."userId" FROM guardians g
               WHERE g."userId" IS NOT NULL
                 AND g."userId" IN (SELECT "userId" FROM adopted)))::int AS adopted_families
        """,
        branch_id,
    )
    total = row["total_families"] if row else 0
    adopted = row["adopted_families"] if row else 0
    return {
        "totalFamilies": total,
        "adoptedFamilies": adopted,
        "rate": round(100.0 * adopted / total, 1) if total else None,
        "target": 70.0,
    }
