// ──────────────────────────────────────────────
// India-law compliance tests (BUILD_PLAN 4, "as per Indian laws")
//
//   • GSTIN structure + check digit (GSTN Developer Network algorithm)
//   • Place-of-supply GST split — Sec 12, IGST Act: intra-state = CGST+SGST,
//     inter-state = IGST
//   • Rule 46 (CGST Rules) amount-in-words in the Indian numbering system
//   • Cheque validity — RBI Clean Note Policy: 3 months from date of issue
//   • Section 269ST, Income-tax Act 1961: ₹2,00,000 cash receipt cap
//     (single AND per-day aggregate — the receiver's penalty is 100%)
// ──────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  GST_RATE,
  SAC_CODE,
  GSTIN_RE,
  gstinCheckDigit,
  isValidGstin,
  gstinStateCode,
  panFromGstin,
  stateName,
  splitGst,
  amountInWords,
} from './gst';
import {
  CHEQUE_VALIDITY_DAYS,
  CASH_RECEIPT_LIMIT_269ST,
  validateChequeDate,
  assertCashWithin269ST,
} from './payment-methods';

describe('GSTIN validation (GSTN check-digit algorithm)', () => {
  // Two published, genuinely-valid GSTINs (verified against the GSTN
  // Developer Network Java routine via a CA-published derivation).
  const VALID = ['27AAPFU0939F1ZV', '24AAACH7409R1Z7'];

  it('accepts structurally valid GSTINs with the correct check digit', () => {
    for (const g of VALID) {
      expect(g).toMatch(GSTIN_RE);
      expect(isValidGstin(g)).toBe(true);
    }
  });

  it('rejects a wrong check digit (last char altered)', () => {
    for (const g of VALID) {
      const last = g[g.length - 1];
      const flipped = last === '9' ? '8' : '9';
      expect(isValidGstin(g.slice(0, 14) + flipped)).toBe(false);
    }
  });

  it('computes the check digit deterministically', () => {
    for (const g of VALID) {
      expect(gstinCheckDigit(g.slice(0, 14))).toBe(g[14]);
    }
  });

  it('rejects malformed GSTINs', () => {
    expect(isValidGstin('')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false); // 13 chars
    expect(isValidGstin('27AAPFU0939F1ZVA')).toBe(false); // 16 chars
    expect(isValidGstin('2GAAPFU0939F1ZV'.slice(0, 15))).toBe(false); // state 2G invalid
  });

  it('normalizes case and whitespace before validating', () => {
    expect(isValidGstin(' 27aapfu0939f1zv ')).toBe(true);
    expect(panFromGstin('27aapfu0939f1zv')).toBe('AAPFU0939F');
  });

  it('derives state code and PAN from the GSTIN', () => {
    const g = VALID[0]; // 27AAPFU0939F1ZV
    expect(gstinStateCode(g)).toBe('27');
    expect(stateName('27')).toBe('Maharashtra');
    expect(panFromGstin(g)).toBe('AAPFU0939F');
  });
});

describe('Place-of-supply GST split (Sec 12, IGST Act)', () => {
  it('splits intra-state supply into CGST 9% + SGST 9%', () => {
    const s = splitGst(10_000, '27', '27'); // supplier MH → school MH
    expect(s.intraState).toBe(true);
    expect(s.cgst).toBeCloseTo(900);
    expect(s.sgst).toBeCloseTo(900);
    expect(s.igst).toBe(0);
    expect(s.totalTax).toBeCloseTo(1_800);
    expect(s.total).toBeCloseTo(11_800);
  });

  it('charges IGST 18% on inter-state supply', () => {
    const s = splitGst(10_000, '27', '29'); // supplier MH → school KA
    expect(s.intraState).toBe(false);
    expect(s.igst).toBeCloseTo(1_800);
    expect(s.cgst).toBe(0);
    expect(s.sgst).toBe(0);
    expect(s.total).toBeCloseTo(11_800);
  });

  it('handles fractional amounts without losing paise', () => {
    const s = splitGst(1_234.56, '07', '07');
    expect(s.totalTax).toBeCloseTo(222.2208, 4);
    expect(s.total).toBeCloseTo(1_456.7808, 4);
  });

  it('keeps the rate and SAC constants sane', () => {
    expect(GST_RATE).toBe(18);
    expect(SAC_CODE).toBe('997331'); // Licensing of hosted ERP software
  });
});

describe('Rule 46 — amount in words (Indian numbering)', () => {
  it('writes lakh/crore amounts', () => {
    expect(amountInWords(354_000)).toBe('Rupees Three Lakh Fifty Four Thousand Only');
    expect(amountInWords(123_456_789)).toBe(
      'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only',
    );
  });

  it('handles small and paise-bearing amounts', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(1)).toBe('Rupees One Only');
    expect(amountInWords(1.5)).toBe('Rupees One and Paise Fifty Only');
    expect(amountInWords(1_00_000)).toBe('Rupees One Lakh Only');
  });

  it('rounds floating-point drift to the nearest paise', () => {
    // 11,111.11 × 1.18 = 13,111.1098 in binary floats — must read 13,111.11,
    // i.e. "Paise Eleven" (and not truncate to 13,111.10).
    expect(amountInWords(11_111.11 * 1.18)).toBe(
      'Rupees Thirteen Thousand One Hundred Eleven and Paise Eleven Only',
    );
  });
});

describe('Cheque validity — RBI 3-month window', () => {
  const now = new Date('2026-09-12T10:00:00+05:30');

  it('accepts a current-dated cheque', () => {
    expect(() => validateChequeDate(new Date('2026-09-10'), now)).not.toThrow();
  });

  it('accepts exactly at the 90-day boundary and rejects beyond it', () => {
    const atBoundary = new Date(now.getTime() - CHEQUE_VALIDITY_DAYS * 86_400_000);
    expect(() => validateChequeDate(atBoundary, now)).not.toThrow();
    const stale = new Date(now.getTime() - (CHEQUE_VALIDITY_DAYS + 1) * 86_400_000);
    expect(() => validateChequeDate(stale, now)).toThrow(/stale/);
  });

  it('rejects heavily post-dated instruments', () => {
    const postDated = new Date(now.getTime() + (CHEQUE_VALIDITY_DAYS + 1) * 86_400_000);
    expect(() => validateChequeDate(postDated, now)).toThrow(/post-dated/);
  });
});

describe('Section 269ST — ₹2,00,000 cash receipt cap', () => {
  const LIMIT = CASH_RECEIPT_LIMIT_269ST;
  expect(LIMIT).toBe(200_000);

  it('refuses a single cash receipt of ₹2,00,000 or more', () => {
    expect(() => assertCashWithin269ST(200_000, 0)).toThrow(/269ST/);
    expect(() => assertCashWithin269ST(250_000, 0)).toThrow(/269ST/);
    expect(() => assertCashWithin269ST(199_999, 0)).not.toThrow();
  });

  it('refuses the per-day aggregate crossing ₹2,00,000 ("or more" is inclusive)', () => {
    expect(() => assertCashWithin269ST(1, 199_999)).toThrow(/aggregate/); // lands exactly on 2,00,000
    expect(() => assertCashWithin269ST(100_000, 99_999)).not.toThrow(); // 1,99,999 — still legal
    expect(() => assertCashWithin269ST(100_000, 100_000)).toThrow(/aggregate/);
  });
});
