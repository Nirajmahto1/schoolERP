// ──────────────────────────────────────────────
// Chat WebSocket hub — live delivery for class-room chat (Phase 9)
//
// Sending stays on POST /chat/messages (validation, rate-limit, persistence
// in one audited place). This hub is DELIVERY ONLY: it pushes new messages to
// the sockets subscribed to a (branchId, classId, sectionId) room.
//
// Authorization model, in order of strength:
//   1. Connect requires a ticket — HMAC-signed, 60s TTL, single-purpose,
//      minted only by the assertion-verified /chat/ticket route. Browsers
//      cannot set headers on a WebSocket, so the ticket rides ?t=.
//   2. The ticket embeds the room resolved server-side at mint time (own
//      enrollment for students, the child's room read-only for guardians,
//      staff get a wildcard scoped to their branch). A client can never
//      subscribe itself to a room it does not belong to — the only input the
//      client controls is the ticket itself.
//   3. The DB is still the authority: tickets are short-lived and every
//      message a socket receives was persisted by the POST route first.
//
// Fan-out: every post is published to Redis `chat:<branchId>` with the full
// room triple in the envelope. Each service instance subscribes once per
// branch it has sockets for (and re-checks the room triple per socket at
// delivery), so N replicas deliver to every connected client without
// cross-tenant leakage — the same per-tenant isolation shape as the
// notification-engine. Without REDIS_URL the hub degrades to in-process
// delivery, which is correct for single-node dev.
// ──────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'crypto';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';

/** A chat room is the enrollment triple — no room rows, no joins. */
export interface ChatRoom {
  branchId: string;
  classId: string;
  sectionId: string;
}

export interface ChatTicketClaims extends ChatRoom {
  /** sub — the authenticated user id. */
  sub: string;
  /** canPost is enforced by the POST route; on the socket it only labels. */
  canPost: boolean;
  /** exp — epoch seconds. */
  exp: number;
}

const TICKET_TTL_SECONDS = 60;

/** HMAC-SHA256 over `base`, hex-encoded. */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Mint a connect ticket. Called by the /chat/ticket route only. */
export function mintChatTicket(claims: Omit<ChatTicketClaims, 'exp'>, secret: string): string {
  const payload = JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS });
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** Verify a connect ticket: signature first (timing-safe), then expiry. */
export function verifyChatTicket(token: string, secret: string): ChatTicketClaims | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ChatTicketClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    if (!claims.sub || !claims.branchId || !claims.classId || !claims.sectionId) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The Redis pub/sub envelope — room triple rides along for per-socket checks. */
export interface ChatFanoutMessage {
  room: ChatRoom;
  message: {
    id: string;
    authorId: string;
    authorName: string;
    body: string;
    createdAt: string;
  };
}

/** Minimal subset of ioredis we rely on (keeps the hub testable without Redis). */
interface RedisLike {
  publish(channel: string, payload: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', handler: (channel: string, payload: string) => void): unknown;
  quit(): Promise<unknown>;
}

export interface ChatHubOptions {
  ticketSecret: string;
  /** Optional Redis for multi-instance fan-out. */
  redisFactory?: (url: string) => { publisher: RedisLike; subscriber: RedisLike };
}

const sameRoom = (a: ChatRoom, b: ChatRoom): boolean =>
  a.branchId === b.branchId && a.classId === b.classId && a.sectionId === b.sectionId;

export class ChatHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  /** branchId → sockets whose ticket room is inside that branch. */
  private readonly byBranch = new Map<string, Set<{ ws: WebSocket; room: ChatRoom; userId: string }>>();
  private publisher: RedisLike | null = null;
  private subscriber: RedisLike | null = null;
  private readonly subscribedBranches = new Set<string>();
  private readonly ticketSecret: string;
  private readonly redisFactory: ((url: string) => { publisher: RedisLike; subscriber: RedisLike }) | null;

  constructor(options: ChatHubOptions) {
    this.ticketSecret = options.ticketSecret;
    this.redisFactory = options.redisFactory ?? null;
  }

