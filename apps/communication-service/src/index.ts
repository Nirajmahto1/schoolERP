// ──────────────────────────────────────────────
// School ERP — Communication Service
// ──────────────────────────────────────────────

import express, { Router } from 'express';
import { createServer } from 'http';
import { Prisma, PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { loadServiceEnv } from '@school-erp/config';
import { createServiceApp, listenWithGracefulShutdown, ctx, decryptField } from '@school-erp/auth';
import { buildOpenApiDocument } from '@school-erp/http';
import { WhatsAppClient, parseDeliveryStatuses } from './whatsapp';
import { SmsClient } from './sms';
import { FcmClient } from './fcm';
import { EmailClient } from './email';
import { Dispatcher } from './dispatcher';
import { scanAbsencesForDate } from './absence-alerts';
import { scanFeeRemindersForDate } from './fee-reminders';
import { scanExamSchedules, notifyResultsPublished } from './exam-triggers';
import { tryDecrementCredits } from './credit-gate';
import { ChatHub, mintChatTicket, defaultRedisFactory } from './chat-hub';
import { notifyStaffUsers } from '@school-erp/notify';

/** MUST equal the gateway route-table audience for this service. */
const SERVICE_NAME = 'communication-service';

// ── Class-room chat live delivery (Phase 9) ──
// The hub + ticket secret are assigned by the app factory so the chat routes
// can mint tickets and publish. A deployment without a ticket secret simply
// never assigns them: /chat/ticket answers 503 and clients fall back to
// polling — the service still boots. Module scope so the entrypoint can
// reach the hub via getChatHub() to attach listeners.
let activeChatHub: ChatHub | null = null;
let chatTicketSecret: string | undefined;
/** Module-scope peer WS-notify config, assigned by the factory (route files read it). */
let engineNotifyConfig: { internalAssertionPrivateKey?: string; notificationEngineUrl?: string } = {};
/** Entrypoints call this after createCommunicationApp to attach the hub to their listener(s). */
export function getChatHub(): ChatHub | null {
  return activeChatHub;
}

/**
 * Messaging providers from process env. Every key is optional — the service
 * runs unconfigured (the dispatcher fails sends closed with clear errors)
 * exactly like fee-service boots without Razorpay keys.
 */
function messagingFromEnv() {
  const e = loadServiceEnv(SERVICE_NAME, 'PORT_COMMUNICATION_SERVICE');
  // Email: exactly one provider, or none. Both set is a refused
  // misconfiguration (double-send risk), not a fallback.
  const hasSes = !!(e.AWS_SES_REGION && e.AWS_SES_ACCESS_KEY_ID && e.AWS_SES_SECRET_ACCESS_KEY && e.EMAIL_FROM_ADDRESS);
  const hasPostmark = !!(e.POSTMARK_SERVER_TOKEN && e.EMAIL_FROM_ADDRESS);
  EmailClient.validate({
    region: e.AWS_SES_REGION,
    accessKeyId: e.AWS_SES_ACCESS_KEY_ID,
    secretAccessKey: e.AWS_SES_SECRET_ACCESS_KEY,
    serverToken: e.POSTMARK_SERVER_TOKEN,
  });
  const email = hasSes
    ? new EmailClient({
        provider: 'ses',
        fromAddress: e.EMAIL_FROM_ADDRESS!,
        fromName: e.EMAIL_FROM_NAME,
        region: e.AWS_SES_REGION,
        accessKeyId: e.AWS_SES_ACCESS_KEY_ID,
        secretAccessKey: e.AWS_SES_SECRET_ACCESS_KEY,
      })
    : hasPostmark
      ? new EmailClient({
          provider: 'postmark',
          fromAddress: e.EMAIL_FROM_ADDRESS!,
          fromName: e.EMAIL_FROM_NAME,
          serverToken: e.POSTMARK_SERVER_TOKEN,
        })
      : null;
  return {
    whatsapp:
      e.WHATSAPP_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID
        ? new WhatsAppClient({ token: e.WHATSAPP_TOKEN, phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID })
        : null,
    sms:
      e.SMS_API_BASE && e.SMS_API_KEY && e.SMS_SENDER_HEADER
        ? new SmsClient({ apiBase: e.SMS_API_BASE, apiKey: e.SMS_API_KEY, senderHeader: e.SMS_SENDER_HEADER })
        : null,
    fcm:
      e.FCM_PROJECT_ID && e.FCM_CLIENT_EMAIL && e.FCM_PRIVATE_KEY
        ? new FcmClient({ projectId: e.FCM_PROJECT_ID, clientEmail: e.FCM_CLIENT_EMAIL, privateKey: e.FCM_PRIVATE_KEY })
        : null,
    email,
    whatsappWebhookSecret: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    messagingWebhookSecret: e.MESSAGING_WEBHOOK_SECRET,
    quietHours: { start: e.QUIET_HOURS_START, end: e.QUIET_HOURS_END },
  };
}

export interface CommunicationAppOptions {
  env: { INTERNAL_ASSERTION_PUBLIC_KEY: string; CHAT_TICKET_SECRET?: string; REDIS_URL?: string; INTERNAL_ASSERTION_PRIVATE_KEY?: string; NOTIFICATION_ENGINE_URL?: string };
  prisma: PrismaClient;
  /** Injected messaging config (defaults from loadServiceEnv). */
  messaging?: {
    whatsapp: WhatsAppClient | null;
    sms: SmsClient | null;
    fcm?: FcmClient | null;
    email?: EmailClient | null;
    whatsappWebhookSecret?: string;
    messagingWebhookSecret?: string;
    quietHours: { start: number; end: number };
  };
  /** Test seam: override the chat hub's Redis client factory. */
  redisFactory?: (url: string) => { publisher: { publish(c: string, p: string): Promise<unknown>; subscribe(c: string): Promise<unknown>; on(e: 'message', h: (c: string, p: string) => void): unknown; quit(): Promise<unknown> }; subscriber: { publish(c: string, p: string): Promise<unknown>; subscribe(c: string): Promise<unknown>; on(e: 'message', h: (c: string, p: string) => void): unknown; quit(): Promise<unknown> } };
}

/**
 * App factory — split from the entrypoint so tests can inject a Prisma
 * client and an explicit env without booting the real process.
 */
export function createCommunicationApp(options: CommunicationAppOptions) {
  const { prisma } = options;
  const env = { INTERNAL_ASSERTION_PUBLIC_KEY: options.env.INTERNAL_ASSERTION_PUBLIC_KEY };

  // Chat hub (Phase 9): live WebSocket delivery. Created only when a ticket
  // secret is configured — tests and unconfigured deployments stay
  // polling-only, exactly like fee-service boots without Razorpay keys.
  chatTicketSecret = options.env.CHAT_TICKET_SECRET;
  // Peer WS-notification config (announcement live heads-up). Optional —
  // tests and leaf deployments leave it unset and the dispatch route skips.
  engineNotifyConfig = {
    internalAssertionPrivateKey: options.env.INTERNAL_ASSERTION_PRIVATE_KEY,
    notificationEngineUrl: options.env.NOTIFICATION_ENGINE_URL,
  };
  activeChatHub = chatTicketSecret
    ? new ChatHub({ ticketSecret: chatTicketSecret, redisFactory: options.redisFactory ?? defaultRedisFactory })
    : null;

  // Providers come from env; null means "not configured" — the service and
  // dispatcher still run, sends fail closed with clear errors (§5.1/5.2).
  const messaging = options.messaging ?? messagingFromEnv();
  // Credit gate (§5.7): active when the deployment names its control-plane
  // tenant. Omitted in tests/single-school evals → every send passes.
  const creditGate = process.env.COMMUNICATION_TENANT_ID
    ? (units: number) => tryDecrementCredits(process.env.COMMUNICATION_TENANT_ID as string, units)
    : undefined;
  const dispatcher = new Dispatcher(prisma, {
    whatsapp: messaging.whatsapp,
    sms: messaging.sms,
    fcm: messaging.fcm ?? null,
    email: messaging.email ?? null,
    creditGate,
    quietHours: messaging.quietHours,
  });

  const { app, mount, mountPublicWebhook, finalize } = createServiceApp({
    serviceName: SERVICE_NAME,
    assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
    rawBodyPaths: ['/webhooks'],
    readinessCheck: async () => { await prisma.$queryRaw`SELECT 1`; },
  });

  app.set('prisma', prisma);

  // Published contract (GATE 3).
  const openapi = buildOpenApiDocument({
    title: 'Communication Service',
    description: 'Announcements, message templates, targeted dispatch, and notification logs.',
    version: '1.0.0',
    basePath: '/communication',
    paths: {
      '/announcements': {
        get: { summary: 'Announcements visible to the caller\'s roles', tags: ['announcements'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create an announcement (role-targeted)', tags: ['announcements'], responses: { '201': { description: 'Created' } } },
      },
      '/announcements/{id}': {
        put: { summary: 'Update an announcement', tags: ['announcements'], responses: { '200': { description: 'Updated' } } },
        delete: { summary: 'Deactivate an announcement', tags: ['announcements'], responses: { '204': { description: 'Deactivated' } } },
      },
      '/templates': {
        get: { summary: 'List message templates', tags: ['templates'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Upsert a template ({{placeholders}} rendered at dispatch)', tags: ['templates'], responses: { '201': { description: 'Created' } } },
      },
      '/dispatch': {
        post: {
          summary: 'Dispatch to guardians of targeted classes/sections + role-held staff; writes NotificationLog rows', tags: ['dispatch'],
          requestBody: { type: 'object', properties: {
            title: { type: 'string' }, content: { type: 'string' }, templateKey: { type: 'string' },
            targetRoles: { type: 'array', items: { type: 'string' } },
            classIds: { type: 'array', items: { type: 'string' } }, sectionIds: { type: 'array', items: { type: 'string' } },
            channel: { type: 'string', enum: ['SMS', 'EMAIL', 'WHATSAPP', 'PUSH'] }, variables: { type: 'object' },
            // Staff-only dispatches (scheduled reports, internal notices) must
            // not fall through to the branch's guardian audience.
            staffOnly: { type: 'boolean' },
          } },
          responses: { '201': { description: 'Queued' } },
        },
      },
      '/dispatch-logs': { get: { summary: 'NotificationLog rows (delivery-dispute trail)', tags: ['dispatch'], responses: { '200': { description: 'OK' } } } },
      '/devices': {
        post: {
          summary: 'Register this account\'s push device (FCM token) — called by the mobile apps after login', tags: ['push'],
          requestBody: { type: 'object', properties: { token: { type: 'string' }, platform: { type: 'string', enum: ['ANDROID', 'IOS', 'WEB'] }, label: { type: 'string' } } },
          responses: { '201': { description: 'Registered' } },
        },
      },
      '/chat/messages': {
        get: {
          summary: 'Class-room chat: the caller\'s own room (student) or their child\'s (guardian, read-only); staff may pass classId+sectionId within their branch', tags: ['chat'],
          responses: { '200': { description: 'OK' }, '404': { description: 'No room' } },
        },
        post: {
          summary: 'Post to the class room (students only, own room, rate-limited)', tags: ['chat'],
          requestBody: { type: 'object', properties: { body: { type: 'string', maxLength: 1000 } }, required: ['body'] },
          responses: { '201': { description: 'Posted' }, '403': { description: 'Not a student / not their room' }, '429': { description: 'Rate limited' } },
        },
      },
      '/chat/ticket': {
        get: {
          summary: 'Mint a 60s connect ticket for the chat WebSocket (room resolved server-side; staff may pass classId+sectionId)', tags: ['chat'],
          responses: { '200': { description: 'Ticket issued' }, '404': { description: 'No room' }, '503': { description: 'Live chat not configured' } },
        },
      },
      '/devices/{id}': {
        delete: { summary: 'Remove a registered device (logout / token rotation)', tags: ['push'], responses: { '204': { description: 'Removed' } } },
      },
      '/absence-alerts/scan': {
        post: {
          summary: 'Scan a date\'s attendance for ABSENT records and queue urgent guardian alerts (idempotent per date)', tags: ['triggers'],
          requestBody: { type: 'object', properties: { date: { type: 'string' }, channel: { type: 'string', enum: ['WHATSAPP', 'SMS', 'PUSH'] }, drain: { type: 'boolean' } } },
          responses: { '200': { description: 'Scan result' } },
        },
      },
      '/fee-reminders/scan': {
        post: {
          summary: 'Scan invoices for due-soon/overdue fee reminders (idempotent per invoice + kind)', tags: ['triggers'],
          requestBody: { type: 'object', properties: { date: { type: 'string' }, channel: { type: 'string', enum: ['WHATSAPP', 'SMS', 'EMAIL', 'PUSH'] }, drain: { type: 'boolean' }, dueSoonDays: { type: 'number' } } },
          responses: { '200': { description: 'Scan result' } },
        },
      },
      '/exam-triggers/schedule-scan': {
        post: {
          summary: 'Queue examination-schedule notices for exams starting within the window (idempotent per exam)', tags: ['triggers'],
          requestBody: { type: 'object', properties: { date: { type: 'string' }, channel: { type: 'string', enum: ['WHATSAPP', 'SMS', 'EMAIL', 'PUSH'] }, daysAhead: { type: 'number' }, drain: { type: 'boolean' } } },
          responses: { '200': { description: 'Scan result' } },
        },
      },
      '/exam-triggers/results-published': {
        post: {
          summary: 'Notify guardians an examination\'s results are PUBLISHED (idempotent per exam; 409 unless PUBLISHED)', tags: ['triggers'],
          requestBody: { type: 'object', properties: { examinationId: { type: 'string' }, channel: { type: 'string', enum: ['WHATSAPP', 'SMS', 'EMAIL', 'PUSH'] }, drain: { type: 'boolean' } }, required: ['examinationId'] },
          responses: { '200': { description: 'Queued' }, '404': { description: 'Exam not in branch' }, '409': { description: 'Not PUBLISHED yet' } },
        },
      },
    },
  });
  app.get('/openapi.json', (_req, res) => { res.json(openapi); });

const r = Router();

// ── Announcements ──
r.get('/announcements', async (req, res) => {
  try {
    const { branchId, roles } = ctx(req);
    if (!branchId) {
      res.status(403).json({ detail: 'Account has no branch — cannot list announcements.' });
      return;
    }
    const announcements = await prisma.announcement.findMany({
      // hasSome, not has: a user can hold several roles, and an announcement
      // targeted at any one of them should be visible.
      where: {
        branchId,
        isActive: true,
        OR: [{ targetRoles: { hasSome: roles as any } }, { targetRoles: { isEmpty: true } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: announcements });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/announcements', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const { userId: createdBy } = ctx(req);
    if (!branchId || !createdBy) {
      res.status(403).json({ detail: 'Account has no branch or user id — cannot create announcements.' });
      return;
    }
    const { title, content, type, targetRoles, expiresAt } = req.body;
    const roles: string[] = Array.isArray(targetRoles) ? targetRoles : [];
    const announcement = await prisma.announcement.create({
      data: {
        title,
        content,
        type: type || 'GENERAL',
        targetRoles: roles as any[],
        branchId,
        createdBy,
        ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
      },
    });
    res.status(201).json(announcement);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.put('/announcements/:id', async (req, res) => {
  try {
    const announcement = await prisma.announcement.update({ where: { id: req.params.id }, data: req.body });
    res.json(announcement);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.delete('/announcements/:id', async (req, res) => {
  try {
    await prisma.announcement.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.status(204).send();
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Class-room chat (Phase 9) ──
//
// The room IS the (branchId, classId, sectionId) triple — no room rows, no
// joins to maintain. Membership is derived from the LIVE enrollment at every
// request: a student who transfers sections leaves the old room and joins
// the new one with zero bookkeeping. Guardians read their child's room
// read-only (children's peer chat is not an adult posting surface); students
// read and post; staff read any room in their branch for moderation.
// Post is student-only, rate-limited per user, append-only.

const CHAT_POST_INTERVAL_MS = 1500;
const lastChatPostAt = new Map<string, number>();

/** Resolve the caller's chat room: their own enrollment, or their child's.
 *  Returns null when the caller has neither — they simply have no room. */
async function chatRoomFor(userId: string) {
  const self = await prisma.student.findFirst({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { branchId: true, enrollments: { orderBy: { fromDate: 'desc' }, take: 1, select: { classId: true, sectionId: true } } },
  });
  if (self && self.enrollments[0]) {
    return { branchId: self.branchId, classId: self.enrollments[0].classId, sectionId: self.enrollments[0].sectionId, canPost: true };
  }
  const child = await prisma.studentGuardian.findFirst({
    where: { guardian: { userId } },
    orderBy: { createdAt: 'desc' },
    select: { student: { select: { branchId: true, deletedAt: true, enrollments: { orderBy: { fromDate: 'desc' }, take: 1, select: { classId: true, sectionId: true } } } } },
  });
  const s = child?.student;
  if (s && !s.deletedAt && s.enrollments[0]) {
    return { branchId: s.branchId, classId: s.enrollments[0].classId, sectionId: s.enrollments[0].sectionId, canPost: false };
  }
  return null;
}

r.get('/chat/messages', async (req, res) => {
  try {
    const { userId, roles, branchId: staffBranch } = ctx(req);
    if (!userId) { res.status(401).json({ detail: 'Unauthorized' }); return; }

    const isStaff = roles.some((x) => ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD'].includes(x));
    let room: { branchId: string; classId: string; sectionId: string; canPost: boolean } | null = null;

    if (isStaff && staffBranch) {
      // Staff moderation view: any room inside their branch.
      const classId = String(req.query.classId ?? '');
      const sectionId = String(req.query.sectionId ?? '');
      if (classId && sectionId) room = { branchId: staffBranch, classId, sectionId, canPost: false };
    }
    if (!room) room = await chatRoomFor(userId);
    if (!room) { res.status(404).json({ type: 'not-found', title: 'No Room', status: 404, detail: 'You are not enrolled in any class section, and no child is linked to your account.' }); return; }

    // Cursor pagination: `before` = an ISO instant; return messages strictly
    // older. The mobile client polls with its newest seen timestamp.
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const messages = await prisma.chatMessage.findMany({
      where: {
        branchId: room.branchId, classId: room.classId, sectionId: room.sectionId,
        hiddenAt: null,
        ...(before && !isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({
      data: messages.reverse().map((m) => ({
        id: m.id, authorId: m.authorId, authorName: m.authorName, body: m.body,
        createdAt: m.createdAt, mine: m.authorId === userId,
      })),
      canPost: room.canPost,
    });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/chat/messages', async (req, res) => {
  try {
    const { userId, branchId } = ctx(req);
    if (!userId || !branchId) { res.status(403).json({ detail: 'Account has no user or branch — cannot post.' }); return; }
    const room = await chatRoomFor(userId);
    if (!room || !room.canPost || room.branchId !== branchId) {
      res.status(403).json({ type: 'forbidden', title: 'Forbidden', status: 403, detail: 'Only students may post in their own class room.' });
      return;
    }
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > 1000) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'body is required (max 1000 chars).' });
      return;
    }
    // Per-user rate limit: one post per 1.5s. In-memory on purpose — a
    // single-node debounce, not an abuse-proof quota.
    const now = Date.now();
    const last = lastChatPostAt.get(userId) ?? 0;
    if (now - last < CHAT_POST_INTERVAL_MS) {
      res.status(429).json({ type: 'rate-limited', title: 'Too Fast', status: 429, detail: 'Slow down — one message every couple of seconds.' });
      return;
    }
    lastChatPostAt.set(userId, now);
    const author = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const me = await prisma.student.findFirst({ where: { userId, deletedAt: null }, select: { firstName: true, lastName: true } });
    const authorName = me ? `${me.firstName} ${me.lastName}` : (author?.email ?? 'Student');
    const msg = await prisma.chatMessage.create({
      data: { branchId: room.branchId, classId: room.classId, sectionId: room.sectionId, authorId: userId, authorName, body },
    });
    // Live delivery: fan the persisted message out to every socket in the
    // room (this instance via the local pass, other replicas via Redis).
    // Delivery is best-effort — the row is already durable; a client that
    // misses the push still gets it on reconnect/poll.
    if (activeChatHub) {
      void activeChatHub.publish({
        room: { branchId: room.branchId, classId: room.classId, sectionId: room.sectionId },
        message: { id: msg.id, authorId: msg.authorId, authorName: msg.authorName, body: msg.body, createdAt: msg.createdAt.toISOString() },
      });
    }
    res.status(201).json({ id: msg.id, createdAt: msg.createdAt });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Chat WebSocket ticket ──
// Browsers cannot set headers on a WebSocket, so the connect credential is a
// short-lived ticket minted here (assertion already verified by the mount)
// and carried as ?t= on the upgrade. The room is resolved SERVER-SIDE at mint
// time — the client never names its own room.

r.get('/chat/ticket', async (req, res) => {
  try {
    const { userId, roles, branchId: staffBranch } = ctx(req);
    if (!userId) { res.status(401).json({ detail: 'Unauthorized' }); return; }
    if (!activeChatHub || !chatTicketSecret) {
      res.status(503).json({ type: 'not-configured', title: 'Live Chat Disabled', status: 503, detail: 'Live chat delivery is not configured on this deployment; the app will keep polling.' });
      return;
    }
    const isStaff = roles.some((x) => ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD'].includes(x));
    let room: { branchId: string; classId: string; sectionId: string; canPost: boolean } | null = null;
    if (isStaff && staffBranch) {
      const classId = String(req.query.classId ?? '');
      const sectionId = String(req.query.sectionId ?? '');
      if (classId && sectionId) room = { branchId: staffBranch, classId, sectionId, canPost: false };
    }
    if (!room) room = await chatRoomFor(userId);
    if (!room) { res.status(404).json({ type: 'not-found', title: 'No Room', status: 404, detail: 'You are not enrolled in any class section, and no child is linked to your account.' }); return; }
    const ticket = mintChatTicket(
      { sub: userId, branchId: room.branchId, classId: room.classId, sectionId: room.sectionId, canPost: room.canPost },
      chatTicketSecret,
    );
    res.json({ ticket, wsPath: '/api/v1/communication/chat/ws', directPort: process.env.CHAT_HUB_PORT ?? null, expiresIn: 60 });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Templates (BUILD_PLAN 3.8) ──
// Placeholders like {{studentName}} / {{feeAmount}} are filled at dispatch
// time; the template registry keeps schools from retyping the same SMS 500
// times and gives the NotificationLog something to reference.

r.get('/templates', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const templates = await prisma.setting.findMany({
      where: { branchId, key: { startsWith: 'msg_template:' } },
      orderBy: { key: 'asc' },
    });
    res.json({
      data: templates.map((t) => ({
        id: t.id,
        key: t.key.replace('msg_template:', ''),
        name: (t.value as { name?: string }).name ?? t.key,
        body: (t.value as { body?: string }).body ?? '',
        channel: (t.value as { channel?: string }).channel ?? 'SMS',
      })),
    });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.post('/templates', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { key, name, body, channel } = req.body ?? {};
    if (!key || !body) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'key and body are required.' });
      return;
    }
    const template = await prisma.setting.upsert({
      where: { branchId_key: { branchId, key: `msg_template:${key}` } },
      create: { branchId, key: `msg_template:${key}`, value: { name: name ?? key, body, channel: channel ?? 'SMS' } },
      update: { value: { name: name ?? key, body, channel: channel ?? 'SMS' } },
    });
    res.status(201).json(template);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Targeted dispatch with NotificationLog (2.7.5 / 3.8) ──
// Announcements target roles AND classes/sections. Dispatch resolves the
// audience to real guardians/staff and writes a NotificationLog row per
// recipient with the rendered body — the delivery-dispute answer.

r.post('/dispatch', async (req, res) => {
  try {
    const { branchId, userId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { title, content, type, targetRoles, classIds, sectionIds, templateKey, channel, variables, staffOnly } = req.body ?? {};
    if (!content && !templateKey) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'content or templateKey is required.' });
      return;
    }
    // `staffOnly` exists because the default audience is guardians: without it,
    // a report meant for the principal and the accountant silently reaches every
    // parent in the branch. Staff-only dispatches must name their roles, or
    // there is nobody to send to at all.
    if (staffOnly && !targetRoles?.length) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'staffOnly requires targetRoles — otherwise the dispatch has no audience.' });
      return;
    }

    let body = content;
    if (templateKey && !content) {
      const setting = await prisma.setting.findUnique({ where: { branchId_key: { branchId, key: `msg_template:${templateKey}` } } });
      if (!setting) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: `Template ${templateKey} not found.` }); return; }
      body = (setting.value as { body?: string }).body ?? '';
    }

    // Resolve the audience: guardians of students in the targeted
    // classes/sections — or ALL enrolled students of the branch when no
    // filter is given (school-wide circulars are the most common dispatch).
    // Plus staff holding any of the targeted roles.
    const enrollments = staffOnly
      ? []
      : await prisma.studentEnrollment.findMany({
          where: {
            branchId,
            status: 'ENROLLED',
            toDate: null,
            ...(sectionIds && { sectionId: { in: sectionIds } }),
            ...(classIds && { classId: { in: classIds } }),
          },
          select: { studentId: true },
        });
    const audienceStudentIds: string[] = enrollments.map((e) => e.studentId);

    const guardiansRaw = audienceStudentIds.length
      ? await prisma.studentGuardian.findMany({
          where: { studentId: { in: audienceStudentIds }, receivesComms: true, guardian: { userId: { not: null } } },
          include: { guardian: { select: { fullName: true, phone: true, email: true, userId: true } } },
          distinct: ['guardianId'],
        })
      : [];
    // Guardian phones are encrypted at rest (Phase 12.5); delivery needs plaintext.
    const guardians = guardiansRaw.map((sg) => ({ ...sg, guardian: { ...sg.guardian, phone: decryptField(sg.guardian.phone) } }));

    // Staff are resolved BY ROLE, not merely because some roles were named: a
    // report scheduled to BRANCH_ADMIN must not land on all 31 teachers' phones.
    // A role assignment with a null branchId is school-wide, so it reaches every
    // branch's holder. Resolved in two steps (role holders, then their HR rows)
    // rather than a nested relation filter — the point of the check is which
    // ROLE a person holds, and the HR table is only needed for a phone number.
    const roleFilter: Prisma.UserRoleAssignmentWhereInput = {
      isActive: true,
      role: { code: { in: targetRoles ?? [] }, isActive: true },
      OR: [{ branchId: null }, { branchId }],
    };

    const roleHolders = targetRoles?.length
      ? await prisma.user.findMany({
          where: { isActive: true, roleAssignments: { some: roleFilter } },
          select: { id: true, email: true },
        })
      : [];
    const roleHolderIds = roleHolders.map((u) => u.id);

    const staffRows = roleHolderIds.length
      ? await prisma.staff.findMany({
          where: { userId: { in: roleHolderIds }, isActive: true, deletedAt: null },
          select: { id: true, userId: true, branchId: true, firstName: true, lastName: true, phone: true },
        })
      : [];
    const staff = staffOnly ? [] : staffRows.filter((s) => s.branchId === branchId);

    // A staff-only audience keys off the user, not the HR row: a branch admin is
    // a user holding a role and often has no staff record at all, so resolving a
    // report audience from `staff` alone would silently reach nobody.
    const staffOnlyRecipients = staffOnly
      ? roleHolders.map((u) => ({
          userId: u.id,
          email: u.email,
          staff: staffRows.find((s) => s.userId === u.id) ?? null,
        }))
      : [];

    const render = (text: string, vars: Record<string, string>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

    const logs: Array<{ channel: 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH'; recipientType: string; recipientId: string; recipient?: string; subject?: string; body: string; status: 'QUEUED' }> = [];
    const ch = (channel ?? 'SMS') as 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH';
    // The drain sends to `recipient` verbatim on every non-PUSH channel, so the
    // address must match the channel: EMAIL to an email address, SMS/WhatsApp to
    // a phone number. Preferring a phone number for EMAIL queued rows that could
    // only ever fail.
    const addressFor = (
      channel: 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH',
      contact: { phone?: string | null; email?: string | null },
    ): string | undefined => {
      if (channel === 'EMAIL') return contact.email ?? undefined;
      if (channel === 'PUSH') return undefined;
      return contact.phone ?? undefined;
    };

    for (const g of guardians) {
      logs.push({
        channel: ch,
        recipientType: 'GUARDIAN',
        // PUSH resolves recipients through the device registry, keyed by
        // userId (§5.4); every other channel addresses the guardian record.
        // The where-clause guarantees userId is non-null for guardians.
        recipientId: ch === 'PUSH' ? (g.guardian.userId as string) : g.guardianId,
        recipient: addressFor(ch, { phone: g.guardian.phone, email: g.guardian.email }),
        subject: title,
        body: render(body!, { guardianName: g.guardian.fullName, ...(variables ?? {}) }),
        status: 'QUEUED',
      });
    }
    const emailByUserId = new Map(roleHolders.map((u) => [u.id, u.email] as const));
    for (const s of staff) {
      logs.push({
        channel: ch,
        recipientType: 'STAFF',
        recipientId: ch === 'PUSH' ? s.userId : s.id,
        recipient: addressFor(ch, { phone: s.phone, email: emailByUserId.get(s.userId) }),
        subject: title,
        body: render(body!, { staffName: `${s.firstName} ${s.lastName}`, ...(variables ?? {}) }),
        status: 'QUEUED',
      });
    }
    for (const u of staffOnlyRecipients) {
      const name = u.staff ? `${u.staff.firstName} ${u.staff.lastName}` : u.email;
      logs.push({
        channel: ch,
        recipientType: u.staff ? 'STAFF' : 'USER',
        // PUSH addresses the user; other channels the staff record when there is
        // one, so a notification log still points at a person, not an address.
        recipientId: ch === 'PUSH' ? u.userId : (u.staff?.id ?? u.userId),
        recipient: addressFor(ch, { phone: u.staff?.phone, email: u.email }),
        subject: title,
        body: render(body!, { staffName: name, userName: name, ...(variables ?? {}) }),
        status: 'QUEUED',
      });
    }

    // Persist the dispatch log in batches; QUEUED rows are drained by the
    // notification-engine, which updates status + provider message id.
    if (logs.length) {
      // Note: NotificationLog has no createdBy column — authorship is carried
      // by the announcement created below.
      await prisma.notificationLog.createMany({ data: logs.map((l) => ({ ...l, branchId })) });
    }

    // The announcement itself is still recorded for the in-app feed.
    const announcement = await prisma.announcement.create({
      data: {
        title: title ?? (templateKey ? `Dispatch: ${templateKey}` : 'Dispatch'),
        content: body!,
        type: type ?? 'CIRCULAR',
        targetRoles: (targetRoles ?? []) as string[],
        branchId,
        createdBy: userId,
      },
    });

    // Live WebSocket heads-up for staff recipients — the QUEUED rows above
    // cover the durable channels (FCM/SMS/WhatsApp/email); this covers a
    // staff member who has the app open RIGHT NOW. Recipients are user-keyed:
    // staffTable covers the role-resolved HR rows, and the staff-only audience
    // resolves by role (branch admins may hold no staff record at all), so the
    // two unions cover everyone. The announce's own identity signs the engine
    // call — a service-to-service enhancement, skipped silently when the
    // private key is absent.
    const wsTargets = [
      ...new Set([
        ...staff.map((s) => s.userId),
        ...(ch === 'PUSH'
          ? staffOnlyRecipients.map((u) => u.userId)
          : staffOnlyRecipients.filter((u) => u.staff).map((u) => u.staff!.userId)),
      ]),
    ];
    if (
      wsTargets.length > 0 &&
      engineNotifyConfig.internalAssertionPrivateKey &&
      engineNotifyConfig.notificationEngineUrl
    ) {
      void notifyStaffUsers(
        { userId, email: ctx(req).email, tenantId: ctx(req).tenantId, branchId },
        {
          title: title ?? 'Announcement',
          body: String(body ?? '').slice(0, 200),
          deepLink: 'erp://announcements',
          kind: 'ANNOUNCEMENT',
        },
        wsTargets,
        {
          ...engineNotifyConfig,
          // No communicationBaseUrl — these rows are ALREADY queued above;
          // re-notifying would double-credit the FCM send.
        },
      );
    }

    res.status(201).json({
      announcementId: announcement.id,
      queued: logs.length,
      staffOnly: staffOnly === true,
      audience: {
        guardians: guardians.length,
        staff: staff.length,
        users: staffOnlyRecipients.length,
      },
    });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Dispatcher (BUILD_PLAN 5.5): drain QUEUED → providers ──
// Manual/ops trigger for the queue drainer; a cron or the notification-engine
// calls this on a schedule in production.

r.post('/dispatch/drain', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const result = await dispatcher.drain({
      // urgent=true bypasses quiet hours — for absence alerts/emergencies.
      urgent: req.body?.urgent === true,
      limit: typeof req.body?.limit === 'number' ? Math.min(200, Math.max(1, req.body.limit)) : undefined,
    });
    void branchId;
    res.json(result);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Push device registry (BUILD_PLAN 5.4) ──
// The mobile apps call this right after login: one FCM token per device,
// keyed by the token itself (a device re-registering after a new login
// takes over its row — the newest account on the phone wins). The
// dispatcher deletes rows FCM reports unregistered.

r.post('/devices', async (req, res) => {
  try {
    const { userId } = ctx(req);
    if (!userId) { res.status(403).json({ detail: 'Account has no user id — cannot register a device.' }); return; }
    const { token, platform, label } = req.body ?? {};
    if (!token || typeof token !== 'string' || token.length < 16) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'token is required (FCM registration token).' });
      return;
    }
    if (!platform || !['ANDROID', 'IOS', 'WEB'].includes(platform)) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'platform must be ANDROID, IOS, or WEB.' });
      return;
    }
    const device = await prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform, ...(label ? { label } : {}) },
      update: { userId, platform, ...(label ? { label } : {}), isActive: true, lastSeenAt: new Date() },
    });
    res.status(201).json({ id: device.id });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.delete('/devices/:id', async (req, res) => {
  try {
    const { userId } = ctx(req);
    // updateMany scoped to the caller: a foreign device id 404s silently
    // (count 0) instead of leaking that the row exists.
    const gone = await prisma.deviceToken.deleteMany({ where: { id: req.params.id, userId } });
    if (gone.count === 0) { res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: 'Device not found.' }); return; }
    res.status(204).send();
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Automated trigger: absence alert (BUILD_PLAN 5.6 #1 / GATE 5) ──
// Called two ways: attendance-service fires it right after /mark (the live
// path — phone buzzes within minutes of the teacher tapping), and the cron
// sweeps every morning (catches late marking or a failed live call). The
// scan is idempotent per (branch, date), so double-firing queues nothing.
// `drain: true` makes the live path also kick the drainer immediately so
// the alert goes out within the same request window.

r.post('/absence-alerts/scan', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch — cannot scan attendance.' }); return; }
    const { date, channel, drain } = req.body ?? {};
    const day = date ? new Date(date) : new Date();
    if (Number.isNaN(day.getTime())) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'date must be a valid date (YYYY-MM-DD).' });
      return;
    }
    if (channel && !['WHATSAPP', 'SMS', 'PUSH'].includes(channel)) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'channel must be WHATSAPP, SMS, or PUSH.' });
      return;
    }

    const scan = await scanAbsencesForDate(prisma, branchId, day, { channel });

    // The live path wants the alert out the door now: drain urgently —
    // quiet hours never delay a same-morning absence notice (§5.8).
    let drained: Awaited<ReturnType<Dispatcher['drain']>> | null = null;
    if (drain === true) {
      drained = await dispatcher.drain({ urgent: true });
    }
    res.json({ ...scan, drained });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Automated trigger: fee due/overdue reminders (BUILD_PLAN 5.6 #2) ──
// Fired by the nightly sweep and manually by ops. Idempotent per
// (invoice, kind) — the log rows dedupe, so re-firing never spams.

r.post('/fee-reminders/scan', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch — cannot scan invoices.' }); return; }
    const { date, channel, drain, dueSoonDays } = req.body ?? {};
    const day = date ? new Date(date) : new Date();
    if (Number.isNaN(day.getTime())) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'date must be a valid date (YYYY-MM-DD).' });
      return;
    }
    if (channel && !['WHATSAPP', 'SMS', 'EMAIL', 'PUSH'].includes(channel)) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'channel must be WHATSAPP, SMS, EMAIL, or PUSH.' });
      return;
    }

    const scan = await scanFeeRemindersForDate(prisma, branchId, day, { channel, dueSoonDays });

    let drained: Awaited<ReturnType<Dispatcher['drain']>> | null = null;
    if (drain === true) {
      drained = await dispatcher.drain();
    }
    res.json({ ...scan, drained });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Automated trigger: exam schedule (§5.6) ──
// Daily sweep + manual re-fire; idempotent per examination.

r.post('/exam-triggers/schedule-scan', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch — cannot scan examinations.' }); return; }
    const { date, channel, daysAhead, drain } = req.body ?? {};
    const day = date ? new Date(date) : new Date();
    if (Number.isNaN(day.getTime())) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'date must be a valid date (YYYY-MM-DD).' });
      return;
    }

    const scan = await scanExamSchedules(prisma, branchId, day, { channel, daysAhead });
    let drained: Awaited<ReturnType<Dispatcher['drain']>> | null = null;
    if (drain === true) drained = await dispatcher.drain();
    res.json({ ...scan, drained });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Automated trigger: results published (§5.6 / 2.6.5) ──
// Called by ops right after the PUBLISHED transition (exam-service will be
// the natural caller). Refuses non-published exams: parents must never get
// a results notice before the results are actually visible.

r.post('/exam-triggers/results-published', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch — cannot notify results.' }); return; }
    const { examinationId, channel, drain } = req.body ?? {};
    if (!examinationId) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'examinationId is required.' });
      return;
    }

    let scan: Awaited<ReturnType<typeof notifyResultsPublished>>;
    try {
      scan = await notifyResultsPublished(prisma, branchId, examinationId, { channel });
    } catch (err) {
      const msg = (err as Error).message;
      if (/not PUBLISHED/.test(msg)) {
        res.status(409).json({ type: 'state-conflict', title: 'Wrong State', status: 409, detail: msg });
        return;
      }
      if (/not found/.test(msg)) {
        res.status(404).json({ type: 'not-found', title: 'Not Found', status: 404, detail: msg });
        return;
      }
      throw err;
    }
    let drained: Awaited<ReturnType<Dispatcher['drain']>> | null = null;
    if (drain === true) drained = await dispatcher.drain();
    res.json({ ...scan, drained });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

// ── Staff notification (single-user push) ──
// Peer services (staff-service leave decisions, exam publishes, payroll runs)
// call this with an internal assertion to notify ONE user on their registered
// devices. It writes a PUSH NotificationLog row (the delivery-dispute trail)
// and drains urgently — quiet hours never delay a decision the teacher is
// waiting for. recipientId = userId because PUSH resolves recipients through
// the device registry (§5.4). `link:erp://…` in the template slot becomes the
// push's deepLink, the same convention the class dispatch uses.
// Service-only: the gateway signs SYSTEM assertions for peers; humans have
// named roles, so this gate cannot be satisfied by any logged-in account.
r.post('/staff-notify', async (req, res) => {
  try {
    const { userId, roles, branchId } = ctx(req);
    if (!roles.includes('SYSTEM')) {
      res.status(403).json({ type: 'forbidden', title: 'Forbidden', status: 403, detail: 'Service-only endpoint.' });
      return;
    }
    const { targetUserId, title, body, deepLink } = req.body ?? {};
    if (!targetUserId || !title || !body) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'targetUserId, title, and body are required.' });
      return;
    }
    const log = await prisma.notificationLog.create({
      data: {
        branchId: branchId!,
        channel: 'PUSH',
        recipientType: 'USER',
        recipientId: String(targetUserId),
        subject: String(title).slice(0, 120),
        body: String(body).slice(0, 500),
        ...(deepLink ? { template: `link:${String(deepLink)}` } : {}),
        status: 'QUEUED',
      },
    });
    // Urgent drain bounds this route's latency; failures leave the row QUEUED
    // for the regular drainer (retry-with-backoff), never lost.
    const drained = await dispatcher.drain({ urgent: true, limit: 5 });
    res.status(201).json({ id: log.id, drained: { sent: drained.sent, failed: drained.failed } });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

r.get('/dispatch-logs', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    if (!branchId) { res.status(403).json({ detail: 'Account has no branch.' }); return; }
    const { status, channel } = req.query;
    const logs = await prisma.notificationLog.findMany({
      where: { branchId, ...(status && { status: status as never }), ...(channel && { channel: channel as never }) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({ data: logs });
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

  // Provider delivery callbacks (public + raw body; HMAC is the handler's
  // job) — Meta WhatsApp statuses land here (§5.1 delivery receipts).
  mountPublicWebhook('/webhooks', createProviderWebhookRoute(prisma, messaging));

  mount('/', r);
  finalize();

  return app;
}

// ── Provider webhook: delivery receipts (BUILD_PLAN 5.1 / 5.5) ──
// Meta's servers cannot carry a Bearer token; authenticity is the HMAC over
// the raw body. Statuses update the NotificationLog rows the dispatcher
// stamped — closing the delivery-receipt loop with per-message costs.
function createProviderWebhookRoute(
  prisma: PrismaClient,
  messaging: { whatsappWebhookSecret?: string; messagingWebhookSecret?: string },
) {
  return async (req: express.Request, res: express.Response) => {
    const secret = messaging.whatsappWebhookSecret ?? messaging.messagingWebhookSecret;
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;

    // Meta webhook verification handshake (hub.challenge echo).
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token']) {
      if (!secret || req.query['hub.verify_token'] !== secret) {
        res.status(403).json({ detail: 'verification token mismatch' });
        return;
      }
      res.status(200).send(req.query['hub.challenge'] ?? '');
      return;
    }

    if (!secret) {
      res.status(503).json({ type: 'not-configured', title: 'Not Configured', status: 503, detail: 'No webhook secret configured — every payload fails closed.' });
      return;
    }
    if (!raw || !WhatsAppClient.verifySignature(raw, req.header('x-hub-signature-256'), secret)) {
      res.status(401).json({ type: 'authentication-error', title: 'Unauthorized', status: 401, detail: 'Invalid or missing signature.' });
      return;
    }

    try {
      const statuses = parseDeliveryStatuses(req.body);
      let matched = 0;
      for (const s of statuses) {
        const updated = await prisma.notificationLog.updateMany({
          where: { providerMessageId: s.providerMessageId },
          data: {
            status: s.status,
            ...(s.error ? { error: s.error } : {}),
            ...(s.status === 'DELIVERED' || s.status === 'READ' ? { sentAt: s.timestamp ?? new Date() } : {}),
          },
        });
        matched += updated.count;
      }
      res.json({ received: statuses.length, matched });
    } catch (e) {
      res.status(500).json({ detail: (e as Error).message });
    }
  };
}

// ── Entrypoint ──
// Boot happens ONLY when this file is the process entry. Importing this
// module (tests, e2e, gateway probes) must have zero side effects: module-
// scope loadServiceEnv process.exit(1)'d CI suites that merely imported the
// app factory without a real .env.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  const env = loadServiceEnv(SERVICE_NAME, 'PORT_COMMUNICATION_SERVICE');
  const prisma = new PrismaClient();
  const app = createCommunicationApp({ env, prisma });
  const server = listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => {
    await getChatHub()?.close();
    await directHubServer?.close();
    await prisma.$disconnect();
  });

  // ── Chat WebSocket hub (Phase 9) ──
  // Attached to the MAIN listener (the gateway proxies /api/v1/communication
  // upgrades with ws:true) and, when CHAT_HUB_PORT is set, ALSO on a dedicated
  // port for direct mobile/container connections that bypass the gateway.
  const hub = getChatHub();
  let directHubServer: import('http').Server | null = null;
  if (hub) {
    hub.attach(server, env.REDIS_URL);
    if (env.CHAT_HUB_PORT && env.CHAT_HUB_PORT !== env.PORT) {
      directHubServer = createServer((_req, res) => {
        res.writeHead(426, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Upgrade Required — connect with WebSocket to /chat/ws?t=<ticket>' }));
      });
      directHubServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/chat/ws') { socket.destroy(); return; }
        (hub as unknown as { handleUpgrade: (r: unknown, s: unknown, h: Buffer) => void }).handleUpgrade(req, socket, head);
      });
      directHubServer.listen(env.CHAT_HUB_PORT, () => {
        console.log(`[chat-hub] direct listener on :${env.CHAT_HUB_PORT}`);
        directHubServer?.unref?.();
      });
    }
  } else {
    console.log('[chat-hub] CHAT_TICKET_SECRET not set — live chat delivery disabled (polling only)');
  }

  // ── Morning absence sweep + queue drain (BUILD_PLAN 5.6 #1) ──
  // The live path (attendance-service firing the scan after /mark) is the
  // normal producer; this sweep is the safety net for late marking or a
  // failed live call. The scan is idempotent per date, so the sweep can
  // never double-alert what the live path already covered. Also drains the
  // queue every 5 minutes so a live-path drain failure self-heals.
  const ABSENCE_SWEEP_MS = 15 * 60 * 1000;
  const DRAIN_MS = 5 * 60 * 1000;
  const absenceTimer = setInterval(
    async () => {
      try {
        const hour = new Date().getHours();
        // Sweep mornings only (06:00–11:59) — absence alerts are a same-
        // morning product; afternoon sweeps would just re-litigate history.
        if (hour >= 6 && hour < 12) {
          const branches = await prisma.branch.findMany({ select: { id: true } });
          for (const b of branches) {
            await scanAbsencesForDate(prisma, b.id, new Date());
          }
        }
      } catch (err) {
        // A sweep failure must never kill the interval or the service.
        console.error('[absence-sweep] failed:', (err as Error).message);
      }
    },
    ABSENCE_SWEEP_MS,
  );

  // ── Nightly fee-reminder sweep (§5.6 #2) ──
  // Once a day, in the morning window, per branch. Idempotent per invoice.
  // The same pass scans exam schedules (§5.6) — one cron, two triggers.
  const feeTimer = setInterval(
    async () => {
      try {
        const hour = new Date().getHours();
        if (hour >= 6 && hour < 12) {
          const branches = await prisma.branch.findMany({ select: { id: true } });
          for (const b of branches) {
            await scanFeeRemindersForDate(prisma, b.id, new Date());
            await scanExamSchedules(prisma, b.id, new Date());
          }
        }
      } catch (err) {
        console.error('[fee-reminder-sweep] failed:', (err as Error).message);
      }
    },
    ABSENCE_SWEEP_MS,
  );
  feeTimer.unref?.();
  absenceTimer.unref?.();

  const drainTimer = setInterval(async () => {
    try {
      const messaging = messagingFromEnv();
      await new Dispatcher(prisma, {
        whatsapp: messaging.whatsapp,
        sms: messaging.sms,
        fcm: messaging.fcm ?? null,
        email: messaging.email ?? null,
        quietHours: messaging.quietHours,
      }).drain();
    } catch (err) {
      console.error('[queue-drain] failed:', (err as Error).message);
    }
  }, DRAIN_MS);
  drainTimer.unref?.();
}
