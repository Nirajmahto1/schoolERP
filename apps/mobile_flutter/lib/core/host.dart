// ──────────────────────────────────────────────
// LAN host resolution — the Dart twin of apps/mobile/lib/host.ts.
//
// A real phone reaches the dev PC's API through the PC's LAN IP; the Android
// emulator uses 10.0.2.2 (the loopback alias). Dev machines change networks
// (hotspot adapter, office ethernet, college Wi-Fi), so the host is RESOLVED
// at startup by probing /health on each known candidate — not baked in.
//
// Priority:
//   1. --dart-define=API_HOST=<ip> (explicit override, e.g. production)
//   2. last host that worked (persisted in secure storage)
//   3. known dev candidates, first /health response wins
// ──────────────────────────────────────────────

import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const String kEmulatorHost = '10.0.2.2';

/// Known dev locations of the school-erp stack on this project's machines.
const List<String> _kCandidates = [
  '192.168.137.1', // Windows mobile-hotspot adapter
  '172.16.5.176', // Ethernet 2 (office LAN)
  '10.86.15.3', // Ethernet 5
  '10.0.2.2', // Android emulator → host loopback
];

const String _kStorageKey = 'api.host';
const String? _kDefineHost = String.fromEnvironment('API_HOST') == ''
    ? null
    : String.fromEnvironment('API_HOST');

class HostConfig {
  HostConfig._();
  static final HostConfig instance = HostConfig._();

  String? _resolved;
  final _storage = const FlutterSecureStorage();

  /// The resolved host (valid after [ensureResolved]).
  String get host => _resolved ?? _kDefineHost ?? _kCandidates.first;

  bool get isEmulatorTarget => host == kEmulatorHost;

  /// Probe candidates once at startup; the first /health responder wins.
  Future<void> ensureResolved() async {
    if (_resolved != null) return;

    // 1. Explicit build-time override always wins (production builds).
    if (_kDefineHost != null) {
      _resolved = _kDefineHost;
      return;
    }

    // 2. Last host that worked — probe it first, quickly.
    final remembered = await _storage.read(key: _kStorageKey);
    if (remembered != null && await _healthy(remembered)) {
      _resolved = remembered;
      return;
    }

    // 3. Full scan.
    for (final c in _kDefineHost == null && remembered != null
        ? [remembered, ..._kCandidates]
        : _kCandidates) {
      if (await _healthy(c)) {
        _resolved = c;
        await _storage.write(key: _kStorageKey, value: c);
        return;
      }
    }

    // Nothing answered — keep the explicit/default candidate; API calls will
    // surface the connection error in the UI, which is the honest outcome.
    _resolved ??= _kDefineHost ?? _kCandidates.first;
  }

  Future<bool> _healthy(String host) async {
    try {
      final client = HttpClient()..connectionTimeout = const Duration(milliseconds: 1200);
      final req =
          await client.getUrl(Uri.parse('http://$host:4000/health')).timeout(const Duration(milliseconds: 1500));
      final res = await req.close().timeout(const Duration(milliseconds: 1500));
      await res.drain<void>();
      client.close(force: true);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Runtime override from the login screen: probe, persist, and switch.
  /// Accepts a bare IP/host or a full URL. Returns null on success, else an
  /// error message for the UI.
  Future<String?> setOverride(String rawHost) async {
    final h = rawHost.trim();
    if (h.isEmpty) return 'Enter a host or IP';
    final host = h.contains('://') ? Uri.tryParse(h)?.host ?? '' : h;
    if (host.isEmpty) return 'Not a valid host or IP';
    if (!await _healthy(host)) return 'No server responded at http://$host:4000';
    _resolved = host;
    await _storage.write(key: _kStorageKey, value: host);
    return null;
  }
}

/// Host the API/gateway is reachable on (resolved at startup).
String get kApiHost => HostConfig.instance.host;

bool get kIsEmulatorTarget => HostConfig.instance.isEmulatorTarget;

/// Base URL for every REST call (gateway).
String get kApiBase => 'http://$kApiHost:4000/api/v1';

/// Gateway WebSocket base (chat + live notifications).
String get kGatewayWs => 'ws://$kApiHost:4000';

/// Notification engine (direct, bypasses the gateway).
const int kNotificationEnginePort = 6001;

/// Chat hub direct listener (bypasses the gateway).
const int kChatHubPort = 4015;
