// ──────────────────────────────────────────────
// Parent shell — children summary, fees with Razorpay checkout,
// announcements, profile. The Dart port of the RN parent app.
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/auth_state.dart';
import '../../core/brand.dart';
import '../../core/models.dart';
import '../../core/photo.dart';
import '../screens/child_fees_screen.dart';
import '../screens/checkout_screen.dart';
import '../screens/payment_history_screen.dart';
import '../screens/receipt_viewer_screen.dart';
import '../widgets/common.dart';
import 'package:intl/intl.dart';

class ParentShell extends StatefulWidget {
  const ParentShell({super.key});

  @override
  State<ParentShell> createState() => _ParentShellState();
}

class _ParentShellState extends State<ParentShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    const tabs = [ChildrenTab(), FeesTab(), AnnouncementsTab(), ProfileTab()];
    return Scaffold(
      body: tabs[_tab],
      appBar: AppBar(
        title: Text(switch (_tab) { 0 => 'My Children', 1 => 'Fees', 2 => 'Announcements', _ => 'Profile' }),
        leading: const AvatarAction(),
        actions: const [SchoolLogoAction(), LogoutAction()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.family_restroom_outlined), selectedIcon: Icon(Icons.family_restroom), label: 'Children'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'Fees'),
          NavigationDestination(icon: Icon(Icons.campaign_outlined), selectedIcon: Icon(Icons.campaign), label: 'News'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}

class ChildrenTab extends StatefulWidget {
  const ChildrenTab({super.key});

  @override
  State<ChildrenTab> createState() => _ChildrenTabState();
}

class _ChildrenTabState extends State<ChildrenTab> {
  List<Child>? _children;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      // children-summary returns {students: [...]} — .list() only unwraps
      // {data: [...]}/bare arrays, so it always produced an empty Children
      // tab while the Fees tab (fixed earlier) worked. Same unwrap here.
      final data = await ApiClient.instance.get('/parents/me/children-summary');
      final students = (data is Map ? data['students'] : data) as List<dynamic>? ?? const [];
      if (!mounted) return;
      setState(() { _children = students.map((e) => Child.fromJson(Map<String, dynamic>.from(e))).toList(); _error = null; });
    } on ApiError catch (e) {
      setState(() => _error = e.detail);
    } catch (_) {
      setState(() => _error = 'Network error');
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _load,
      child: ListViewScreen(
        error: _error,
        empty: _children != null && _children!.isEmpty,
        emptyText: 'No linked children',
        onRetry: _load,
        children: (_children ?? []).map((c) => Card(
          margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          // Column layout on purpose — a ListTile with a trailing
          // [IconButton, Pay ₹…] row squeezed the name/subtitle on narrow
          // phones (same bug class as the fee rows).
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                GestureDetector(
                  onTap: () => _uploadChildPhoto(c),
                  child: Stack(children: [
                    c.photo != null && c.photo!.isNotEmpty
                        ? CircleAvatar(radius: 22, backgroundImage: AuthPhotoProvider(c.photo!))
                        : CircleAvatar(radius: 22, child: Text(c.name.isNotEmpty ? c.name[0] : '?')),
                    const Positioned(
                      right: -2, bottom: -2,
                      child: CircleAvatar(radius: 9, backgroundColor: Colors.blueGrey, child: Icon(Icons.camera_alt, size: 10, color: Colors.white)),
                    ),
                  ]),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(c.name, style: const TextStyle(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
                    Text('${c.className ?? '-'} ${c.section ?? ''} · ${c.admissionNo}',
                        style: Theme.of(context).textTheme.bodySmall, overflow: TextOverflow.ellipsis),
                  ]),
                ),
              ]),
              const SizedBox(height: 8),
              Text('Attendance ${c.attendancePct.toStringAsFixed(0)}%  ·  Due ₹${c.dueAmount.toStringAsFixed(0)}',
                  style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => _openHistory(c),
                    icon: const Icon(Icons.receipt_long_outlined, size: 18),
                    label: const Text('Receipts', overflow: TextOverflow.ellipsis),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: c.dueAmount > 0.5
                      ? FilledButton(onPressed: () => _openFees(c), child: Text('Pay ₹${c.dueAmount.toStringAsFixed(0)}', overflow: TextOverflow.ellipsis))
                      : OutlinedButton(onPressed: () => _openFees(c), child: const Text('Fees', overflow: TextOverflow.ellipsis)),
                ),
              ]),
            ]),
          ),
        )).toList(),
      ),
    );
  }

  /// Drill into one child's fees — the checkout entry point. The screen
  /// loads that child's openInvoices and drives the real Razorpay flow.
  void _openFees(Child c) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => ChildFeesScreen(child: c)),
    );
  }

  /// Every settled receipt for this child, newest first — the parent's
  /// payment ledger. Server-scoped to the caller's own children.
  void _openHistory(Child c) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => PaymentHistoryScreen(studentId: c.id, childName: c.name),
      ),
    );
  }

  /// Parent sets the photo of one of their OWN children — the server checks
  /// the guardian→student link, so a stale card can only fail cleanly.
  Future<void> _uploadChildPhoto(Child c) async {
    try {
      final picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1024,
        maxHeight: 1024,
        imageQuality: 85,
      );
      if (picked == null || !mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Uploading photo for ${c.name}…')));
      final bytes = await picked.readAsBytes();
      final ext = picked.name.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      await ApiClient.instance.uploadFile(
        '/photos/children/${c.id}',
        field: 'photo',
        filename: 'photo.$ext',
        bytes: bytes,
      );
      AuthPhotoProvider.clearCache();
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text('Photo updated for ${c.name} ✓')));
      }
    } on ApiError catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(e.detail)));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(content: Text('Could not upload photo')));
      }
    }
  }
}

