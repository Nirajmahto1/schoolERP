// ──────────────────────────────────────────────
// Fleet usage metering (BUILD_PLAN 4.2.4)
//
// "Usage metering: students, storage, SMS/WhatsApp credits."
//
// The nightly job walks every active tenant's datastore, counts what the
// billing plan prices against, and pushes point-in-time samples into the
// control plane's `usage_records`. Samples — not estimates: every number is
// a real query against the tenant's own database at a moment in time, so
// the reconciliation that flags overage is defensible in a renewal
// conversation.
//
//   students          → active Student rows
//   staff             → active Staff rows
//   storage_bytes     → Σ Document.sizeBytes (soft-deleted excluded)
//   messaging_credits → NotificationLog rows in the trailing month —
//                       message UNITS, matching how schools buy credit
//                       bundles (per-rupee cost lives on the log rows for
//                       the Phase-5 pass-through billing)
//
// One failing tenant never stops the fleet pass: its error is captured in
// the summary and the job moves on.
// ──────────────────────────────────────────────

import { PrismaClient as TenantClient } from '@school-erp/database';
import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { audit } from './audit';
import type { UsageMetric } from './billing';

export interface TenantUsageSample {
  tenantId: string;
  slug: string;
  ok: boolean;
  usage: Partial<Record<UsageMetric, number>>;
  error?: string;
  durationMs: number;
}

export interface FleetMeteringResult {
  ranAt: string;
  tenants: number;
  succeeded: number;
  failed: number;
  samples: TenantUsageSample[];
}

/** How far back the messaging-credit window reaches (trailing month). */
const CREDITS_WINDOW_DAYS = 30;

/**
 * Measure one tenant from its own database and write the samples to the
 * control plane. Returns the collected values (0 when a tenant genuinely
 * has no documents/notifications yet — absence of rows is a real zero).
 */
export async function measureTenant(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  connRef: string,
): Promise<Partial<Record<UsageMetric, number>>> {
  const tenant = new TenantClient({ datasourceUrl: connRef });
  try {
    const since = new Date(Date.now() - CREDITS_WINDOW_DAYS * 86_400_000);

    const [students, staff, storageAgg, creditAgg] = await Promise.all([
      tenant.student.count({ where: { isActive: true } }),
      tenant.staff.count({ where: { isActive: true } }),
      tenant.document.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true } }),
      tenant.notificationLog.aggregate({
        where: { createdAt: { gte: since } },
        _sum: { cost: true },
        _count: true,
      }),
    ]);

    // Credits are message UNITS (schools top up bundles of them); the
    // per-message rupee cost rides on NotificationLog.cost for the Phase-5
    // pass-through. Always an integer — BigInt-safe by construction.
    const credits = creditAgg._count;

    const usage: Partial<Record<UsageMetric, number>> = {
      students,
      staff,
      storage_bytes: Number(storageAgg._sum.sizeBytes ?? 0),
      messaging_credits: credits,
    };

    await Promise.all(
      (Object.entries(usage) as Array<[UsageMetric, number]>).map(([metric, value]) =>
        controlPlane.usageRecord.create({ data: { tenantId, metric, value: BigInt(value) } }),
      ),
    );
    return usage;
  } finally {
    await tenant.$disconnect();
  }
}

/**
 * One fleet pass: every active tenant that has a datastore gets measured.
 * Per-tenant failures are captured, not thrown — a school with a broken
 * database must not stop billing visibility for everyone else.
 */
export async function runFleetMeteringPass(
  controlPlane: ControlPlaneClient,
  opts: { actor?: string } = {},
): Promise<FleetMeteringResult> {
  const started = Date.now();
  const tenants = await controlPlane.tenant.findMany({
    where: { status: { in: ['TRIAL', 'ACTIVE'] }, datastore: { isNot: null } },
    include: { datastore: true },
    orderBy: { slug: 'asc' },
  });

  const samples: TenantUsageSample[] = [];
  for (const t of tenants) {
    const t0 = Date.now();
    if (!t.datastore) continue; // narrowed above, but TS wants it
    try {
      const usage = await measureTenant(controlPlane, t.id, t.datastore.connRef);
      samples.push({ tenantId: t.id, slug: t.slug, ok: true, usage, durationMs: Date.now() - t0 });
    } catch (err) {
      samples.push({
        tenantId: t.id,
        slug: t.slug,
        ok: false,
        usage: {},
        error: (err as Error).message,
        durationMs: Date.now() - t0,
      });
    }
  }

  const result: FleetMeteringResult = {
    ranAt: new Date().toISOString(),
    tenants: samples.length,
    succeeded: samples.filter((s) => s.ok).length,
    failed: samples.filter((s) => !s.ok).length,
    samples,
  };

  // Fleet-level audit event rides on the first tenant (ProvisionAudit.tenantId
  // is a real FK); the full summary is in the payload.
  if (tenants[0]) {
    await audit(controlPlane, opts.actor ?? 'job:metering', 'fleet.metering-pass', tenants[0].id, {
      ranAt: result.ranAt,
      tenants: result.tenants,
      succeeded: result.succeeded,
      failed: result.failed,
      durationMs: Date.now() - started,
      perTenant: samples.map((s) => ({ slug: s.slug, ok: s.ok, ...s.usage })),
    });
  }

  return result;
}
