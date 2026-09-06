// ──────────────────────────────────────────────
// School ERP — Communication Service
// ──────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@school-erp/database';
import { ctx } from '@school-erp/auth';

dotenv.config({ path: '../../.env' });

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT_COMMUNICATION_SERVICE || 4005;

app.use(cors());
app.use(express.json());
app.set('prisma', prisma);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'communication-service', timestamp: new Date().toISOString() });
});

// ── Announcements ──
app.get('/announcements', async (req, res) => {
  try {
    const { branchId, roles } = ctx(req);
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

app.post('/announcements', async (req, res) => {
  try {
    const { branchId } = ctx(req);
    const { userId: createdBy } = ctx(req);
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

app.put('/announcements/:id', async (req, res) => {
  try {
    const announcement = await prisma.announcement.update({ where: { id: req.params.id }, data: req.body });
    res.json(announcement);
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

app.delete('/announcements/:id', async (req, res) => {
  try {
    await prisma.announcement.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.status(204).send();
  } catch (e) { res.status(500).json({ detail: (e as Error).message }); }
});

process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });
app.listen(PORT, () => console.log(`📢 Communication Service running on http://localhost:${PORT}`));
export { app, prisma };
