// ──────────────────────────────────────────────
// Indian GST compliance helpers (BUILD_PLAN 4.2.2, "as per Indian laws")
//
// Rule 46 of the CGST Rules demands a real tax invoice: supplier + recipient
// GSTINs, split CGST/SGST (intra-state) or IGST (inter-state), place of
// supply, reverse-charge flag, amount in words. This module is the pure
// arithmetic behind that — no DB, no I/O, fully unit-testable.
// ──────────────────────────────────────────────

export const GST_RATE = 18;

/** SAC 997331 — Licensing of hosted ERP software (services, Section 7 CGST Act). */
export const SAC_CODE = '997331';

/** GSTIN: 2-digit state code + 10-char PAN + entity code + Z + check digit. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const CHECK_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Standard GSTIN check digit: alternate weights 1,2 over the first 14 chars,
 * base-36 digit sums, 36 - (sum mod 36).
 */
export function gstinCheckDigit(gstin14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHECK_CHARS.indexOf(gstin14[i]);
    if (value < 0) return '';
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHECK_CHARS[(36 - (sum % 36)) % 36];
}

export function isValidGstin(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return false;
  return gstinCheckDigit(g.slice(0, 14)) === g[14];
}

/** First two digits of a GSTIN = the GST state code (01–38). */
export function gstinStateCode(gstin: string): string {
  return gstin.trim().slice(0, 2);
}

/** A GSTIN embeds the PAN (positions 3–12) — printed on invoices for TDS. */
export function panFromGstin(gstin: string): string | null {
  const g = gstin.trim().toUpperCase();
  return GSTIN_RE.test(g) ? g.slice(2, 12) : null;
}

export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar', '36': 'Telangana',
  '37': 'Andhra Pradesh (new)', '38': 'Ladakh',
};

export function stateName(code: string): string {
  return STATE_CODES[code] ?? `State ${code}`;
}

export interface TaxSplit {
  /** Intra-state: CGST + SGST. Inter-state: IGST. */
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  total: number;
  intraState: boolean;
}

/**
 * Split 18% GST per the place-of-supply rule (Sec 12, IGST Act):
 * supplier state == recipient state → CGST 9% + SGST 9%;
 * otherwise → IGST 18%. Amounts are in rupees.
 */
export function splitGst(amount: number, supplierStateCode: string, placeOfSupplyStateCode: string): TaxSplit {
  const tax = (amount * GST_RATE) / 100;
  if (supplierStateCode === placeOfSupplyStateCode) {
    const half = tax / 2;
    return { cgst: half, sgst: half, igst: 0, totalTax: tax, total: amount + tax, intraState: true };
  }
  return { cgst: 0, sgst: 0, igst: tax, totalTax: tax, total: amount + tax, intraState: false };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t} ${ONES[n % 10]}` : t;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let out = '';
  if (h) out += `${ONES[h]} Hundred`;
  if (rest) out += `${out ? ' ' : ''}${twoDigits(rest)}`;
  return out;
}

/**
 * Indian numbering (lakh/crore) amount in words, Rule 46: "Rupees ... Only".
 * ₹354,000 → "Rupees Three Lakh Fifty Four Thousand Only".
 */
export function amountInWords(amount: number): string {
  const totalPaise = Math.round(amount * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;

  let n = rupees;
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const rest = n;

  const parts: string[] = [];
  if (crore) parts.push(`${twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  let words = parts.join(' ');

  let out = `Rupees ${words || 'Zero'}`;
  if (paise) out += ` and Paise ${twoDigits(paise)}`;
  out += ' Only';
  return out;
}