// ──────────────────────────────────────────────
// Receipt rendering (BUILD_PLAN 4.1.4)
//
// "Receipt PDF, numbered from the Sequence table, emailed + WhatsApp,
// downloadable from the parent portal."
//
// The renderer is deliberately boring: an HTML receipt (for WhatsApp/email
// bodies and the browser) and a PDF (for download and print). Both derive
// from the SAME payment row, so the number the accountant reconciles against
// is the number on the parent's receipt. PDF bytes are cached in
// Payment.receiptPdf (base64) — 500 receipts is a batch job, not 500
// cold renders.
// ──────────────────────────────────────────────

import { renderReceiptPdf } from './receipt-pdf';
import type { PrismaClient } from '@school-erp/database';

export interface ReceiptData {
  receiptNo: string;
  paidAt: Date | string | null;
  amount: number; // rupees
  method: string;
  status: string;
  gatewayPaymentId?: string | null;
  chequeNo?: string | null;
  student: { admissionNo: string; firstName: string; lastName: string } | null;
  branch: { name: string; address: string | null; phone: string | null } | null;
  allocations: Array<{ feeHead: string | null; invoiceNo: string | null; amount: number }>;
}

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  UPI: 'UPI',
  ONLINE: 'Online (Razorpay)',
  NEFT: 'NEFT / Bank transfer',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
};

const fmt = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** Payment row → ReceiptData. Amounts are stored as rupees (Decimal(12,2)); paise conversion happens only at the Razorpay boundary. */
export function toReceiptData(p: {
  receiptNo: string | null;
  paidAt: Date | null;
  amount: unknown; // Decimal
  method: string;
  status: string;
  gatewayPaymentId: string | null;
  cheque?: { chequeNumber: string } | null;
  student: { admissionNo: string; firstName: string; lastName: string } | null;
  branch: { name: string; address: string | null; phone: string | null } | null;
  allocations: Array<{ amount: unknown; invoice: { invoiceNo: string | null; lines?: Array<{ feeHead: { name: string } }> } | null }>;
}): ReceiptData {
  return {
    receiptNo: p.receiptNo ?? 'UNNUMBERED',
    paidAt: p.paidAt,
    amount: Number(p.amount),
    method: METHOD_LABEL[p.method] ?? p.method,
    status: p.status,
    gatewayPaymentId: p.gatewayPaymentId,
    chequeNo: p.cheque?.chequeNumber ?? null,
    student: p.student,
    branch: p.branch,
    allocations: p.allocations.map((a) => ({
      feeHead: a.invoice?.lines?.[0]?.feeHead?.name ?? null,
      invoiceNo: a.invoice?.invoiceNo ?? null,
      amount: Number(a.amount),
    })),
  };
}