  /**
   * Attach to the HTTP listener (upgrade dispatch) and — when configured —
   * open the Redis fan-out. Called once at entrypoint startup.
   */
  attach(server: HttpServer, redisUrl?: string): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Route dispatch is the gateway's job in production; here we accept
      // every upgrade aimed at the chat path (with or without the gateway's
      // /api/v1/communication prefix — WS proxying may not rewrite paths)
      // and reject the rest so a stray upgrade never hangs the socket.
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!url.pathname.endsWith('/chat/ws')) {
        socket.destroy();
        return;
      }
      this.handleUpgrade(req, socket, head);
    });

    if (redisUrl && this.redisFactory) {
      try {
        const { publisher, subscriber } = this.redisFactory(redisUrl);
        subscriber.on('message', (_channel: string, payload: string) => {
          try {
            this.deliverLocally(JSON.parse(payload) as ChatFanoutMessage);
          } catch { /* malformed envelope — drop, never crash */ }
        });
        this.publisher = publisher;
        this.subscriber = subscriber;
      } catch (err) {
        // Redis down must not take the service down: degrade to local-only.
        console.error('[chat-hub] redis unavailable — in-process delivery only:', (err as Error).message);
        this.publisher = null;
        this.subscriber = null;
      }
    }
  }

  /** Upgrade handler — also called directly by the dedicated-port listener. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ticket = url.searchParams.get('t') ?? '';
    const claims = verifyChatTicket(ticket, this.ticketSecret);
    if (!claims) {
      // Standard WS refusal: complete the handshake with 401 then close.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.register(ws, claims);
    });
  }

  private register(ws: WebSocket, claims: ChatTicketClaims): void {
    const room: ChatRoom = { branchId: claims.branchId, classId: claims.classId, sectionId: claims.sectionId };
    const entry = { ws, room, userId: claims.sub };
    let set = this.byBranch.get(room.branchId);
    if (!set) {
      set = new Set();
      this.byBranch.set(room.branchId, set);
    }
    set.add(entry);

    // Staff rooms arrive via ticket too — a staff ticket carries the branch
    // but is minted per (classId, sectionId) pair the moderator picked.
    void this.ensureBranchSubscription(room.branchId);

    ws.on('close', () => {
      set?.delete(entry);
      if (set && set.size === 0) this.byBranch.delete(room.branchId);
    });
    ws.on('error', () => ws.terminate());

    // Hello payload: confirms the room the socket is bound to.
    ws.send(JSON.stringify({ type: 'hello', room, canPost: claims.canPost }));
  }

  /** Subscribe this instance to a branch channel exactly once. */
  private async ensureBranchSubscription(branchId: string): Promise<void> {
    if (!this.subscriber || this.subscribedBranches.has(branchId)) return;
    this.subscribedBranches.add(branchId);
    try {
      await this.subscriber.subscribe(`chat:${branchId}`);
    } catch (err) {
      this.subscribedBranches.delete(branchId);
      console.error('[chat-hub] subscribe failed:', (err as Error).message);
    }
  }

  /** Distribute a fanned-out message to matching local sockets. */
  private deliverLocally(msg: ChatFanoutMessage): void {
    const set = this.byBranch.get(msg.room.branchId);
    if (!set) return;
    const frame = JSON.stringify({ type: 'message', ...msg.message });
    for (const entry of set) {
      if (sameRoom(entry.room, msg.room) && entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(frame);
      }
    }
  }

  /**
   * Fan a freshly persisted message out: Redis when available (all replicas
   * deliver), plus a local pass so the posting instance delivers immediately
   * even if Redis is down.
   */
  async publish(msg: ChatFanoutMessage): Promise<void> {
    this.deliverLocally(msg);
    if (!this.publisher) return;
    try {
      await this.publisher.publish(`chat:${msg.room.branchId}`, JSON.stringify(msg));
    } catch (err) {
      // Local delivery already happened; log and move on.
      console.error('[chat-hub] publish failed:', (err as Error).message);
    }
  }

  async close(): Promise<void> {
    for (const set of this.byBranch.values()) {
      for (const entry of set) entry.ws.terminate();
    }
    this.byBranch.clear();
    this.wss.close();
    await this.publisher?.quit().catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
  }
}

/** Default ioredis factory (injected in tests). */
export const defaultRedisFactory = (url: string): { publisher: RedisLike; subscriber: RedisLike } => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require('ioredis');
  return { publisher: new Redis(url), subscriber: new Redis(url) };
};
