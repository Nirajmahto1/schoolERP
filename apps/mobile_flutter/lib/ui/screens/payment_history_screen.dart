// ──────────────────────────────────────────────
// Payment history (BUILD_PLAN 4.1.4) — every receipt, per child.
//
// Backed by /fees/history, which the server scopes to the caller's own
// children (guardian links; students self-resolve). Rows are grouped per
// child the way the accountant's ledger is; tapping a payment opens its
// numbered receipt in the in-app viewer. This is the parent's answer to
// "did the ₹5,000 I paid last week reach the school?"
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../screens/receipt_viewer_screen.dart';
import '../widgets/common.dart';

class PaymentHistoryScreen extends StatefulWidget {
  const PaymentHistoryScreen({super.key, this.studentId, this.childName});

  /// Optional focus: open pre-scoped to one child (staff can pass any id;
  /// parents are server-checked against their own links anyway).
  final String? studentId;
  final String? childName;

  @override
  State<PaymentHistoryScreen> createState() => _PaymentHistoryScreenState();
}

class _PaymentHistoryScreenState extends State<PaymentHistoryScreen> {
  List<Map<String, dynamic>>? _groups;
  Map<String, dynamic>? _totals;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final path = widget.studentId != null
          ? '/fees/history?studentId=${widget.studentId}'
          : '/fees/history';
      final data = await ApiClient.instance.get(path);
      final groups = (data is Map ? data['groups'] : null) as List<dynamic>? ?? const [];
      if (!mounted) return;
      setState(() {
        _groups = groups.map((e) => Map<String, dynamic>.from(e)).toList();
        _totals = data is Map && data['totals'] is Map ? Map<String, dynamic>.from(data['totals'] as Map) : null;
        _error = null;
      });
    } on ApiError catch (e) {
      setState(() => _error = e.detail);
    } catch (_) {
      setState(() => _error = 'Network error');
    }
  }

  @override
  Widget build(BuildContext context) {
    final fmt = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
    final title = widget.childName != null ? '${widget.childName} — Receipts' : 'Payment History';
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListViewScreen(
          title: title,
          error: _error,
          empty: _groups != null && _groups!.isEmpty,
          emptyText: 'No payments recorded yet — receipts appear here the moment a fee is settled.',
          onRetry: _load,
          children: [
            if (_totals != null && (_totals!['count'] ?? 0) > 0)
              Card(
                margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                color: Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.4),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(children: [
                    const Icon(Icons.receipt_long_outlined),
                    const SizedBox(width: 10),
                    Expanded(child: Text('${_totals!['count']} receipt(s) · ${fmt.format(((_totals!['amount'] ?? 0) as num).toDouble())} total paid',
                        style: const TextStyle(fontWeight: FontWeight.w700))),
                  ]),
                ),
              ),
            ...(_groups ?? []).expand((g) {
              final student = Map<String, dynamic>.from(g['student'] as Map);
              final payments = (g['payments'] as List<dynamic>? ?? const [])
                  .map((e) => Map<String, dynamic>.from(e))
                  .toList();
              final name = '${student['firstName'] ?? ''} ${student['lastName'] ?? ''}'.trim();
              return <Widget>[
                ListTile(
                  contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                  leading: student['photo'] != null
                      ? null // photo rendering stays on the shells; keep it light here
                      : CircleAvatar(radius: 16, child: Text(name.isNotEmpty ? name[0] : '?')),
                  title: Text(name, style: const TextStyle(fontWeight: FontWeight.w800)),
                  subtitle: Text(student['admissionNo']?.toString() ?? ''),
                ),
                ...payments.map((p) {
                  final paidAt = p['paidAt'] == null ? null : DateTime.tryParse(p['paidAt'].toString());
                  final isOnline = p['gatewayProvider']?.toString() == 'RAZORPAY';
                  return Card(
                    margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                    child: ListTile(
                      leading: Icon(
                        isOnline ? Icons.credit_card : Icons.payments_outlined,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                      title: Text(p['receiptNo']?.toString() ?? 'Receipt pending',
                          style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text([
                        if (paidAt != null) DateFormat('d MMM yyyy, h:mm a').format(paidAt.toLocal()),
                        isOnline ? 'Online' : (p['method']?.toString() ?? ''),
                      ].where((t) => t.isNotEmpty).join(' · ')),
                      trailing: Text(fmt.format(((p['amount'] ?? 0) as num).toDouble()),
                          style: const TextStyle(fontWeight: FontWeight.w800)),
                      onTap: () => ReceiptViewerScreen.openForPayment(
                        context,
                        p['id'].toString(),
                        receiptNo: p['receiptNo']?.toString(),
                      ),
                    ),
                  );
                }),
                if (payments.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                    child: Text('No payments yet for this child.', style: TextStyle(color: Colors.grey)),
                  ),
                const SizedBox(height: 8),
              ];
            }),
          ],
        ),
      ),
    );
  }
}
