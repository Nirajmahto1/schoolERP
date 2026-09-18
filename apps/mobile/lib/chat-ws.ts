// ──────────────────────────────────────────────
// Chat live delivery (Phase 9) — WebSocket with polling fallback.
//
// Contract (mirrors communication-service):
//   GET /communication/chat/ticket → { ticket, wsPath, directPort?, expiresIn }
//   WS  {directPort || gateway}/wsPath?t=<ticket>
//   server → client frames: { type:'hello', room, canPost } | { type:'message', id, authorId, authorName, body, createdAt }
//
// The ticket embeds the room resolved server-side — the client never names
// its own room. A dropped socket falls back to the 5s poll and reconnects
// with a fresh ticket after a backoff, so a hub restart costs nothing.
// ──────────────────────────────────────────────

import AsyncStorage from "@react-native-async-storage/async-storage";

const API_BASE = "http://10.0.2.2:4000/api/v1";
const GATEWAY_WS = "ws://10.0.2.2:4000";
const DIRECT_WS_PORT = 4015; // CHAT_HUB_PORT — direct hub listener, bypasses the gateway

export interface ChatLiveMessage {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface ChatLiveHandlers {
  onMessage: (msg: ChatLiveMessage) => void;
  /** Connection state changes; `live` means pushes are flowing. */
  onLive?: (live: boolean) => void;
}

interface TicketResponse {
  ticket: string;
  wsPath: string;
  directPort: number | null;
  expiresIn: number;
}

async function fetchTicket(): Promise<TicketResponse> {
  const token = await AsyncStorage.getItem("erp_token");
  const res = await fetch(`${API_BASE}/communication/chat/ticket`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `ticket failed (${res.status})`);
  }
  return res.json();
}

/**
 * Opens the live socket. Returns a disposer.
 * - 503 from /ticket (not configured) → stays in polling mode silently.
 * - Unexpected close → exponential backoff reconnect (2s → 30s cap).
 */
export async function connectChatLive(handlers: ChatLiveHandlers): Promise<() => void> {
  let ws: WebSocket | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const open = async () => {
    if (disposed) return;
    try {
      const t = await fetchTicket();
      // Prefer the direct hub listener when offered (mobile → service, no
      // gateway hop); fall back to the gateway path. Emulators reach both
      // host ports via 10.0.2.2.
      const base = t.directPort
        ? `ws://10.0.2.2:${t.directPort}`
        : GATEWAY_WS;
      const path = t.directPort ? "/chat/ws" : t.wsPath;
      ws = new WebSocket(`${base}${path}?t=${encodeURIComponent(t.ticket)}`);

      ws.onopen = () => {
        attempt = 0;
        handlers.onLive?.(true);
      };
      ws.onmessage = (ev: WebSocketMessageEvent) => {
        try {
          const frame = JSON.parse(String(ev.data));
          if (frame?.type === "message" && frame.id) {
            handlers.onMessage({
              id: frame.id,
              authorId: frame.authorId,
              authorName: frame.authorName,
              body: frame.body,
              createdAt: frame.createdAt,
            });
          }
        } catch {
          /* malformed frame — ignore */
        }
      };
      ws.onclose = () => {
        handlers.onLive?.(false);
        if (disposed) return;
        // Backoff reconnect with a FRESH ticket each attempt (the old one
        // is single-purpose and expires in 60s anyway).
        attempt += 1;
        const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
        reconnectTimer = setTimeout(open, delay);
      };
      ws.onerror = () => {
        try { ws?.close(); } catch { /* already closing */ }
      };
    } catch {
      // Ticket unavailable (not configured / offline): silent polling mode.
      handlers.onLive?.(false);
    }
  };

  void open();

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch { /* no-op */ }
  };
}