/** Print-ready HTML — email/WhatsApp-friendly (inline styles, table layout). */
export function renderReceiptHtml(d: ReceiptData): string {
  const rows = d.allocations.length
    ? d.allocations
        .map(
          (a) =>
            `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${a.feeHead ?? 'Fee'}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee">${a.invoiceNo ?? '—'}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">₹${fmt(a.amount)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="2" style="padding:6px 10px">Fee payment</td><td style="padding:6px 10px;text-align:right">₹${fmt(d.amount)}</td></tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Receipt ${d.receiptNo}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:640px;margin:24px auto">
  <div style="border:1px solid #ddd;border-radius:8px;padding:24px">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td>
          <div style="font-size:18px;font-weight:bold">${d.branch?.name ?? 'School'}</div>
          <div style="font-size:12px;color:#555">${d.branch?.address ?? ''}</div>
          ${d.branch?.phone ? `<div style="font-size:12px;color:#555">Ph: ${d.branch.phone}</div>` : ''}
        </td>
        <td style="text-align:right">
          <div style="font-size:12px;color:#555">FEE RECEIPT</div>
          <div style="font-size:16px;font-weight:bold">${d.receiptNo}</div>
          <div style="font-size:12px;color:#555">${fmtDate(d.paidAt)}</div>
        </td>
      </tr>
    </table>
    <hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
    <table style="width:100%;font-size:13px">
      <tr>
        <td><b>Student:</b> ${d.student ? `${d.student.firstName} ${d.student.lastName} (${d.student.admissionNo})` : '—'}</td>
        <td style="text-align:right"><b>Mode:</b> ${d.method}${d.chequeNo ? ` — Cheque ${d.chequeNo}` : ''}</td>
      </tr>
    </table>
    <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:13px">
      <thead><tr style="background:#f5f5f5">
        <th style="padding:6px 10px;text-align:left">Fee head</th>
        <th style="padding:6px 10px;text-align:left">Invoice</th>
        <th style="padding:6px 10px;text-align:right">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td colspan="2" style="padding:8px 10px;font-weight:bold;text-align:right">Total paid</td>
        <td style="padding:8px 10px;font-weight:bold;text-align:right">₹${fmt(d.amount)}</td>
      </tr></tfoot>
    </table>
    ${d.gatewayPaymentId ? `<div style="margin-top:10px;font-size:11px;color:#666">Gateway reference: ${d.gatewayPaymentId}</div>` : ''}
    <div style="margin-top:24px;font-size:11px;color:#777">
      This is a computer-generated receipt and does not require a signature.
      Please retain for your records.
    </div>
  </div>
</body></html>`;
}

/** Payment row include-shape shared by the routes that render receipts. */
export const RECEIPT_INCLUDE = {
  allocations: {
    include: {
      invoice: {
        select: { invoiceNo: true, lines: { select: { feeHead: { select: { name: true } } }, take: 1 } },
      },
    },
  },
  cheque: { select: { chequeNumber: true } },
} as const;

/** Fetch everything a receipt needs, branch-scoped. */
export async function loadReceiptPayment(prisma: PrismaClient, paymentId: string, branchId: string) {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, branchId },
    include: RECEIPT_INCLUDE,
  });
  if (!payment) return null;
  const [student, branch] = await Promise.all([
    prisma.student.findUnique({
      where: { id: payment.studentId },
      select: { admissionNo: true, firstName: true, lastName: true },
    }),
    prisma.branch.findUnique({
      where: { id: payment.branchId },
      select: { name: true, address: true, phone: true },
    }),
  ]);
  return { payment, student, branch };
}

/** ReceiptData → PdfReceiptData for the PDF writer. */
export function toPdfData(d: ReceiptData) {
  return {
    receiptNo: d.receiptNo,
    date: fmtDate(d.paidAt),
    schoolName: d.branch?.name ?? 'School',
    schoolLines: [d.branch?.address ?? '', d.branch?.phone ? `Ph: ${d.branch.phone}` : ''].filter(Boolean),
    studentLine: d.student ? `${d.student.firstName} ${d.student.lastName} (${d.student.admissionNo})` : '—',
    modeLine: `Payment mode: ${d.method}${d.chequeNo ? ` — Cheque No. ${d.chequeNo}` : ''}`,
    referenceLine: d.gatewayPaymentId ? `Gateway reference: ${d.gatewayPaymentId}` : null,
    rows: d.allocations.length
      ? d.allocations.map((a) => ({ label: a.feeHead ?? 'Fee', invoice: a.invoiceNo ?? '—', amount: fmt(a.amount) }))
      : [{ label: 'Fee payment', invoice: '—', amount: fmt(d.amount) }],
    total: fmt(d.amount),
    footnote: 'This is a computer-generated receipt and does not require a signature. Please retain for your records.',
  };
}

/** Full receipt document (HTML) for email/WhatsApp bodies. */
export function renderReceiptDocument(d: ReceiptData): string {
  return renderReceiptHtml(d);
}

/** Receipt PDF bytes (cached in Payment.receiptPdf as base64). */
export function renderReceiptBytes(d: ReceiptData): Buffer {
  return renderReceiptPdf(toPdfData(d));
}
