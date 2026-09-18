// ──────────────────────────────────────────────
// Live WebSocket notifications (notification-engine, Phase 6.1 surface).
//
// The engine connects the app to per-user WebSocket pushes — leave decisions,
// announcements, anything a service sends to `channel: user`. Auth is the
// engine's re-issued assertion ticket: the app calls /notifications/ws-ticket
// (normal Bearer HTTP through the gateway), then opens
//   ws://<gateway>/api/v1/notifications/ws?assertion=<ticket>
// with the ticket in the query string, because browsers/sockets cannot set
// custom headers on an upgrade.
//
// Delivery here is EPHEMERAL — only a currently-open app receives frames.
// Durable delivery (app closed) rides FCM push separately; the two channels
// complement, never replace, each other.
// ──────────────────────────────────────────────

import AsyncStorage from "@react-native-async-storage/async-storage";

const API_BASE = "http://10.0.2.2:4000/api/v1";
const GATEWAY_WS = "ws://10.0.2.2:4000";
const DIRECT_ENGINE_PORT = 6001; // PORT_NOTIFICATION_ENGINE — bypasses the gateway

/** One frame from the engine (subset of the Envelope the app cares about). */
export interface LiveNotification {
  title: string;
  body: string;
  kind?: string;
  deepLink?: string;
  ts: number;
}

export interface NotifyLiveHandlers {
  onNotification: (n: LiveNotification) => void;
  onLive?: (live: boolean) => void;
}

async function fetchTicket(): Promise<string> {
  const token = await AsyncStorage.getItem("erp_token");
  if (!token) throw new Error("not logged in");
  const res = await fetch(`${API_BASE}/notifications/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ws-ticket failed (${res.status})`);
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

/**
 * Opens the engine socket. Returns a disposer.
 * - Tries the gateway path first (one public entrypoint), falls back to the
 *   engine's direct port (containers/mobile builds that bypass the gateway).
 * - Unexpected close → reconnect with a FRESH ticket after backoff (the
 *   ticket is a ≤60s assertion; reusing it after a drop would 401).
 */
export async function connectNotifyLive(handlers: NotifyLiveHandlers): Promise<() => void> {
  let ws: WebSocket | null = null;
  let disposed = false;
  let backoff = 2000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = async () => {
    if (disposed) return;
    try {
      const ticket = await fetchTicket();
      if (disposed) return;
      tryGateway(ticket);
    } catch {
      // No token / endpoint down — retry later, stay quiet.
      scheduleRetry();
    }
  };

  const tryGateway = (ticket: string) => {
    if (disposed) return;
    ws = new WebSocket(`${GATEWAY_WS}/api/v1/notifications/ws?assertion=${encodeURIComponent(ticket)}`);
    wire(ws, () => tryDirect(ticket));
  };

  const tryDirect = (ticket: string) => {
    if (disposed) return;
    ws = new WebSocket(`ws://10.0.2.2:${DIRECT_ENGINE_PORT}/notifications/ws?assertion=${encodeURIComponent(ticket)}`);
    wire(ws, () => scheduleRetry());
  };

  const wire = (socket: WebSocket, next: () => void) => {
    socket.onopen = () => {
      backoff = 2000; // a successful connect resets the backoff
      handlers.onLive?.(true);
    };
    socket.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data));
        if (frame?.type === "notification" && frame.title) {
          handlers.onNotification({
            title: String(frame.title),
            body: String(frame.body ?? ""),
            kind: frame.kind,
            deepLink: frame.deepLink,
            ts: Number(frame.ts ?? Date.now()),
          });
        }
        // presence/subscribed/pong frames are protocol noise — ignored.
      } catch {
        /* malformed frame — drop */
      }
    };
    socket.onerror = () => {
      // Distinguish gateway failure from auth failure cheaply: fall to direct
      // only if the socket never opened; otherwise treat as a normal drop.
    };
    socket.onclose = () => {
      handlers.onLive?.(false);
      ws = null;
      if (!disposed) next();
    };
  };

  const scheduleRetry = () => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      backoff = Math.min(backoff * 1.7, 30000);
      open();
    }, backoff);
  };

  open();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  };
}
