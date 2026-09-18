// ──────────────────────────────────────────────
// Leave labels — enum values → human words, shared by the leave screens.
// Unknown values fall back to Title Case so a new type never renders raw.
// ──────────────────────────────────────────────

const LEAVE_TYPES: Record<string, string> = {
  SICK: "Sick Leave",
  CASUAL: "Casual Leave",
  EARNED: "Earned Leave",
  MATERNITY: "Maternity Leave",
  DUTY: "Duty Leave",
  UNPAID: "Unpaid Leave",
};

const STATUS: Record<string, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function leaveTypeLabel(t: string): string {
  if (!t) return "";
  return LEAVE_TYPES[t] ?? titleCase(t);
}

export function statusLabel(s: string): string {
  if (!s) return "";
  return STATUS[s] ?? titleCase(s);
}
