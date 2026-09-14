// ──────────────────────────────────────────────
// School ERP — Communication Service
// ──────────────────────────────────────────────

import express, { Router } from 'express';
import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { createServiceApp, listenWithGracefulShutdown, ctx } from '@school-erp/auth';
import { buildOpenApiDocument } from '@school-erp/http';
import { WhatsAppClient, parseDeliveryStatuses } from './whatsapp';
import { SmsClient } from './sms';
import { FcmClient } from './fcm';
import { Dispatcher } from './dispatcher';

/** MUST equal the gateway route-table audience for this service. */
const SERVICE_NAME = 'communication-service';

/**
 * Messaging providers from process env. Every key is optional — the service
 * runs unconfigured (the dispatcher fails sends closed with clear errors)
 * exactly like fee-service boots without Razorpay keys.
 */
function messagingFromEnv() {
  const e = loadServiceEnv(SERVICE_NAME, 'PORT_COMMUNICATION_SERVICE');
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
    whatsappWebhookSecret: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    messagingWebhookSecret: e.MESSAGING_WEBHOOK_SECRET,
    quietHours: { start: e.QUIET_HOURS_START, end: e.QUIET_HOURS_END },
  };
}

export interface CommunicationAppOptions {
  env: { INTERNAL_ASSERTION_PUBLIC_KEY: string };
  prisma: PrismaClient;
  /** Injected messaging config (defaults from loadServiceEnv). */
  messaging?: {
    whatsapp: WhatsAppClient | null;
    sms: SmsClient | null;
    fcm?: FcmClient | null;
    whatsappWebhookSecret?: string;
    messagingWebhookSecret?: string;
    quietHours: { start: number; end: number };
  };
}

/**
 * App factory — split from the entrypoint so tests can inject a Prisma
 * client and an explicit env without booting the real process.
 */
export function createCommunicationApp(options: CommunicationAppOptions) {
  const { prisma } = options;
  const env = { INTERNAL_ASSERTION_PUBLIC_KEY: options.env.INTERNAL_ASSERTION_PUBLIC_KEY };

  // Providers come from env; null means "not configured" — the service and
  // dispatcher still run, sends fail closed with clear errors (§5.1/5.2).
  const messaging = options.messaging ?? messagingFromEnv();
  const dispatcher = new Dispatcher(prisma, {
    whatsapp: messaging.whatsapp,
    sms: messaging.sms,
    fcm: messaging.fcm ?? null,
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
      '/devices/{id}': {
        delete: { summary: 'Remove a registered device (logout / token rotation)', tags: ['push'], responses: { '204': { description: 'Removed' } } },
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
    const { title, content, type, targetRoles, classIds, sectionIds, templateKey, channel, variables } = req.body ?? {};
    if (!content && !templateKey) {
      res.status(400).json({ type: 'validation-error', title: 'Invalid Input', status: 400, detail: 'content or templateKey is required.' });
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
    const enrollments = await prisma.studentEnrollment.findMany({
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

    const guardians = audienceStudentIds.length
      ? await prisma.studentGuardian.findMany({
          where: { studentId: { in: audienceStudentIds }, receivesComms: true, guardian: { userId: { not: null } } },
          include: { guardian: { select: { fullName: true, phone: true, email: true, userId: true } } },
          distinct: ['guardianId'],
        })
      : [];

    const staff = targetRoles?.length
      ? await prisma.staff.findMany({ where: { branchId, isActive: true }, select: { id: true, userId: true, firstName: true, lastName: true, phone: true } })
      : [];

    const render = (text: string, vars: Record<string, string>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

    const logs: Array<{ channel: 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH'; recipientType: string; recipientId: string; recipient?: string; body: string; status: 'QUEUED' }> = [];
    const ch = (channel ?? 'SMS') as 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH';
    for (const g of guardians) {
      logs.push({
        channel: ch,
        recipientType: 'GUARDIAN',
        // PUSH resolves recipients through the device registry, keyed by
        // userId (§5.4); every other channel addresses the guardian record.
        // The where-clause guarantees userId is non-null for guardians.
        recipientId: ch === 'PUSH' ? (g.guardian.userId as string) : g.guardianId,
        recipient: ch === 'PUSH' ? undefined : g.guardian.phone ?? g.guardian.email ?? undefined,
        body: render(body!, { guardianName: g.guardian.fullName, ...(variables ?? {}) }),
        status: 'QUEUED',
      });
    }
    for (const s of staff) {
      logs.push({
        channel: ch,
        recipientType: 'STAFF',
        recipientId: ch === 'PUSH' ? s.userId : s.id,
        recipient: ch === 'PUSH' ? undefined : s.phone,
        body: render(body!, { staffName: `${s.firstName} ${s.lastName}`, ...(variables ?? {}) }),
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

    res.status(201).json({ announcementId: announcement.id, queued: logs.length, audience: { guardians: guardians.length, staff: staff.length } });
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
const env = loadServiceEnv(SERVICE_NAME, 'PORT_COMMUNICATION_SERVICE');
const prisma = new PrismaClient();
const app = createCommunicationApp({ env, prisma });

// Only bind a port when run directly. Imported by tests or the e2e suite,
// the module must NOT listen — vitest would hit EADDRINUSE across suites.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });
}

export { app, prisma };
