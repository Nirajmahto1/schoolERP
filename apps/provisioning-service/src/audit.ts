// ──────────────────────────────────────────────
// Control-plane audit log helper (BUILD_PLAN 1.1)
// Every mutating platform action records actor + action + payload + tenant.
// ──────────────────────────────────────────────

import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';

export function audit(
  controlPlane: ControlPlaneClient,
  actor: string,
  action: string,
  tenantId: string | null,
  payload: Record<string, unknown>,
): Promise<unknown> {
  return controlPlane.provisionAudit.create({
    data: {
      actor,
      action,
      tenantId,
      payload: payload as object,
    },
  });
}