// ──────────────────────────────────────────────
// Provisioning CLI (BUILD_PLAN 1.2 / 1.4 / 1.5)
//
//   npm run tenant:create -- --slug dps-noida --legal-name "DPS Noida"
//   npm run tenant:status -- --all
//   npm run tenant:suspend -- --tenant-id <id> --reason "non-payment"
//   npm run tenant:resume -- --tenant-id <id>
//   npm run tenant:delete -- --tenant-id <id> --retention-days 30
//   npm run tenant:hard-delete -- --tenant-id <id>
//   npm run tenant:migrate -- --all --dry-run
//   npm run tenant:export -- --tenant-id <id> --out ./exports
//   npm run tenant:seats -- --tenant-id <id>
//   npm run tenant:plan -- --tenant-id <id> --plan-code standard
//   npm run tenant:backup -- --tenant-id <id> [--out ./backups]
//   npm run tenant:restore-drill -- --file ./backups/tenant_x.dump [--probe-table schools]
// ──────────────────────────────────────────────

import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { loadProvisioningEnv } from './config';
import { provisionTenant } from './provision';
import {
  changePlan,
  exportTenant,
  hardDeleteTenant,
  recountSeats,
  resumeTenant,
  scheduleTenantDeletion,
  suspendTenant,
} from './lifecycle';
import { migrateAll, tenantFleetStatus } from './migrate';
import { backupTenant, rehearseRestore } from './backup';
import {
  convertTenantToPaid,
  issueRenewalInvoice,
  latestUsage,
  markSaasInvoicePaid,
  overrideDunning,
  reconcileMeteredBilling,
  recordUsage,
  runDunningPass,
  seedDefaultPlans,
  type UsageMetric,
} from './billing';

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function requireArg(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || !v) throw new Error(`Missing required argument --${name}`);
  return v;
}

