// ──────────────────────────────────────────────
// Fees screen (parent + student) — real Razorpay checkout, per child.
//
// Parents: the Children tab drills into one child; invoices come from that
// child's `openInvoices` on /parents/me/children-summary (a parent has no
// /students/my-fees — that route is the student's own view).
// Students: the Fees tab self-resolves via children-summary, same shape.
//
// The Pay button mints a server order (amount computed from the DB, never
// the client), opens the Razorpay checkout WebView, and verifies the signed
// callback through /fees/checkout/verify — the same production capture path
// the web console uses. Receipt number comes back in the payment row.
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/brand.dart';
import '../screens/checkout_screen.dart';
import '../widgets/common.dart';

class ChildFeesScreen extends StatefulWidget {
  const ChildFeesScreen({super.key, required this.child});

  final Child child;

  @override
  State<ChildFeesScreen> createState() => _ChildFeesScreenState();
}

class _ChildFeesScreenState extends State<ChildFeesScreen> {
  List<FeeItem>? _items;
  String? _error;
  String? _payingId;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      // children-summary returns {students: [...]} — .get(), not .list().
      final data = await ApiClient.instance.get('/parents/me/children-summary');
      final students = (data is Map ? data['students'] : data) as List<dynamic>? ?? const [];
      final match = students.map((e) => Map<String, dynamic>.from(e)).firstWhere(
            (s) => s['id'] == widget.child.id,
            orElse: () => const {},
          );
      final invoices = (match['openInvoices'] ?? const []) as List<dynamic>;
      setState(() {
        _items = invoices.map((e) => FeeItem.fromJson(Map<String, dynamic>.from(e))).toList();
        _error = null;
      });
    } on ApiError catch (e) {
      setState(() => _error = e.detail);
    } catch (_) {
      setState(() => _error = 'Network error');
    }
  }

  Future<void> _pay(FeeItem item) async {
    setState(() => _payingId = item.id);
    try {
      // 1. Server-minted order — the amount comes from OUR open invoices.
      //    invoiceIds narrows checkout to this invoice's outstanding only.
      final order = await ApiClient.instance.post('/fees/checkout/orders', body: {
        'studentId': widget.child.id,
        'invoiceIds': [item.id],
      });
      final o = Map<String, dynamic>.from(order as Map);
      final keyId = o['keyId']?.toString() ?? '';
      if (keyId.isEmpty) {
        throw ApiError(503, 'Online payments are not configured on this deployment.');
      }
      if (!mounted) return;
      // 2. Platform checkout sheet (WebView host of checkout.js).
      final result = await RazorpayCheckoutScreen.open(
        context,
        orderId: o['orderId'].toString(),
        amountRupees: (o['amount'] as num).toDouble(),
        keyId: keyId,
        schoolName: SchoolBrand.instance.name ?? 'School Fees',
      );
      // 3. The screen already ran /fees/checkout/verify — refresh.
      if (result != null && result['captured'] == true) {
        final payment = Map<String, dynamic>.from((result['payment'] ?? const {}) as Map);
        if (mounted) {
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(SnackBar(
              content: Text(payment['receiptNo'] != null
                  ? 'Payment captured — receipt ${payment['receiptNo']}'
                  : 'Payment captured ✓'),
            ));
        }
      }
      await _load();
    } on ApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.detail)));
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not start checkout')));
    } finally {
      if (mounted) setState(() => _payingId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final fmt = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
    final totalDue = (_items ?? []).fold<double>(0, (s, i) => s + i.due);
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListViewScreen(
          title: '${widget.child.name} — Fees',
          error: _error,
          empty: _items != null && _items!.isEmpty,
          emptyText: 'No invoices for ${widget.child.name} — nothing to pay 🎉',
          onRetry: _load,
          children: [
            if (totalDue > 0.5)
              Card(
                margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                color: Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.4),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(children: [
                    const Icon(Icons.account_balance_wallet_outlined),
                    const SizedBox(width: 10),
                    Expanded(child: Text('Total outstanding: ${fmt.format(totalDue)}', style: const TextStyle(fontWeight: FontWeight.w700))),
                  ]),
                ),
              ),
            ...(_items ?? []).map((f) {
              final isDue = f.due > 0.5;
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                child: ListTile(
                  title: Text(f.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text('${f.invoiceNo} · paid ${fmt.format(f.paid)} of ${fmt.format(f.amount)}'
                      '${f.dueDate != null ? ' · due ${DateFormat('d MMM yyyy').format(f.dueDate!)}' : ''}'),
                  trailing: isDue
                      ? FilledButton(
                          onPressed: _payingId == f.id ? null : () => _pay(f),
                          child: _payingId == f.id
                              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                              : Text('Pay ${fmt.format(f.due)}'),
                        )
                      : Chip(label: const Text('Paid'), backgroundColor: Colors.green.shade50),
                ),
              );
            }),
          ],
        ),
      ),
    );
  }
}
