// ──────────────────────────────────────────────
// Profile-photo helpers — URL resolution + an authenticated bytes provider.
//
// The DB stores gateway-relative URLs (/photos/file/photo_...png); the app
// turns them into absolute http://<host>:4000/api/v1/photos/file/... URLs.
// Bytes flow through ApiClient.getBytes so the Authorization header rides
// along — Flutter's Image.network can't attach headers per request, so all
// photo rendering goes through AuthPhotoProvider.
// ──────────────────────────────────────────────

import 'dart:async';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

import 'api.dart';
import 'host.dart';

/// Absolute, authenticated-fetchable URL for a stored photo URL.
/// Null-safe: a null/empty/absolute input passes through sensibly.
String? resolvePhotoUrl(String? stored) {
  if (stored == null || stored.isEmpty) return null;
  if (stored.startsWith('http')) return stored;
  return 'http://${HostConfig.instance.host}:4000/api/v1$stored';
}

/// ImageProvider that fetches through the API client (auth header included)
/// and caches per URL for the process lifetime.
class AuthPhotoProvider extends ImageProvider<AuthPhotoProvider> {
  const AuthPhotoProvider(this.storedUrl);

  final String storedUrl;

  @override
  Future<AuthPhotoProvider> obtainKey(ImageConfiguration configuration) =>
      SynchronousFuture<AuthPhotoProvider>(this);

  @override
  ImageStreamCompleter loadImage(AuthPhotoProvider key, ImageDecoderCallback decode) {
    return MultiFrameImageStreamCompleter(
      codec: _load(key),
      scale: 1.0,
    );
  }

  static final Map<String, Future<Codec>> _cache = {};

  /// Drop all cached photo bytes — called after an upload so the avatar
  /// re-fetches instead of showing stale bytes.
  static void clearCache() => _cache.clear();

  Future<Codec> _load(AuthPhotoProvider key) {
    final absolute = resolvePhotoUrl(key.storedUrl);
    if (absolute == null) return Future.error(StateError('no photo url'));
    return _cache.putIfAbsent(absolute, () async {
      // The gateway path starts at /api/v1 — everything before it is origin.
      final idx = absolute.indexOf('/api/v1');
      if (idx < 0) throw StateError('not a gateway photo url');
      final bytes = await ApiClient.instance.getBytes(absolute.substring(idx));
      if (bytes == null || bytes.isEmpty) throw StateError('photo unavailable');
      final buffer = await ImmutableBuffer.fromUint8List(bytes);
      final descriptor = await ImageDescriptor.encoded(buffer);
      return descriptor.instantiateCodec();
    });
  }

  @override
  bool operator ==(Object other) =>
      other is AuthPhotoProvider && other.storedUrl == storedUrl;

  @override
  int get hashCode => storedUrl.hashCode;
}
