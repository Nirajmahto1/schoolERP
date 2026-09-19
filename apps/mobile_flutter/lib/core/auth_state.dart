// ──────────────────────────────────────────────
// Auth state + role routing for the Flutter app.
// ──────────────────────────────────────────────

import 'package:flutter/foundation.dart';

import 'api.dart';

enum AppRole { parent, student, teacher, admin, unknown }

class AuthState extends ChangeNotifier {
  final ApiClient api = ApiClient.instance;

  bool loaded = false;
  bool authenticated = false;
  Map<String, dynamic>? me;
  List<String> roles = const [];

  AuthState() {
    api.onLogout.listen((_) => _forceLogout());
  }

  Future<void> bootstrap() async {
    final t = await api.token;
    if (t == null || t.isEmpty) {
      loaded = true;
      authenticated = false;
      notifyListeners();
      return;
    }
    final m = await api.me();
    me = m;
    roles = m?['roles'] != null
        ? (m!['roles'] as List).map((e) => e.toString()).toList()
        : const [];
    authenticated = m != null;
    loaded = true;
    notifyListeners();
  }

  /// Re-pull /me after a profile change (e.g. photo upload) so every
  /// AppBar avatar refreshes.
  Future<void> refreshMe() async {
    final m = await api.me();
    me = m;
    notifyListeners();
  }

  Future<void> login(String email, String password) async {
    final session = await api.login(email, password);
    roles = session['roles'] != null
        ? (session['roles'] as List).map((e) => e.toString()).toList()
        : const [];
    final m = await api.me();
    me = m;
    if (roles.isEmpty && m?['roles'] != null) {
      roles = (m!['roles'] as List).map((e) => e.toString()).toList();
    }
    authenticated = true;
    notifyListeners();
  }

  Future<void> logout() async {
    await api.logout();
    authenticated = false;
    me = null;
    roles = const [];
    notifyListeners();
  }

  Future<void> _forceLogout() async {
    authenticated = false;
    me = null;
    roles = const [];
    notifyListeners();
  }

  // ── Role resolution ──

  bool get isTeacher =>
      roles.any((r) => const ['TEACHER', 'HOD', 'ACADEMIC_HEAD', 'PRINCIPAL'].contains(r));
  bool get isStudent => roles.contains('STUDENT');
  bool get isParent => roles.contains('PARENT');
  bool get isAdmin =>
      roles.any((r) => const ['SUPER_ADMIN', 'BRANCH_ADMIN'].contains(r));

  /// Which shell to show. A teacher who is also a parent picks Teacher
  /// (the RN app did the same); admin lands on teacher+approvals.
  AppRole get primaryRole {
    if (isTeacher || isAdmin) return AppRole.teacher;
    if (isStudent) return AppRole.student;
    if (isParent) return AppRole.parent;
    return AppRole.unknown;
  }

  String get displayName {
    final n = me?['name']?.toString();
    if (n != null && n.isNotEmpty) return n;
    return me?['email']?.toString() ?? '';
  }
}
