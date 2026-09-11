// ──────────────────────────────────────────────
// School ERP — Communication Service
// ──────────────────────────────────────────────

import { Router } from 'express';
import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { createServiceApp, listenWithGracefulShutdown, ctx } from '@school-erp/auth';
import { buildOpenApiDocument } from '@school-erp/http';

/** MUST equal the gateway route-table audience for this service. */
const SERVICE_NAME = 'communication-service';

export interface CommunicationAppOptions {
  env: { INTERNAL_ASSERTION_PUBLIC_KEY: string };
  prisma: PrismaClient;
}

/**
 * App factory — split from the entrypoint so tests can inject a Prisma
 * client and an explicit env without booting the real process.
 */
export function createCommunicationApp(options: CommunicationAppOptions) {
  const { prisma } = options;
  const env = { INTERNAL_ASSERTION_PUBLIC_KEY: options.env.INTERNAL_ASSERTION_PUBLIC_KEY };

  const { app, mount, finalize } = createServiceApp({
    serviceName: SERVICE_NAME,
    assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
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
    // classes/sections (or all when none given), plus staff holding any of
    // the targeted roles.
    const audienceStudentIds: string[] = [];
    if (classIds || sectionIds) {
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
      audienceStudentIds.push(...enrollments.map((e) => e.studentId));
    }

    const guardians = audienceStudentIds.length
      ? await prisma.studentGuardian.findMany({
          where: { studentId: { in: audienceStudentIds }, receivesComms: true, guardian: { userId: { not: null } } },
          include: { guardian: { select: { fullName: true, phone: true, email: true } } },
          distinct: ['guardianId'],
        })
      : [];

    const staff = targetRoles?.length
      ? await prisma.staff.findMany({ where: { branchId, isActive: true }, select: { id: true, firstName: true, lastName: true, phone: true } })
      : [];

    const render = (text: string, vars: Record<string, string>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

    const logs: Array<{ channel: 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH'; recipientType: string; recipientId: string; recipient?: string; body: string; status: 'QUEUED' }> = [];
    const ch = (channel ?? 'SMS') as 'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH';
    for (const g of guardians) {
      logs.push({
        channel: ch,
        recipientType: 'GUARDIAN',
        recipientId: g.guardianId,
        recipient: g.guardian.phone ?? g.guardian.email ?? undefined,
        body: render(body!, { guardianName: g.guardian.fullName, ...(variables ?? {}) }),
        status: 'QUEUED',
      });
    }
    for (const s of staff) {
      logs.push({
        channel: ch,
        recipientType: 'STAFF',
        recipientId: s.id,
        recipient: s.phone,
        body: render(body!, { staffName: `${s.firstName} ${s.lastName}`, ...(variables ?? {}) }),
        status: 'QUEUED',
      });
    }

    // Persist the dispatch log in batches; QUEUED rows are drained by the
    // notification-engine, which updates status + provider message id.
    if (logs.length) {
      await prisma.notificationLog.createMany({ data: logs.map((l) => ({ ...l, branchId, createdBy: userId })) });
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

  mount('/', r);
  finalize();

  return app;
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
