// ──────────────────────────────────────────────
// School branding — fetches the public /setup/school profile once and
// resolves the gateway-relative logoUrl to an absolute URL, exactly like the
// web app's AuthContext.resolveLogoUrl. Used by every shell AppBar.
// ──────────────────────────────────────────────

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'host.dart';

class SchoolBrand extends ChangeNotifier {
  SchoolBrand._();
  static final SchoolBrand instance = SchoolBrand._();

  String? name;
  String? code;
  String? _logoUrl; // gateway-relative, e.g. /setup/logo/logo_123_abc.png

  bool _loaded = false;
  bool get loaded => _loaded;

  /// Absolute logo URL against the resolved gateway origin, or null when the
  /// school has no logo (callers show a fallback glyph).
  String? get logoUrl =>
      _logoUrl == null ? null : 'http://${HostConfig.instance.host}:4000$_logoUrl';

  Future<void> ensureLoaded() async {
    if (_loaded) return;
    _loaded = true; // one attempt per process; refresh() re-runs deliberately
    await refresh();
  }

  Future<void> refresh() async {
    try {
      final data = await ApiClient.instance.get('/setup/school', auth: false);
      name = data['name']?.toString();
      code = data['code']?.toString();
      _logoUrl = data['logoUrl']?.toString();
      notifyListeners();
    } catch (_) {
      // Branding is decorative — never block the app on it.
    }
  }
}
