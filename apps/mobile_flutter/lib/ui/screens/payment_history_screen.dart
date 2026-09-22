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
  // Filter model: null year = all time; null month = the whole selected year.
  int? _month;
  int? _year = DateTime.now().year;
  // Years are not known up-front; the visible span grows to cover the oldest
  // receipt once the unfiltered load arrives.
  int? _earliestYear;

  @override
  void initState() { super.initState(); _load(); }

  String get _filterQuery {
    final params = <String>[
      if (widget.studentId != null) 'studentId=${widget.studentId}',
      if (_year != null) 'year=$_year',
      if (_month != null && _year != null) 'month=$_month',
    ];
    return params.isEmpty ? '' : '?${params.join('&')}';
  }

  Future<void> _load() async {
    try {
      final data = await ApiClient.instance.get('/fees/history$_filterQuery');
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

  /// First unfiltered load discovers the oldest receipt so the year picker
  /// spans the child's actual payment history.
  Future<void> _discoverEarliestYear() async {
    try {
      final all = await ApiClient.instance.get('/fees/history${widget.studentId != null ? '?studentId=${widget.studentId}' : ''}');
      final rows = (all is Map ? all['data'] : null) as List<dynamic>? ?? const [];
      for (final r in rows) {
        final paidAt = DateTime.tryParse(Map<String, dynamic>.from(r as Map)['paidAt']?.toString() ?? '');
        if (paidAt != null) {
          final y = paidAt.year;
          if (_earliestYear == null || y < _earliestYear!) _earliestYear = y;
        }
      }
      if (mounted) setState(() {});
    } catch (_) { /* cosmetic only — the picker falls back to the current year */ }
  }

  static const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  @override
  Widget build(BuildContext context) {
    final fmt = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
    final title = widget.childName != null ? '${widget.childName} — Receipts' : 'Payment History';
    final years = [for (int y = DateTime.now().year; y >= (_earliestYear ?? DateTime.now().year); y--) y];
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: RefreshIndicator(
        onRefresh: () async { await _load(); await _discoverEarliestYear(); },
        child: ListViewScreen(
          // AppBar above carries the title — no double header.
          error: _error,
          empty: _groups != null && _groups!.isEmpty,
          emptyText: 'No payments in this period — clear a filter or pick another month.',
          onRetry: () async { await _load(); await _discoverEarliestYear(); },
          children: [
            // ── Filters: All · year · 12 month chips ──
            Card(
              margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Text('Period', style: Theme.of(context).textTheme.labelSmall),
                    const Spacer(),
                    // Year selector — null year renders as "All time".
                    DropdownButton<int?>(
                      value: _year,
                      underline: const SizedBox.shrink(),
                      isDense: true,
                      items: <DropdownMenuItem<int?>>[
                        const DropdownMenuItem(value: null, child: Text('All time')),
                        ...years.map((y) => DropdownMenuItem(value: y, child: Text('$y'))),
                      ],
                      onChanged: (y) { setState(() { _year = y; if (y == null) _month = null; }); _load(); },
                    ),
                  ]),
                  if (_year != null)
                    SizedBox(
                      height: 40,
                      child: ListView(
                        scrollDirection: Axis.horizontal,
                        children: [
                          ChoiceChip(
                            label: const Text('Whole year'),
                            selected: _month == null,
                            onSelected: (_) { setState(() => _month = null); _load(); },
                          ),
                          for (var m = 1; m <= 12; m++)
                            Padding(
                              padding: const EdgeInsets.only(left: 6),
                              child: ChoiceChip(
                                label: Text(_months[m - 1]),
                                selected: _month == m,
                                onSelected: (_) { setState(() => _month = m); _load(); },
                              ),
                            ),
                        ],
                      ),
                    ),
                ]),
              ),
            ),
            // ── Period total — the answer to "how much this year/month?" ──
            if (_totals != null && (_totals!['count'] ?? 0) > 0)
              Card(
                margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                color: Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.4),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(children: [
                    const Icon(Icons.receipt_long_outlined),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        '${_year == null ? "All time" : _month == null ? "$_year" : "${_months[_month! - 1]} $_year"}: ${_totals!['count']} receipt(s) · ${fmt.format(((_totals!['amount'] ?? 0) as num).toDouble())}',
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                    ),
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
                  // Row layout kept: three short, flex-safe cells — no
                  // squeeze possible (amount is fixed-width text).
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
