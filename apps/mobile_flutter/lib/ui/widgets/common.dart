// ──────────────────────────────────────────────
// Shared list-screen scaffold: loading / error / empty / content states
// in one place so every tab looks the same.
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/auth_state.dart';
import '../../core/brand.dart';
import '../../core/photo.dart';
import '../../core/sockets.dart';

class ListViewScreen extends StatelessWidget {
  final String title;
  final String? error;
  final bool empty;
  final String emptyText;
  final Future<void> Function()? onRetry;
  final List<Widget> children;

  const ListViewScreen({
    super.key,
    required this.title,
    this.error,
    required this.empty,
    required this.emptyText,
    this.onRetry,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    final loading = error == null && !empty && children.isEmpty;
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : error != null
                  ? _ErrorView(message: error!, onRetry: onRetry)
                  : empty
                      ? Center(child: Text(emptyText, style: Theme.of(context).textTheme.bodyLarge))
                      : ListView(physics: const AlwaysScrollableScrollPhysics(), children: children),
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String message;
  final Future<void> Function()? onRetry;

  const _ErrorView({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_rounded, size: 40, color: Colors.grey.shade500),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              OutlinedButton(onPressed: () => onRetry!(), child: const Text('Retry')),
            ],
          ],
        ),
      ),
    );
  }
}

class StatusChip extends StatelessWidget {
  final String label;
  final Color color;
  const StatusChip({super.key, required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(999)),
      child: Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
    );
  }
}

/// AppBar logout button — same behavior on every shell: best-effort server
/// logout, drop local session + live sockets. AuthState flips the root router
/// back to the login screen.
class LogoutAction extends StatelessWidget {
  const LogoutAction({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Sign out',
      icon: const Icon(Icons.logout),
      onPressed: () async {
        final auth = context.read<AuthState>();
        final messenger = ScaffoldMessenger.of(context);
        ChatSocket.instance.disconnect();
        NotifySocket.instance.disconnect();
        await auth.logout();
        messenger.showSnackBar(const SnackBar(content: Text('Signed out')));
      },
    );
  }
}

/// The user avatar: photo when the account has one, else initials on a tinted
/// circle. Tap → confirmation sheet with profile + sign-out.
class AvatarAction extends StatelessWidget {
  const AvatarAction({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final photo = auth.me?['photo']?.toString();
    final name = auth.me?['name']?.toString() ?? auth.displayName;
    final initials = name.isNotEmpty
        ? name.trim().split(RegExp(r'\s+')).take(2).map((w) => w[0].toUpperCase()).join()
        : '?';
    final avatar = photo != null && photo.isNotEmpty
        ? CircleAvatar(
            radius: 16,
            backgroundImage: AuthPhotoProvider(photo),
            onBackgroundImageError: (_, __) {},
          )
        : CircleAvatar(radius: 16, backgroundColor: Theme.of(context).colorScheme.primaryContainer, child: Text(initials, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)));

    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: GestureDetector(
        onTap: () => _showProfileSheet(context, auth, name),
        child: avatar,
      ),
    );
  }

  void _showProfileSheet(BuildContext context, AuthState auth, String name) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(name, style: Theme.of(ctx).textTheme.titleMedium),
            Text(auth.me?['email']?.toString() ?? '', style: Theme.of(ctx).textTheme.bodySmall),
            const SizedBox(height: 4),
            Text(auth.roles.join(' · '), style: Theme.of(ctx).textTheme.labelSmall),
            const SizedBox(height: 16),
            FilledButton.tonalIcon(
              onPressed: () async {
                Navigator.pop(ctx);
                await _pickAndUploadPhoto(context, auth);
              },
              icon: const Icon(Icons.add_a_photo_outlined),
              label: const Text('Set profile photo'),
            ),
            const SizedBox(height: 8),
            FilledButton.tonalIcon(
              onPressed: () async {
                Navigator.pop(ctx);
                ChatSocket.instance.disconnect();
                NotifySocket.instance.disconnect();
                await auth.logout();
              },
              icon: const Icon(Icons.logout),
              label: const Text('Sign out'),
            ),
          ]),
        ),
      ),
    );
  }

  Future<void> _pickAndUploadPhoto(BuildContext context, AuthState auth) async {
    try {
      final picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1024,
        maxHeight: 1024,
        imageQuality: 85,
      );
      if (picked == null) return;
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Uploading photo…')));
      final bytes = await picked.readAsBytes();
      final ext = picked.name.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      await ApiClient.instance.uploadFile(
        '/photos/me',
        field: 'photo',
        filename: 'photo.$ext',
        bytes: bytes,
      );
      AuthPhotoProvider.clearCache();
      await auth.refreshMe();
      if (context.mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(content: Text('Photo updated ✓')));
      }
    } on ApiError catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(e.detail)));
      }
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(content: Text('Could not upload photo')));
      }
    }
  }
}

/// The school logo (right side of every AppBar). Hidden on screens where it
/// competes with live status indicators — the student chat tab passes false.
class SchoolLogoAction extends StatefulWidget {
  const SchoolLogoAction({super.key});

  @override
  State<SchoolLogoAction> createState() => _SchoolLogoActionState();
}

class _SchoolLogoActionState extends State<SchoolLogoAction> {
  bool _broken = false;

  @override
  Widget build(BuildContext context) {
    final brand = context.watch<SchoolBrand>();
    final url = brand.logoUrl;
    if (url == null || _broken) {
      return const Padding(
        padding: EdgeInsets.only(right: 8),
        child: Icon(Icons.school_rounded, size: 26),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Image.network(
        url,
        height: 28,
        errorBuilder: (ctx, err, stack) {
          if (!_broken) WidgetsBinding.instance.addPostFrameCallback((_) => mounted ? setState(() => _broken = true) : null);
          return const Icon(Icons.school_rounded, size: 26);
        },
      ),
    );
  }
}