class FeesTab extends StatefulWidget {
  const FeesTab({super.key});

  @override
  State<FeesTab> createState() => _FeesTabState();
}

/// Fees for the LOGGED-IN viewer, resolved through /parents/me/children-summary:
///   • a PARENT sees every linked child as a section, each with that child's
///     open invoices (openInvoices) and a pay action per invoice;
///   • a STUDENT self-resolves to one row — the same screen serves both
///     shells, so /students/my-fees (string-formatted, unpayable) is retired.
///
/// Paying mints a server order (amount computed from the DB, never the
/// client), opens the Razorpay checkout sheet, and verifies through
/// /fees/checkout/verify — the production capture path.
class _FeesTabState extends State<FeesTab> {
  List<Map<String, dynamic>>? _children;
  String? _error;
  String? _payingId;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      // children-summary returns {students: [...]} — .get(), not .list().
      final data = await ApiClient.instance.get('/parents/me/children-summary');
      final students = (data is Map ? data['students'] : data) as List<dynamic>? ?? const [];
      if (!mounted) return;
      setState(() {
        _children = students.map((e) => Map<String, dynamic>.from(e)).toList();
        _error = null;
      });
    } on ApiError catch (e) {
      setState(() => _error = e.detail);
    } catch (_) {
      setState(() => _error = 'Network error');
    }
  }

  Future<void> _pay(Map<String, dynamic> child, Map<String, dynamic> inv) async {
    setState(() => _payingId = inv['id']?.toString());
    try {
      // 1. Server-minted Razorpay order for THIS invoice's outstanding.
      final order = await ApiClient.instance.post('/fees/checkout/orders', body: {
        'studentId': child['id'],
        'invoiceIds': [inv['id']],
      });
      final o = Map<String, dynamic>.from(order as Map);
      final keyId = o['keyId']?.toString() ?? '';
      if (keyId.isEmpty) {
        throw ApiError(503, 'Online payments are not configured on this deployment.');
      }
      if (!mounted) return;
      // 2. Checkout sheet; the screen runs /fees/checkout/verify itself.
      final result = await RazorpayCheckoutScreen.open(
        context,
        orderId: o['orderId'].toString(),
        amountRupees: (o['amount'] as num).toDouble(),
        keyId: keyId,
        schoolName: SchoolBrand.instance.name ?? 'School Fees',
      );
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
        // The number the accountant reconciles against is now one tap away:
        // open the numbered receipt straight from the capture result.
        final payId = payment['id']?.toString();
        if (payId != null && mounted) {
          await ReceiptViewerScreen.openForPayment(context, payId, receiptNo: payment['receiptNo']?.toString());
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
    return RefreshIndicator(
      onRefresh: _load,
      child: ListViewScreen(
        error: _error,
        empty: _children != null && _children!.isEmpty,
        emptyText: 'No student linked to this account',
        onRetry: _load,
        children: (_children ?? []).expand((child) {
          final invoices = ((child['openInvoices'] ?? const []) as List<dynamic>)
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          final name = '${child['firstName'] ?? ''} ${child['lastName'] ?? ''}'.trim();
          final totalDue = invoices.fold<double>(0, (s, i) => s + ((i['outstanding'] ?? 0) as num).toDouble());
          return <Widget>[
            // Section header — compact row, never squeezed by trailing actions.
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
              child: Row(children: [
                const Icon(Icons.school_outlined, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(name,
                      style: const TextStyle(fontWeight: FontWeight.w800),
                      overflow: TextOverflow.ellipsis),
                ),
                Text('Outstanding ${fmt.format(totalDue)}',
                    style: TextStyle(fontSize: 12, color: totalDue > 0.5 ? Colors.red.shade700 : Colors.green.shade700, fontWeight: FontWeight.w600)),
              ]),
            ),
            ...invoices.map((inv) {
              final outstanding = ((inv['outstanding'] ?? 0) as num).toDouble();
              final isDue = outstanding > 0.5;
              final status = inv['status']?.toString() ?? '';
              final isPaid = status == 'PAID' || (!isDue && status != 'DRAFT');
              // Column layout on purpose: ListTile+trailing-button
              // compositions squeezed the title to one character per line on
              // narrow phones (screenshot bug). Nothing here can steal width
              // from the text.
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(
                        child: Text(inv['type']?.toString() ?? 'School Fee',
                            style: const TextStyle(fontWeight: FontWeight.w700),
                            overflow: TextOverflow.ellipsis),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: isPaid ? Colors.green.shade50 : Colors.orange.shade50,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          isPaid ? 'Paid' : status,
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: isPaid ? Colors.green.shade800 : Colors.orange.shade900),
                        ),
                      ),
                    ]),
                    const SizedBox(height: 4),
                    Text(
                      'Invoice ${inv['invoiceNo'] ?? ''} · Total ${fmt.format(((inv['totalAmount'] ?? 0) as num).toDouble())}'
                      '${inv['dueDate'] != null ? ' · Due ${DateFormat('d MMM yyyy').format(DateTime.parse(inv['dueDate'].toString()))}' : ''}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 8),
                    if (isDue) ...[
                      Text(
                        'Outstanding ${fmt.format(outstanding)}',
                        style: TextStyle(fontWeight: FontWeight.w700, color: Colors.red.shade700),
                      ),
                      const SizedBox(height: 8),
                      // Full-width Pay — same affordance as the per-child
                      // screen; nothing competes with it for width.
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: _payingId == inv['id'].toString() ? null : () => _pay(child, inv),
                          icon: _payingId == inv['id'].toString()
                              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                              : const Icon(Icons.payment_outlined, size: 18),
                          label: Text('Pay ${fmt.format(outstanding)}'),
                        ),
                      ),
                    ] else
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: () => ReceiptViewerScreen.openForInvoice(context, inv['id'].toString()),
                          icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
                          label: const Text('View receipt'),
                        ),
                      ),
                  ]),
                ),
              );
            }),
            if (invoices.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                child: Text('No open invoices — nothing to pay 🎉', style: TextStyle(color: Colors.green)),
              ),
            // Per-child receipt history — one tap from the section header.
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                leading: const Icon(Icons.receipt_long_outlined),
                title: Text('All receipts for $name', style: const TextStyle(fontWeight: FontWeight.w600)),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => PaymentHistoryScreen(
                    studentId: child['id']?.toString(),
                    childName: name,
                  ),
                )),
              ),
            ),
            const SizedBox(height: 8),
          ];
        }).toList(),
      ),
    );
  }
}

