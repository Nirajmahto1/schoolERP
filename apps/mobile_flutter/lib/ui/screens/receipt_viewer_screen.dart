// ──────────────────────────────────────────────
// Receipt PDF viewer (BUILD_PLAN 4.1.4) — "downloadable from the parent
// portal" for the app.
//
// The receipt is rendered once by fee-service (zero-dependency PDF writer)
// and served at /fees/payments/:id/receipt.pdf with the Authorization
// header. This screen fetches the bytes through ApiClient (same transport as
// photos, so the token rides along) and renders them IN-APP via the printing
// package's PdfPreview — scroll, pinch, share and print with no external
// viewer app involved. Payment rows cache the rendered base64 in the DB, so
// re-opening is a DB read, not a re-render.
// ──────────────────────────────────────────────

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import '../../core/api.dart';

class ReceiptViewerScreen extends StatefulWidget {
  const ReceiptViewerScreen({super.key, required this.paymentId, required this.title});

  final String paymentId;
  final String title;

  /// Look up the latest SUCCESS payment for an invoice, then open its
  /// numbered receipt. Safe to call on any invoice row — shows a friendly
  /// sheet when nothing has been paid yet.
  static Future<void> openForInvoice(BuildContext context, String invoiceId) async {
    String? paymentId;
    String? receiptNo;
    try {
      final rows = await ApiClient.instance.list('/fees/payments?invoiceId=$invoiceId&status=SUCCESS&limit=1');
      if (rows.isNotEmpty) {
        final row = Map<String, dynamic>.from(rows.first);
        paymentId = row['id']?.toString();
        receiptNo = row['receiptNo']?.toString();
      }
    } on ApiError catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.detail)));
      }
      return;
    }
    if (!context.mounted) return;
    if (paymentId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No successful payment found for this invoice yet.')),
      );
      return;
    }
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ReceiptViewerScreen(
        paymentId: paymentId!,
        title: receiptNo ?? 'Receipt',
      ),
    ));
  }

  /// Direct open when the payment id is already known (e.g. right after
  /// checkout verify returns the captured payment row).
  static Future<void> openForPayment(BuildContext context, String paymentId, {String? receiptNo}) {
    return Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ReceiptViewerScreen(paymentId: paymentId, title: receiptNo ?? 'Receipt'),
    ));
  }

  @override
  State<ReceiptViewerScreen> createState() => _ReceiptViewerScreenState();
}

class _ReceiptViewerScreenState extends State<ReceiptViewerScreen> {
  Uint8List? _bytes;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final bytes = await ApiClient.instance.getBytes('/fees/payments/${widget.paymentId}/receipt.pdf');
    if (!mounted) return;
    if (bytes == null || bytes.length < 5 || String.fromCharCodes(bytes.sublist(0, 5)) != '%PDF-') {
      setState(() => _error = 'Could not load the receipt. Please try again.');
      return;
    }
    setState(() => _bytes = bytes);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: _error != null
          ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.error_outline, size: 40, color: Colors.redAccent),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              FilledButton.tonal(onPressed: () { setState(() { _error = null; }); _load(); }, child: const Text('Retry')),
            ]))
          : _bytes == null
              ? const Center(child: CircularProgressIndicator())
              : PdfPreview(
                  build: (_) => _bytes!,
                  pdfFileName: 'receipt-${widget.title}.pdf',
                  canChangePageFormat: false,
                  canDebug: false,
                  useActions: true,
                  maxPageWidth: 700,
                ),
    );
  }
}
