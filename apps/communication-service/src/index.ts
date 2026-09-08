// ──────────────────────────────────────────────
// School ERP — Communication Service
// ──────────────────────────────────────────────

import { Router } from 'express';
import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { createServiceApp, listenWithGracefulShutdown, ctx } from '@school-erp/auth';

const SERVICE_NAME = 'communication-service';
const env = loadServiceEnv(SERVICE_NAME, 'PORT_COMMUNICATION_SERVICE');
const prisma = new PrismaClient();

// No CORS, no dotenv, no per-service port fallback. Configuration comes from
// @school-erp/config (missing var = crash at boot), and every non-health route
// is gated behind a gateway-signed, audience-bound assertion (GATE 0).
const { app, mount, finalize } = createServiceApp({
  serviceName: SERVICE_NAME,
  assertionPublicKey: env.INTERNAL_ASSERTION_PUBLIC_KEY,
  readinessCheck: async () => { await prisma.$queryRaw`SELECT 1`; },
});

app.set('prisma', prisma);

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

mount('/', r);
finalize();

listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });

export { app, prisma };