class AnnouncementsTab extends StatefulWidget {
  const AnnouncementsTab({super.key});

  @override
  State<AnnouncementsTab> createState() => _AnnouncementsTabState();
}

class _AnnouncementsTabState extends State<AnnouncementsTab> {
  List<Announcement>? _items;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final rows = await ApiClient.instance.list('/communication/announcements');
      setState(() { _items = rows.map((e) => Announcement.fromJson(Map<String, dynamic>.from(e))).toList(); _error = null; });
    } on ApiError catch (e) {
      setState(() => _error = e.detail);
    } catch (_) {
      setState(() => _error = 'Network error');
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _load,
      child: ListViewScreen(
        title: 'Announcements',
        error: _error,
        empty: _items != null && _items!.isEmpty,
        emptyText: 'Nothing yet',
        onRetry: _load,
        children: (_items ?? []).map((a) => Card(
          margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(a.title, style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text(DateFormat('d MMM').format(a.createdAt), style: Theme.of(context).textTheme.labelSmall),
              const SizedBox(height: 8),
              Text(a.content),
            ]),
          ),
        )).toList(),
      ),
    );
  }
}

class ProfileTab extends StatelessWidget {
  const ProfileTab({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    return ListView(
      children: [
        const SizedBox(height: 24),
        const CircleAvatar(radius: 36, child: Icon(Icons.person, size: 40)),
        const SizedBox(height: 12),
        Center(child: Text(auth.displayName, style: Theme.of(context).textTheme.titleMedium)),
        Center(child: Text(auth.roles.join(', '), style: Theme.of(context).textTheme.labelSmall)),
        const SizedBox(height: 24),
        ListTile(
          leading: const Icon(Icons.logout),
          title: const Text('Sign out'),
          onTap: auth.logout,
        ),
      ],
    );
  }
}
