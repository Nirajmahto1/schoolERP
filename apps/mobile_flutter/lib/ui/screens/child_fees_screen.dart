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
import '../screens/receipt_viewer_screen.dart';
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
          // Open the numbered receipt right from the capture result.
          final payId = payment['id']?.toString();
          if (payId != null) {
            await ReceiptViewerScreen.openForPayment(context, payId, receiptNo: payment['receiptNo']?.toString());
          }
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
      // Own AppBar — this screen is pushed, so it carries the back button.
      // (An earlier fix removed the INNER ListViewScreen title; the outer bar
      // must stay or the screen has no header at all.)
      appBar: AppBar(title: Text(widget.child.name, overflow: TextOverflow.ellipsis)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListViewScreen(
          // AppBar above carries the title — no double header.
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
              // Column layout — ListTile+trailing squeezed titles to one
              // character per line on narrow phones.
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(
                        child: Text(f.title, style: const TextStyle(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: isDue ? Colors.orange.shade50 : Colors.green.shade50,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          isDue ? 'Due' : 'Paid',
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: isDue ? Colors.orange.shade900 : Colors.green.shade800),
                        ),
                      ),
                    ]),
                    const SizedBox(height: 4),
                    Text(
                      '${f.invoiceNo} · paid ${fmt.format(f.paid)} of ${fmt.format(f.amount)}'
                      '${f.dueDate != null ? ' · due ${DateFormat('d MMM yyyy').format(f.dueDate!)}' : ''}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 8),
                    Row(children: [
                      Expanded(
                        child: Text(
                          isDue ? 'Outstanding ${fmt.format(f.due)}' : 'Settled',
                          style: TextStyle(fontWeight: FontWeight.w700, color: isDue ? Colors.red.shade700 : Colors.green.shade700),
                        ),
                      ),
                      if (isDue)
                        FilledButton(
                          onPressed: _payingId == f.id ? null : () => _pay(f),
                          child: _payingId == f.id
                              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                              : Text('Pay ${fmt.format(f.due)}'),
                        )
                      else
                        TextButton.icon(
                          onPressed: () => ReceiptViewerScreen.openForInvoice(context, f.id),
                          icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
                          label: const Text('Receipt'),
                        ),
                    ]),
                  ]),
                ),
              );
            }),
          ],
        ),
      ),
    );
  }
}
