// ──────────────────────────────────────────────
// API client — the Dart port of apps/mobile/lib/api.ts.
//
// Same contract: JSON in/out, Bearer token from secure storage, single-flight
// rotating refresh on 401 (a second concurrent refresh with the same token
// fails as "reused" and logs the user out), typed ApiError with status.
// ──────────────────────────────────────────────

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'host.dart';

class ApiError implements Exception {
  final int status;
  final String detail;
  final Map<String, dynamic>? body;

  ApiError(this.status, this.detail, [this.body]);

  bool get isAuthError => status == 401 || status == 403;

  @override
  String toString() => detail;
}

/// Token storage keys — same AsyncStorage keys the RN app used, so a
// device that already logged in keeps its session shape.
const _kTokenKey = 'erp_token';
const _kRefreshKey = 'erp_refresh';

class ApiClient {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  final _storage = const FlutterSecureStorage();

  /// Set when a 401 refresh chain fails irrecoverably — the shell listens
  /// and forces logout.
  final _logoutController = StreamController<void>.broadcast();
  Stream<void> get onLogout => _logoutController.stream;

  String? _accessToken;
  Completer<bool>? _refreshing;

  Future<String?> get token async {
    _accessToken ??= await _storage.read(key: _kTokenKey);
    return _accessToken;
  }

  Future<void> saveSession({
    required String accessToken,
    String? refreshToken,
  }) async {
    _accessToken = accessToken;
    await _storage.write(key: _kTokenKey, value: accessToken);
    if (refreshToken != null) {
      await _storage.write(key: _kRefreshKey, value: refreshToken);
    }
  }

  Future<void> clearSession() async {
    _accessToken = null;
    await _storage.delete(key: _kTokenKey);
    await _storage.delete(key: _kRefreshKey);
  }

  Future<Map<String, String>> _headers({bool auth = true}) async {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (auth) {
      final t = await token;
      if (t != null && t.isNotEmpty) h['Authorization'] = 'Bearer $t';
    }
    return h;
  }

  /// GET/POST/... the gateway. Returns the decoded JSON body.
  Future<dynamic> request(
    String method,
    String path, {
    Object? body,
    bool auth = true,
    bool retryOn401 = true,
  }) async {
    final uri = Uri.parse('$kApiBase$path');
    final req = http.Request(method, uri)
      ..headers.addAll(await _headers(auth: auth))
      ..body = body == null ? '' : jsonEncode(body);
    final streamed = await req.send().timeout(const Duration(seconds: 20));
    final res = await http.Response.fromStream(streamed);

    if (res.statusCode == 401 && auth && retryOn401) {
      final refreshed = await _refreshSingleFlight();
      if (refreshed) {
        return request(method, path, body: body, auth: auth, retryOn401: false);
      }
      await clearSession();
      _logoutController.add(null);
      throw ApiError(401, 'Session expired — please log in again.');
    }

    final dynamic decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    if (res.statusCode >= 400) {
      final detail = decoded is Map && decoded['detail'] != null
          ? decoded['detail'].toString()
          : 'Request failed (${res.statusCode})';
      throw ApiError(res.statusCode, detail, decoded is Map<String, dynamic> ? decoded : null);
    }
    return decoded;
  }

  Future<dynamic> get(String path, {bool auth = true}) =>
      request('GET', path, auth: auth);

  Future<dynamic> post(String path, {Object? body, bool auth = true}) =>
      request('POST', path, body: body, auth: auth);

  Future<dynamic> patch(String path, {Object? body, bool auth = true}) =>
      request('PATCH', path, body: body, auth: auth);

  Future<dynamic> delete(String path, {bool auth = true}) =>
      request('DELETE', path, auth: auth);

  /// Multipart file upload (profile photos). Returns the decoded JSON body.
  /// The server sniffs the bytes, so contentType is advisory — a renamed
  /// .txt still dies with 415.
  Future<dynamic> uploadFile(
    String path, {
    required String field,
    required String filename,
    required List<int> bytes,
  }) async {
    final uri = Uri.parse('$kApiBase$path');
    final req = http.MultipartRequest('POST', uri)
      ..headers.addAll(await _headers(auth: true))
      ..files.add(http.MultipartFile.fromBytes(field, bytes, filename: filename));
    final streamed = await req.send().timeout(const Duration(seconds: 30));
    final res = await http.Response.fromStream(streamed);
    final dynamic decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    if (res.statusCode >= 400) {
      final detail = decoded is Map && decoded['detail'] != null
          ? decoded['detail'].toString()
          : 'Upload failed (${res.statusCode})';
      throw ApiError(res.statusCode, detail);
    }
    return decoded;
  }

  /// GET raw bytes with the auth header (profile photos). No auto-refresh
  /// here — callers render a fallback on any failure.
  Future<Uint8List?> getBytes(String path) async {
    try {
      final uri = Uri.parse('$kApiBase$path');
      final res = await http
          .get(uri, headers: await _headers(auth: true))
          .timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) return res.bodyBytes;
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Single-flight refresh: concurrent 401s share one round-trip.
  Future<bool> _refreshSingleFlight() {
    final existing = _refreshing;
    if (existing != null) return existing.future;
    final c = Completer<bool>();
    _refreshing = c;
    _doRefresh().then((ok) {
      if (!c.isCompleted) c.complete(ok);
    }).catchError((_) {
      if (!c.isCompleted) c.complete(false);
    }).whenComplete(() => _refreshing = null);
    return c.future;
  }

  Future<bool> _doRefresh() async {
    final refreshToken = await _storage.read(key: _kRefreshKey);
    if (refreshToken == null) return false;
    try {
      final res = await http
          .post(
            Uri.parse('$kApiBase/auth/refresh'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({'refreshToken': refreshToken}),
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return false;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final newAccess = data['accessToken'] as String?;
      if (newAccess == null) return false;
      await saveSession(
        accessToken: newAccess,
        refreshToken: (data['refreshToken'] as String?) ?? refreshToken,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── Auth ──

  Future<Map<String, dynamic>> login(String email, String password) async {
    final data = await post('/auth/login', body: {'email': email, 'password': password}, auth: false);
    final map = data as Map<String, dynamic>;
    await saveSession(
      accessToken: map['accessToken'] as String,
      refreshToken: map['refreshToken'] as String?,
    );
    return map;
  }

  Future<void> logout() async {
    try {
      await post('/auth/logout', body: {});
    } catch (_) {/* token may already be dead */}
    await clearSession();
  }

  Future<Map<String, dynamic>?> me() async {
    try {
      final data = await get('/auth/me');
      return data as Map<String, dynamic>;
    } on ApiError catch (e) {
      if (e.status == 401) rethrow;
      return null;
    }
  }

  // ── Generic helpers used by screens ──

  Future<List<dynamic>> list(String path) async {
    final data = await get(path);
    if (data is Map && data['data'] is List) return data['data'] as List<dynamic>;
    if (data is List) return data;
    return const [];
  }

  Future<Map<String, dynamic>> object(String path) async {
    final data = await get(path);
    return (data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{});
  }
}
