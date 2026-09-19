// ──────────────────────────────────────────────
// Parent shell — children summary, fees with Razorpay checkout,
// announcements, profile. The Dart port of the RN parent app.
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/auth_state.dart';
import '../../core/models.dart';
import '../../core/photo.dart';
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
      final rows = await ApiClient.instance.list('/parents/me/children-summary');
      setState(() { _children = rows.map((e) => Child.fromJson(Map<String, dynamic>.from(e))).toList(); _error = null; });
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
        title: 'My Children',
        error: _error,
        empty: _children != null && _children!.isEmpty,
        emptyText: 'No linked children',
        onRetry: _load,
        children: (_children ?? []).map((c) => Card(
          margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: ListTile(
            leading: GestureDetector(
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
            title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Text('${c.className ?? '-'} ${c.section ?? ''} · ${c.admissionNo}\nAttendance ${c.attendancePct.toStringAsFixed(0)}%  ·  Due ₹${c.dueAmount.toStringAsFixed(0)}'),
            isThreeLine: true,
            trailing: const Icon(Icons.chevron_right),
          ),
        )).toList(),
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

class _FeesTabState extends State<FeesTab> {
  List<FeeItem>? _items;
  String? _error;
  String? _payingInvoiceId;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final rows = await ApiClient.instance.list('/students/my-fees');
      setState(() { _items = rows.map((e) => FeeItem.fromJson(Map<String, dynamic>.from(e))).toList(); _error = null; });
    } on ApiError catch (e) {
      setState(() => _error = e.detail);
    } catch (_) {
      setState(() => _error = 'Network error');
    }
  }

  Future<void> _pay(FeeItem item) async {
    setState(() => _payingInvoiceId = item.id);
    try {
      // 1. Ask the backend for a Razorpay order (INITIATED payment row).
      final order = await ApiClient.instance.post('/fees/checkout/orders', body: {
        'invoiceId': item.id,
        'amount': item.due,
      });
      final o = Map<String, dynamic>.from(order as Map);
      // 2. Hand the order to the platform checkout sheet.
      //    (Native Razorpay SDK lands with the dev-client build; Expo/Play
      //    releases ship the same contract.)
      // ignore: avoid_print
      print('Razorpay order ${o['orderId']} for ${o['amount']}');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Checkout order created — native sheet ships with the next build')),
        );
      }
      await _load();
    } on ApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.detail)));
    } finally {
      if (mounted) setState(() => _payingInvoiceId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final fmt = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
    return RefreshIndicator(
      onRefresh: _load,
      child: ListViewScreen(
        title: 'Fees',
        error: _error,
        empty: _items != null && _items!.isEmpty,
        emptyText: 'No invoices yet',
        onRetry: _load,
        children: (_items ?? []).map((f) {
          final isDue = f.due > 0.5;
          return Card(
            margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: ListTile(
              title: Text(f.title, style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text('${f.invoiceNo} · paid ${fmt.format(f.paid)} of ${fmt.format(f.amount)}'),
              trailing: isDue
                  ? FilledButton.tonal(
                      onPressed: _payingInvoiceId == f.id ? null : () => _pay(f),
                      child: _payingInvoiceId == f.id
                          ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : Text('Pay ${fmt.format(f.due)}'),
                    )
                  : Chip(label: const Text('Paid'), backgroundColor: Colors.green.shade50),
            ),
          );
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
