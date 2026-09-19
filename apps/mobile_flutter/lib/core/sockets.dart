// ──────────────────────────────────────────────
// WebSocket services — Dart ports of notify-ws.ts and chat-ws.ts.
//
// Live notification frames (channel: user) and class-chat delivery ride
// websockets; REST remains the source of truth (send/reconcile), the
// socket only accelerates delivery to an open app.
// ──────────────────────────────────────────────

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';
import 'host.dart';
import 'models.dart';

/// Live notification frame from the notification engine.
class LiveNotification {
  final String title;
  final String body;
  final String kind;
  final String? deepLink;

  LiveNotification({required this.title, required this.body, required this.kind, this.deepLink});

  factory LiveNotification.fromJson(Map<String, dynamic> j) => LiveNotification(
        title: j['title']?.toString() ?? 'Notification',
        body: j['body']?.toString() ?? '',
        kind: j['kind']?.toString() ?? 'GENERIC',
        deepLink: j['deepLink']?.toString(),
      );
}

class NotifySocket {
  NotifySocket._();
  static final NotifySocket instance = NotifySocket._();

  WebSocketChannel? _ws;
  Timer? _reconnect;
  int _attempt = 0;
  bool _disposed = false;

  final _notifications = StreamController<LiveNotification>.broadcast();
  Stream<LiveNotification> get notifications => _notifications.stream;

  Future<void> connect() async {
    await disconnect();
    _disposed = false;
    try {
      // The engine's ws-ticket is POST-only (browsers can't set headers on a
      // WebSocket; native clients could, but the ticket flow is uniform).
      final ticket = await ApiClient.instance.post('/notifications/ws-ticket', body: {});
      final t = (ticket as Map<String, dynamic>)['ticket']?.toString() ?? '';
      if (t.isEmpty) return;
      final uri = Uri.parse('ws://$kApiHost:$kNotificationEnginePort/notifications/ws?assertion=$t');
      _ws = WebSocketChannel.connect(uri);
      _ws!.stream.listen(
        (data) {
          try {
            final frame = jsonDecode(data.toString());
            if (frame is Map && frame['type'] == 'notification') {
              _notifications.add(LiveNotification.fromJson(Map<String, dynamic>.from(frame)));
            }
          } catch (_) {/* non-JSON control frame */}
        },
        onDone: () => _scheduleReconnect(),
        onError: (_) => _scheduleReconnect(),
      );
      _attempt = 0;
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnect?.cancel();
    final delay = Duration(seconds: (1 << (_attempt.clamp(0, 4)))); // 1..16s backoff
    _attempt += 1;
    _reconnect = Timer(delay, connect);
  }

  Future<void> disconnect() async {
    _disposed = true;
    _reconnect?.cancel();
    await _ws?.sink.close();
    _ws = null;
  }
}

/// Chat ticket + live class-chat delivery. Sending stays on
/// POST /chat/messages; this socket is delivery-only.
class ChatSocket {
  ChatSocket._();
  static final ChatSocket instance = ChatSocket._();

  WebSocketChannel? _ws;
  Timer? _poll;
  final _messages = StreamController<ChatMessage>.broadcast();
  final _live = StreamController<bool>.broadcast();

  Stream<ChatMessage> get messages => _messages.stream;
  Stream<bool> get live => _live.stream;

  Future<void> connectAndListen() async {
    try {
      final ticket = await ApiClient.instance.get('/communication/chat/ticket');
      final t = Map<String, dynamic>.from(ticket as Map);
      final base = t['directPort'] != null
          ? 'ws://$kApiHost:${t['directPort']}'
          : kGatewayWs;
      final path = t['directPort'] != null ? '/chat/ws' : (t['wsPath']?.toString() ?? '/api/v1/communication/chat/ws');
      final uri = Uri.parse('$base$path?t=${Uri.encodeComponent(t['ticket']?.toString() ?? '')}');
      _ws = WebSocketChannel.connect(uri);
      _ws!.stream.listen(
        (data) {
          try {
            final frame = jsonDecode(data.toString());
            if (frame is Map && frame['type'] == 'message') {
              _messages.add(ChatMessage.fromJson(Map<String, dynamic>.from(frame['message'] ?? frame)));
            }
          } catch (_) {}
        },
        onDone: () => _live.add(false),
        onError: (_) => _live.add(false),
      );
      _live.add(true);
    } catch (_) {
      _live.add(false);
      _startPollFallback();
    }
  }

  /// Reconciliation net: if the socket dies, poll keeps the room honest.
  void _startPollFallback() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 5), (_) async {
      try {
        final rows = await ApiClient.instance.list('/communication/chat/messages?limit=20');
        for (final r in rows) {
          _messages.add(ChatMessage.fromJson(Map<String, dynamic>.from(r)));
        }
      } catch (_) {}
    });
  }

  Future<void> disconnect() async {
    _poll?.cancel();
    await _ws?.sink.close();
    _ws = null;
  }
}
