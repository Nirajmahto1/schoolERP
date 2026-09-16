# ──────────────────────────────────────────────
# At-risk scoring rules — ONE definition (BUILD_PLAN §7.2)
#
# "Ship it as a ranked list with reasons, never a black-box score."
#
# The live ranked list (queries.at_risk_students) and the held-out validation
# harness (validation.validate_at_risk) both score through THIS module. If the
# two could drift, the validation would be measuring a model nobody ships —
# which is worse than no validation, because it looks like evidence.
#
# There is deliberately no trained weight anywhere: a principal can read every
# threshold below, re-derive every flag by hand, and argue with it. That is the
# product promise — statistics, not a black box.
# ──────────────────────────────────────────────

from __future__ import annotations

from typing import Any, Optional

# Attendance: below critical is a "was not in school" signal; below at-risk is
# the CBSE 75% board-exam eligibility line every Indian school already uses.
ATTENDANCE_CRITICAL = 60.0
ATTENDANCE_AT_RISK = 75.0

# Marks: below critical is the fail band; below at-risk is a failing trend.
MARKS_CRITICAL = 40.0
MARKS_AT_RISK = 50.0


def score_student(
    *,
    attendance_rate: Optional[float],
    average_marks_pct: Optional[float],
    fee_outstanding: Optional[float],
    unpaid_invoices: int = 0,
    absences: int = 0,
    absence_window: str = "30 days",
) -> tuple[str, list[str], int]:
    """(risk level, human reasons, critical-signal count).

    A student is HIGH when two or more signals are critical, MEDIUM otherwise.
    Every returned reason is a sentence a teacher can act on — the levels are
    derived from the count of critical signals, never estimated.
    """
    reasons: list[str] = []
    critical = 0

    rate = _num(attendance_rate)
    avg = _num(average_marks_pct)
    outstanding = _num(fee_outstanding) or 0.0

    if rate is not None and rate < ATTENDANCE_CRITICAL:
        critical += 1
        reasons.append(f"attendance {rate}% (below 60%, {absences} absences in {absence_window})")
    elif rate is not None and rate < ATTENDANCE_AT_RISK:
        reasons.append(f"attendance {rate}% (below 75% threshold)")

    if avg is not None and avg < MARKS_CRITICAL:
        critical += 1
        reasons.append(f"exam average {avg}% (below 40%)")
    elif avg is not None and avg < MARKS_AT_RISK:
        reasons.append(f"exam average {avg}% (below 50%)")

    if outstanding and outstanding > 0:
        reasons.append(f"fee arrears ₹{outstanding:,.0f} across {unpaid_invoices} invoice(s)")

    return ("HIGH" if critical >= 2 else "MEDIUM"), reasons, critical


def rank_key(
    *,
    attendance_rate: Optional[float],
    average_marks_pct: Optional[float],
    fee_outstanding: Optional[float],
    student_name: str,
) -> tuple[int, float, str]:
    """Sort key matching the SQL ordering of the live ranked list.

    Ascending sort gives: most critical signals first, then the worst
    attendance, then name for a stable tie-break. The validation harness ranks
    with this so a top-k cut-off means the same thing here as on the screen.
    """
    rate = _num(attendance_rate)
    avg = _num(average_marks_pct)
    outstanding = _num(fee_outstanding) or 0.0
    signals = 0
    if rate is not None and rate < ATTENDANCE_CRITICAL:
        signals += 1
    if avg is not None and avg < MARKS_CRITICAL:
        signals += 1
    if outstanding > 0:
        signals += 1
    return (-signals, rate if rate is not None else 100.0, student_name)


def _num(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
