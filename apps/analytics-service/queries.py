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


async def at_risk_students(branch_id: str, limit: int = 50) -> list[dict[str, Any]]:
    """Ranked at-risk list WITH reasons — never a black-box score (§7.2).

    Three transparent signals, each contributing reasons:
      • attendance rate over the last 30 days (school-window, not lifetime)
      • average percentage on PUBLISHED exams
      • outstanding fees (any non-paid invoice)
    Rank = most severe signal first; ties broken by name for stability.
    """
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
        )
        SELECT s.id AS student_id,
               s."firstName" || ' ' || s."lastName" AS student_name,
               s."admissionNo",
               cls.name || ' ' || sec.name AS class_section,
               att.attendance_rate,
               att.absences,
               marks.avg_pct AS average_marks_pct,
               fees.outstanding,
               fees.unpaid_invoices
          FROM students s
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
         WHERE (att.attendance_rate IS NOT NULL AND att.attendance_rate < 75)
            OR (marks.avg_pct IS NOT NULL AND marks.avg_pct < 50)
            OR fees.outstanding > 0
         ORDER BY
           (COALESCE(att.attendance_rate, 100) < 60)::int
         + (COALESCE(marks.avg_pct, 100) < 40)::int
         + (COALESCE(fees.outstanding, 0) > 0)::int DESC,
           COALESCE(att.attendance_rate, 100) ASC,
           student_name
         LIMIT $2
        """,
        branch_id,
        limit,
    )
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
        )
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
    return out