async function openControlPlane(): Promise<ControlPlaneClient> {
  const env = loadProvisioningEnv();
  return new ControlPlaneClient({ datasourceUrl: env.controlPlaneUrl });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const env = loadProvisioningEnv();
  const cp = await openControlPlane();

  switch (command) {
    case 'create': {
      const slug = requireArg(args, 'slug');
      const legalName = requireArg(args, 'legal-name');
      const result = await provisionTenant(
        {
          slug,
          legalName,
          planCode: typeof args['plan-code'] === 'string' ? args['plan-code'] : undefined,
          trialDays: typeof args['trial-days'] === 'string' ? Number(args['trial-days']) : undefined,
          region: typeof args['region'] === 'string' ? args['region'] : undefined,
        },
        {
          controlPlane: cp,
          adminDatabaseUrl: env.adminDatabaseUrl,
          actor: typeof args['actor'] === 'string' ? args['actor'] : undefined,
        },
      );
      if (args['json'] === true) {
        // Machine-readable mode: emit ONLY the result object.
        console.log(JSON.stringify(result));
      } else {
        console.log(JSON.stringify(result, null, 2));
        if (result.setupUrl) console.log(`\nFirst-admin setup link:\n  ${result.setupUrl}`);
      }
      break;
    }

    case 'status': {
      const rows = await tenantFleetStatus(cp);
      const filtered = typeof args['slug'] === 'string' ? rows.filter((r) => r.slug === args['slug']) : rows;
      console.table(filtered.map((r) => ({ slug: r.slug, status: r.status, schemaVersion: r.schemaVersion, drift: r.drift })));
      break;
    }

    case 'drift-check': {
      // BUILD_PLAN 1.4.6: "Alert loudly when any tenant drifts from the target
      // version." Exit code is the alert: 0 = fleet current, 1 = drift found.
      // Cron-able: `0 6 * * * pnpm tenant:drift-check || alert`.
      const rows = await tenantFleetStatus(cp);
      const drifting = rows.filter((r) => r.drift !== 'current');
      if (args['json'] === true) {
        console.log(
          JSON.stringify({ targetVersion: rows[0]?.targetVersion ?? 0, drifting: drifting.length, rows }),
        );
      } else {
        console.table(rows.map((r) => ({ slug: r.slug, status: r.status, schemaVersion: r.schemaVersion, drift: r.drift })));
        if (drifting.length === 0) {
          console.log('Fleet is current — no drift.');
        } else {
          console.error(`ALERT: ${drifting.length} tenant(s) drift from target v${rows[0]?.targetVersion ?? 0}:`);
          for (const r of drifting) {
            console.error(`  - ${r.slug} (${r.status}) at v${r.schemaVersion} [${r.drift}]`);
          }
          process.exitCode = 1;
        }
      }
      break;
    }

    case 'suspend':
      await suspendTenant(cp, requireArg(args, 'tenant-id'), requireArg(args, 'reason'));
      console.log('suspended');
      break;

    case 'resume':
      await resumeTenant(cp, requireArg(args, 'tenant-id'));
      console.log('resumed');
      break;

    case 'delete': {
      const { deleteAfter } = await scheduleTenantDeletion(
        cp,
        requireArg(args, 'tenant-id'),
        typeof args['retention-days'] === 'string' ? Number(args['retention-days']) : 30,
      );
      console.log(`deletion scheduled for ${deleteAfter.toISOString()}`);
      break;
    }

    case 'hard-delete': {
      const cert = await hardDeleteTenant(cp, requireArg(args, 'tenant-id'), env.adminDatabaseUrl);
      console.log(cert);
      break;
    }

    case 'migrate': {
      const result = await migrateAll({
        controlPlane: cp,
        dryRun: args['dry-run'] === true,
        concurrency: typeof args['concurrency'] === 'string' ? Number(args['concurrency']) : 5,
        onlyTenantIds: typeof args['tenant-id'] === 'string' ? [args['tenant-id']] : undefined,
        actor: typeof args['actor'] === 'string' ? args['actor'] : undefined,
      });
      if (args['json'] === true) {
        console.log(JSON.stringify(result));
      } else {
        console.log(JSON.stringify(result, null, 2));
        if (result.failed > 0) process.exitCode = 1;
      }
      break;
    }

    case 'export': {
      const dump = await exportTenant(cp, requireArg(args, 'tenant-id'));
      const out = typeof args['out'] === 'string' ? args['out'] : `./exports/${dump.slug}.json`;
      const fs = await import('node:fs');
      fs.mkdirSync(out.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(dump, null, 2));
      console.log(`exported ${dump.tables.length} tables to ${out}`);
      break;
    }

    case 'seats': {
      const count = await recountSeats(cp, requireArg(args, 'tenant-id'));
      console.log(`active students: ${count}`);
      break;
    }

    case 'plan':
      await changePlan(cp, requireArg(args, 'tenant-id'), requireArg(args, 'plan-code'));
      console.log('plan changed');
      break;

    case 'backup': {
      const tenantId = requireArg(args, 'tenant-id');
      const datastore = await cp.tenantDatastore.findUnique({ where: { tenantId } });
      if (!datastore) throw new Error(`Tenant ${tenantId} has no datastore.`);
      const out = typeof args['out'] === 'string' ? args['out'] : undefined;
      const backup = await backupTenant(datastore.connRef, out);
      console.log(JSON.stringify(backup, null, 2));
      break;
    }

    case 'restore-drill': {
      const env2 = env;
      const file = requireArg(args, 'file');
      const probeTable = typeof args['probe-table'] === 'string' ? args['probe-table'] : 'schools';
      const probeCount =
        typeof args['probe-count'] === 'string' ? Number(args['probe-count']) : undefined;
      const drill = await rehearseRestore(env2.adminDatabaseUrl, file, { probeTable, probeCount });
      console.log(JSON.stringify(drill, null, 2));
      console.log(
        `\nRestore drill completed in ${(drill.durationMs / 1000).toFixed(1)}s — record this time in the ops log.`,
      );
      break;
    }

    // ── 4.2 SaaS billing ──

    case 'plans-seed': {
      const plans = await seedDefaultPlans(cp, 'cli:plans-seed');
      console.table(plans.map((p) => ({ code: p.code, price: Number(p.pricePerStudentYear), maxBranches: p.maxBranches, maxStudents: p.maxStudents })));
      break;
    }

    case 'convert': {
      // Trial → paid: issues the GST tax invoice in the same transaction.
      const result = await convertTenantToPaid(cp, {
        tenantId: requireArg(args, 'tenant-id'),
        planCode: requireArg(args, 'plan-code'),
        seats: typeof args['seats'] === 'string' ? Number(args['seats']) : requireArg(args, 'seats') as unknown as number,
        supplierGstin: typeof args['supplier-gstin'] === 'string' ? args['supplier-gstin'] : undefined,
        actor: 'cli:convert',
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'renew': {
      const result = await issueRenewalInvoice(cp, {
        tenantId: requireArg(args, 'tenant-id'),
        seats: Number(requireArg(args, 'seats')),
        actor: 'cli:renew',
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'invoice-paid': {
      const invoice = await markSaasInvoicePaid(cp, requireArg(args, 'invoice-id'), 'cli:invoice-paid');
      console.log(`invoice ${invoice.invoiceNo} marked PAID`);
      break;
    }

    case 'dunning': {
      if (args['override'] === true) {
        await overrideDunning(cp, requireArg(args, 'tenant-id'), {
          message: requireArg(args, 'message'),
          actor: 'cli:dunning',
          reactivate: args['reactivate'] === true,
        });
        console.log('dunning override recorded');
      } else {
        const outcomes = await runDunningPass(cp);
        console.table(outcomes);
        if (outcomes.length === 0) console.log('(no tenants advanced the dunning ladder)');
      }
      break;
    }

    case 'usage': {
      const tenantId = requireArg(args, 'tenant-id');
      if (typeof args['metric'] === 'string') {
        await recordUsage(cp, tenantId, args['metric'] as UsageMetric, Number(requireArg(args, 'value')));
        console.log('usage recorded');
      }
      console.log(JSON.stringify(await latestUsage(cp, tenantId), null, 2));
      break;
    }

    case 'billing-recon': {
      const recon = await reconcileMeteredBilling(cp, requireArg(args, 'tenant-id'));
      console.log(JSON.stringify(recon, null, 2));
      break;
    }

    default:
      console.error(`Unknown command: ${command ?? '(none)'}`);
      console.error('Commands: create, status, drift-check, suspend, resume, delete, hard-delete, migrate, export, seats, plan, backup, restore-drill, plans-seed, convert, renew, invoice-paid, dunning, usage, billing-recon');
      process.exitCode = 1;
  }

  await cp.$disconnect();
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});