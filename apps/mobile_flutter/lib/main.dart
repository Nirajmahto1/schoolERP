// ──────────────────────────────────────────────
// School ERP — Flutter app entrypoint.
//
// Root router listens to AuthState: bootstrap → LoginScreen or the role
// shell (parent / student / teacher). Live sockets connect on login and
// drop on logout.
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'dart:async';

import 'core/auth_state.dart';
import 'core/brand.dart';
import 'core/host.dart';
import 'core/sockets.dart';
import 'ui/theme.dart';
import 'ui/screens/login_screen.dart';
import 'ui/shells/parent_shell.dart';
import 'ui/shells/student_shell.dart';
import 'ui/shells/teacher_shell.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Resolve the dev API host (probe candidates) before any API/WS call.
  await HostConfig.instance.ensureResolved();
  // School branding for the AppBars (public endpoint, safe to fire-and-forget).
  SchoolBrand.instance.ensureLoaded();
  runApp(const SchoolErpApp());
}

class SchoolErpApp extends StatelessWidget {
  const SchoolErpApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthState()..bootstrap()),
        ChangeNotifierProvider(create: (_) => SchoolBrand.instance),
      ],
      child: MaterialApp(
        title: 'EduCore',
        navigatorKey: rootNavigatorKey,
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        darkTheme: AppTheme.dark(),
        themeMode: ThemeMode.system,
        home: const RootRouter(),
      ),
    );
  }
}

class RootRouter extends StatefulWidget {
  const RootRouter({super.key});

  @override
  State<RootRouter> createState() => _RootRouterState();
}

/// Global navigator key — live server frames (fine alerts, leave decisions)
/// surface as in-app banners no matter which screen is showing.
final rootNavigatorKey = GlobalKey<NavigatorState>();

class _RootRouterState extends State<RootRouter> {
  StreamSubscription<LiveNotification>? _liveSub;

  @override
  void initState() {
    super.initState();
    context.read<AuthState>().addListener(_onAuthChanged);
    // Live WS frames → in-app banner. The server's durable channel is FCM
    // (works when the app is closed); this covers the open-app experience —
    // the parent sees the fine the moment the sweep or the office applies it.
    _liveSub = NotifySocket.instance.notifications.listen((n) {
      // The stream fires outside the build cycle; the navigator key is the
      // mount-point-anchored context (never unmounted), so sync access here
      // is safe — no async-gap lint applies to the GlobalKey itself.
      // ignore: use_build_context_synchronously
      final messenger = ScaffoldMessenger.maybeOf(rootNavigatorKey.currentContext!);
      if (messenger == null) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          duration: const Duration(seconds: 6),
          behavior: SnackBarBehavior.floating,
          backgroundColor: n.kind == 'FEE_LATE_FINE' ? Colors.deepOrange.shade700 : null,
          content: Text('${n.title}\n${n.body}', style: const TextStyle(height: 1.3)),
        ));
    });
  }

  void _onAuthChanged() {
    final auth = context.read<AuthState>();
    if (auth.authenticated) {
      NotifySocket.instance.connect();
    } else {
      NotifySocket.instance.disconnect();
      ChatSocket.instance.disconnect();
    }
  }

  @override
  void dispose() {
    _liveSub?.cancel();
    context.read<AuthState>().removeListener(_onAuthChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    if (!auth.loaded) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!auth.authenticated) return const LoginScreen();
    return switch (auth.primaryRole) {
      AppRole.parent => const ParentShell(),
      AppRole.student => const StudentShell(),
      AppRole.teacher || AppRole.admin => const TeacherShell(),
      AppRole.unknown => Scaffold(
          appBar: AppBar(title: const Text('EduCore')),
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('This account has no app role.'),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: auth.logout,
                    child: const Text('Sign out'),
                  ),
                ],
              ),
            ),
          ),
        ),
    };
  }
}
