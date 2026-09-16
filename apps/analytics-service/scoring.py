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
#
# Thresholds come in two modes (Gate-7 evidence, recalibration):
#
#   • ABSOLUTE — the shipped defaults. Fixed lines every Indian school knows:
#     75% attendance (CBSE board-exam eligibility), 50%/40% marks. In a healthy
#     cohort these fire on almost nobody, which the Gate-7 back-test measured
#     as recall 2.5%.
#   • BRANCH-RELATIVE — lines derived from the branch's own feature window:
#     the MEDIAN becomes the at-risk line and the 10TH PERCENTILE the critical
#     line. "Below the middle of this branch" is a comparative statement the
#     principal can still argue with, and it discriminates even when the whole
#     cohort is healthy. Floors keep it honest: a relative line never drops
#     below the regulatory minimum (60% attendance, 33% marks — the pass line),
#     so a branch where everyone is failing still flags only real failure.
# ──────────────────────────────────────────────

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

# Regulatory floors — a threshold may never be more lenient than these.
ATTENDANCE_CRITICAL = 60.0   # "was not in school" line
ATTENDANCE_AT_RISK = 75.0    # CBSE 75% board-exam eligibility line
MARKS_CRITICAL = 40.0        # fail band
MARKS_AT_RISK = 50.0         # failing trend

# Branch-relative derivation: at-risk = median, critical = 10th percentile.
BRANCH_AT_RISK_QUANTILE = 0.50
BRANCH_CRITICAL_QUANTILE = 0.10


@dataclass(frozen=True)
class Thresholds:
    """The four lines score_student/rank_key compare against.

    `mode` describes how they were chosen and is surfaced in API responses —
    a threshold nobody can explain is a black box with extra steps.
    """

    attendance_at_risk: float = ATTENDANCE_AT_RISK
    attendance_critical: float = ATTENDANCE_CRITICAL
    marks_at_risk: float = MARKS_AT_RISK
    marks_critical: float = MARKS_CRITICAL
    mode: str = "absolute"

    @classmethod
    def absolute(cls) -> "Thresholds":
        return cls()

    @classmethod
    def branch_relative(
        cls,
        attendance_p50: Optional[float],
        attendance_p10: Optional[float],
        marks_p50: Optional[float],
        marks_p10: Optional[float],
    ) -> "Thresholds":
        """Derive lines from the branch's own distribution.

        `None` means the branch has no data for that axis at all; that axis
        then keeps its absolute default rather than inventing a line from
        nothing. Floors cap leniency (see module docstring).
        """
        att_risk = _floored(attendance_p50, BRANCH_AT_RISK_QUANTILE, ATTENDANCE_AT_RISK)
        att_crit = _floored(attendance_p10, BRANCH_CRITICAL_QUANTILE, ATTENDANCE_CRITICAL)
        marks_risk = _floored(marks_p50, BRANCH_AT_RISK_QUANTILE, MARKS_AT_RISK)
        marks_crit = _floored(marks_p10, BRANCH_CRITICAL_QUANTILE, MARKS_CRITICAL)
        return cls(
            attendance_at_risk=att_risk,
            attendance_critical=max(att_crit, 0.0),
            marks_at_risk=marks_risk,
            marks_critical=max(marks_crit, 0.0),
            mode="branch-relative",
        )

    def describe(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "attendanceAtRisk": self.attendance_at_risk,
            "attendanceCritical": self.attendance_critical,
            "marksAtRisk": self.marks_at_risk,
            "marksCritical": self.marks_critical,
        }


def _floored(observed: Optional[float], quantile: float, floor: float) -> float:
    """Quantile line, floored at the regulatory minimum. One decimal."""
    if observed is None:
        return floor
    return round(max(float(observed), floor), 1)


def score_student(
    *,
    attendance_rate: Optional[float],
    average_marks_pct: Optional[float],
    fee_outstanding: Optional[float],
    unpaid_invoices: int = 0,
    absences: int = 0,
    absence_window: str = "30 days",
    thresholds: Optional[Thresholds] = None,
) -> tuple[str, list[str], int]:
    """(risk level, human reasons, critical-signal count).

    A student is HIGH when two or more signals are critical, MEDIUM otherwise.
    Every returned reason is a sentence a teacher can act on — the levels are
    derived from the count of critical signals, never estimated.
    """
    thr = thresholds or Thresholds()
    reasons: list[str] = []
    critical = 0

    rate = _num(attendance_rate)
    avg = _num(average_marks_pct)
    outstanding = _num(fee_outstanding) or 0.0

    if rate is not None and rate < thr.attendance_critical:
        critical += 1
        reasons.append(
            f"attendance {rate}% (below {_fmt(thr.attendance_critical)}% critical line, "
            f"{absences} absences in {absence_window})"
        )
    elif rate is not None and rate < thr.attendance_at_risk:
        reasons.append(f"attendance {rate}% (below {_fmt(thr.attendance_at_risk)}% line)")

    if avg is not None and avg < thr.marks_critical:
        critical += 1
        reasons.append(f"exam average {avg}% (below {_fmt(thr.marks_critical)}%)")
    elif avg is not None and avg < thr.marks_at_risk:
        reasons.append(f"exam average {avg}% (below {_fmt(thr.marks_at_risk)}%)")

    if outstanding and outstanding > 0:
        reasons.append(f"fee arrears ₹{outstanding:,.0f} across {unpaid_invoices} invoice(s)")

    return ("HIGH" if critical >= 2 else "MEDIUM"), reasons, critical


def rank_key(
    *,
    attendance_rate: Optional[float],
    average_marks_pct: Optional[float],
    fee_outstanding: Optional[float],
    student_name: str,
    thresholds: Optional[Thresholds] = None,
) -> tuple[int, float, str]:
    """Sort key matching the SQL ordering of the live ranked list.

    Ascending sort gives: most critical signals first, then the worst
    attendance, then name for a stable tie-break. The validation harness ranks
    with this so a top-k cut-off means the same thing here as on the screen.
    """
    thr = thresholds or Thresholds()
    rate = _num(attendance_rate)
    avg = _num(average_marks_pct)
    outstanding = _num(fee_outstanding) or 0.0
    signals = 0
    if rate is not None and rate < thr.attendance_critical:
        signals += 1
    if avg is not None and avg < thr.marks_critical:
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


def _fmt(value: float) -> str:
    """75.0 → '75', 62.5 → '62.5' — threshold lines read like thresholds."""
    return f"{value:g}"
