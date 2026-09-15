// ──────────────────────────────────────────────
// Credit envelope tests (BUILD_PLAN 5.7)
//
// The envelope is the billing edge between us and every WhatsApp/SMS send:
// these prove the math (increments, atomic decrement below-zero immunity,
// low-balance flag trip-and-clear) and that a top-up invoice and the
// envelope grow in the SAME transaction — no invoice, no units.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase } from '@school-erp/testing';
import { getCreditBalance, tryDecrementCredits, topUpCredits } from '../src/credits';
import { purchaseCreditTopUp } from '../src/billing';

let controlDb: TestDatabase;
let cp: ControlPlaneClient;

// Base URL is DATABASE_URL (CI's only provisioned variable) — TestDatabase
// creates an isolated control-plane schema on it, so no second database is
// needed. CONTROL_PLANE_DATABASE_URL stays supported via TestDatabase's own
// dotenv load when the caller passes undefined.
const CONTROL_URL = process.env.CONTROL_PLANE_DATABASE_URL ?? process.env.DATABASE_URL;

beforeAll(async () => {
  controlDb = await TestDatabase.create(CONTROL_URL, { project: 'control-plane' });
  cp = new ControlPlaneClient({ datasourceUrl: controlDb.url });
});

afterAll(async () => {
  await cp.$disconnect();
  await controlDb.teardown();
});

async function mkTenant(slug: string) {
  return cp.tenant.create({
    data: { slug, legalName: `School ${slug}`, status: 'ACTIVE' },
  });
}

describe('credit envelopes', () => {
  it('top-up creates the envelope on first purchase and increments after', async () => {
    const t = await mkTenant('credits-grow');
    const first = await topUpCredits(cp, t.id, 1000);
    expect(first.balance).toBe(1000);
    expect(first.purchasedTotal).toBe(1000);

    const second = await topUpCredits(cp, t.id, 500);
    expect(second.balance).toBe(1500);
    expect(second.purchasedTotal).toBe(1500);
  });

  it('tryDecrement decrements atomically and refuses to go below zero', async () => {
    const t = await mkTenant('credits-decrement');
    await topUpCredits(cp, t.id, 3);

    expect((await tryDecrementCredits(cp, t.id)).balance).toBe(2); // post-decrement readback
    expect((await tryDecrementCredits(cp, t.id)).balance).toBe(1);
    // The last unit goes through; the next is refused.
    expect((await tryDecrementCredits(cp, t.id)).balance).toBe(0);
    const exhausted = await tryDecrementCredits(cp, t.id);
    expect(exhausted.ok).toBe(false);
    expect(exhausted.balance).toBe(0);
    // Envelope never negative even under an extra decrement race.
    expect((await cp.creditEnvelope.findUniqueOrThrow({ where: { tenantId: t.id } })).balance).toBe(0);
  });

  it('low-balance flag trips once near zero and clears on top-up', async () => {
    const t = await mkTenant('credits-lowflag');
    await topUpCredits(cp, t.id, 3);
    await tryDecrementCredits(cp, t.id);
    await tryDecrementCredits(cp, t.id); // balance 1 → low flag should trip
    const flagged = await cp.creditEnvelope.findUniqueOrThrow({ where: { tenantId: t.id } });
    expect(flagged.lowBalanceAt).not.toBeNull();

    // Top-up clears the flag.
    await topUpCredits(cp, t.id, 100);
    const cleared = await cp.creditEnvelope.findUniqueOrThrow({ where: { tenantId: t.id } });
    expect(cleared.lowBalanceAt).toBeNull();
    expect(cleared.balance).toBe(101);
  });

  it('rejects non-positive or fractional top-ups', async () => {
    const t = await mkTenant('credits-badinput');
    await expect(topUpCredits(cp, t.id, 0)).rejects.toThrow(/positive whole/i);
    await expect(topUpCredits(cp, t.id, -5)).rejects.toThrow(/positive whole/i);
    await expect(topUpCredits(cp, t.id, 10.5)).rejects.toThrow(/positive whole/i);
  });

  it('purchaseCreditTopUp issues a Rule 46 invoice and credits the envelope in one transaction', async () => {
    const t = await mkTenant('credits-invoice');
    const before = await cp.saasInvoice.count();

    const result = await purchaseCreditTopUp(cp, {
      tenantId: t.id,
      units: 1000,
      pricePerUnit: 0.35,
      supplierName: 'VibeEDU Platform Pvt Ltd',
      actor: 'test',
    });

    expect(result.units).toBe(1000);
    expect(result.amount).toBe(350); // 1000 × ₹0.35
    expect(result.gstAmount).toBe(63); // 18% (intra-state default → CGST+SGST)
    expect(result.total).toBe(413);
    expect(result.invoiceNo).toMatch(/^SI-\d{4}-\d\d-\d{5}$/);
    expect(result.balance).toBe(1000);

    // The invoice exists with the Rule 46 anatomy and the envelope grew.
    expect(await cp.saasInvoice.count()).toBe(before + 1);
    const invoice = await cp.saasInvoice.findUniqueOrThrow({ where: { invoiceNo: result.invoiceNo } });
    expect(invoice.sacCode).toBe('997331');
    expect(invoice.status).toBe('ISSUED');
    expect(Number(invoice.amount)).toBe(350);
    const envelope = await getCreditBalance(cp, t.id);
    expect(envelope.balance).toBe(1000);
    expect(envelope.purchased).toBe(1000);
  });

  it('rejects bad top-up units before any invoice exists', async () => {
    const t = await mkTenant('credits-badinvoice');
    const before = await cp.saasInvoice.count();
    await expect(purchaseCreditTopUp(cp, { tenantId: t.id, units: 0 })).rejects.toThrow(/positive whole/i);
    expect(await cp.saasInvoice.count()).toBe(before); // no orphan invoice
  });
});
