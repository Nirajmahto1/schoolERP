// ──────────────────────────────────────────────
// Provision-service routes
//
//   PUBLIC  GET   /setup/status      → { provisioned } (page router guard)
//   PUBLIC  GET   /setup/school      → { name, code, logoUrl } (chrome branding)
//   PUBLIC* POST  /setup             → the one-shot bootstrap
//   GATED   GET   /branches          → list with student/staff counts
//   GATED   POST  /branches          → add a branch (+year + class ladder)
//   GATED   PATCH /branches/:id      → rename / deactivate
//
// * POST /setup is "guarded public": reachable without a token only while the
//   database has no School row, and (when SETUP_TOKEN is configured) only with
//   the shared secret. The first successful run locks it permanently — the
//   empty-database check inside bootstrapTenant is the real lock, and bcrypt
//   cost caps how fast a lost race can be retried.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import path from 'path';
import { z } from 'zod';
import type { PrismaClient } from '@school-erp/database';
import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import type { ProvisionEnv } from '@school-erp/config';
import { requireRole } from '@school-erp/auth';
import {
  bootstrapTenant,
  addBranch,
  isProvisioned,
  registerControlPlane,
  BootstrapError,
} from './bootstrap';
import { logoUpload, saveLogo, deleteLogoByUrl, LogoError, logoStorageDir } from './logo';
import { logger } from './utils/logger';

export const setupRouter = Router();
export const branchRouter = Router();

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function controlPlaneOf(req: Request): ControlPlaneClient | undefined {
  return req.app.get('controlPlane') as ControlPlaneClient | undefined;
}

function problem(res: Response, status: number, type: string, title: string, detail: string, errors?: unknown): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail, ...(errors ? { errors } : {}) });
}

// ── GET /setup/status ── whether the wizard should be shown at all.
setupRouter.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json({ provisioned: await isProvisioned(prismaOf(_req)) });
  } catch {
    problem(res, 503, 'unavailable', 'Not Ready', 'Database is not reachable.');
  }
});

const schoolCodeSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-zA-Z0-9]+$/, 'Letters and numbers only');

/**
 * `logo` arrives as multipart form-data (the file upload) or the JSON body
 * fields arrive alone (multipart with no file also lands here — logo stays
 * null). Everything else is a JSON POST.
 */
const setupSchema = z.object({
  schoolName: z.string().min(2).max(120),
  schoolCode: schoolCodeSchema,
  address: z.string().max(200).optional().default(''),
  city: z.string().max(80).optional().default(''),
  state: z.string().max(80).optional().default(''),
  pincode: z
    .union([z.string().regex(/^\d{6}$/, '6-digit PIN code'), z.literal('')])
    .optional()
    .transform((v) => (v ? v : '000000')),
  // Absent or empty both mean "not provided" — a ZodDefault('') would be
  // re-validated against min(6) and reject every blank form.
  phone: z
    .union([z.string().min(6).max(15), z.literal('')])
    .optional()
    .transform((v) => (v ? v : '')),
  email: z
    .union([z.string().email(), z.literal('')])
    .optional()
    .transform((v) => (v ? v : '')),
  branchName: z.string().min(2).max(80).optional().default('Main Campus'),
  branchCode: schoolCodeSchema.max(8).optional().default('MAIN'),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(10).max(128),
  logo: z.string().max(512).optional().nullable(),
});

// ── POST /setup ── guarded public; multipart when a logo is attached.
setupRouter.post('/', logoUpload.single('logo'), async (req: Request, res: Response) => {
  const env: ProvisionEnv = req.app.get('env');
  const tokenHeader = req.header('x-setup-token');
  if (env.SETUP_TOKEN && tokenHeader !== env.SETUP_TOKEN) {
    problem(res, 401, 'setup-token-required', 'Setup Token Required', 'Send the configured setup token as the x-setup-token header.');
    return;
  }

  // Multer puts text fields on req.body; the file (when sent) on req.file.
  const raw = { ...req.body };

  let body: z.infer<typeof setupSchema>;
  try {
    body = setupSchema.parse(raw);
  } catch (err) {
    const flat = (err as z.ZodError).flatten();
    problem(res, 400, 'validation-error', 'Invalid Input', 'Check the highlighted fields.', flat.fieldErrors);
    return;
  }

  const prisma = prismaOf(req);
  let logoUrl: string | null = null; // outer scope so rollback can reach it
  try {
    // Cheap pre-check so a lost race doesn't burn bcrypt work; the binding
    // lock is the same test inside bootstrapTenant.
    if (await isProvisioned(prisma)) {
      problem(res, 409, 'already-provisioned', 'Already Set Up', 'This deployment already has a school. Sign in instead.');
      return;
    }

    // Content-sniff + persist the upload before touching the database: a
    // fake image fails here with 415 and nothing is created.
    if (req.file) {
      logoUrl = await saveLogo(req.file.buffer);
    }

    const adminEmail = body.adminEmail.trim().toLowerCase();
    const result = await bootstrapTenant(prisma, {
      schoolName: body.schoolName,
      schoolCode: body.schoolCode,
      address: body.address,
      city: body.city,
      state: body.state,
      pincode: body.pincode,
      phone: body.phone,
      email: body.email,
      branchName: body.branchName,
      branchCode: body.branchCode,
      adminEmail,
      adminPassword: body.adminPassword,
      logo: logoUrl,
    });

    // Control-plane registration is best-effort: a single-DB VPS without one
    // must still complete setup (login then runs in single-database mode).
    // The connRef is this deployment's own DATABASE_URL so directory-routed
    // logins land on the very database the wizard wrote.
    const cp = controlPlaneOf(req);
    if (cp) {
      try {
        await registerControlPlane(cp, body.schoolCode, env.DATABASE_URL, result.adminUserId, adminEmail);
      } catch (err) {
        logger.warn(`control-plane registration failed (setup still complete): ${(err as Error).message}`);
      }
    }

    logger.info(`first-run setup completed for school ${body.schoolCode}${logoUrl ? ' (logo uploaded)' : ''}`);
    res.status(201).json({
      ok: true,
      schoolId: result.schoolId,
      branchId: result.branchId,
      adminUserId: result.adminUserId,
      logoUrl,
    });
  } catch (err) {
    // Roll the stored file back if the bootstrap failed — no orphan uploads.
    if (logoUrl) await deleteLogoByUrl(logoUrl).catch(() => undefined);
    if (err instanceof LogoError) {
      problem(res, err.status, 'logo-invalid', 'Invalid Logo', err.message);
      return;
    }
    if (err instanceof BootstrapError) {
      problem(res, err.code === 'weak-password' ? 400 : 409, err.code, 'Setup Failed', err.message);
      return;
    }
    logger.error(`setup failed: ${(err as Error).message}`);
    problem(res, 500, 'setup-failed', 'Setup Failed', 'Could not complete setup. Check the service logs.');
  }
});

// ── GET /setup/school ── public school profile for the dashboard chrome.
// Name and logo are not sensitive (they are on every letterhead the school
// sends out); keeping this public lets the sidebar/topbar render branding on
// any authenticated page without a second gated round-trip.
setupRouter.get('/school', async (_req: Request, res: Response) => {
  try {
    const school = await prismaOf(_req).school.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { name: true, code: true, logo: true },
    });
    if (!school) {
      problem(res, 404, 'no-school', 'Not Set Up', 'No school has been created yet.');
      return;
    }
    res.json({ name: school.name, code: school.code, logoUrl: school.logo });
  } catch {
    problem(res, 503, 'unavailable', 'Not Ready', 'Database is not reachable.');
  }
});

// ── GET /setup/logo/:file ── public logo serving.
// The stored name is server-generated (`logo_<ts>_<hex>.<ext>`), so a strict
// allowlist check is enough to refuse any traversal or oddball input.
const LOGO_NAME = /^[a-zA-Z0-9_]+\.(jpg|png)$/;
setupRouter.get('/logo/:file', (req: Request, res: Response) => {
  const file = req.params.file;
  if (!LOGO_NAME.test(file)) {
    problem(res, 400, 'invalid-logo-name', 'Bad Request', 'Invalid logo filename.');
    return;
  }
  const abs = path.join(logoStorageDir(), file);
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      problem(res, 404, 'logo-not-found', 'Not Found', 'No such logo.');
    }
  });
});

// ── Gated branch management ── mounted behind requireAssertion in app.ts.
// Role gates, not requirePermission: the gateway mints assertions with roles
// but no permissions claim (see packages/auth middleware notes), so a
// permission gate would 403 every real request. Roles come from the user's
// active assignments at login — exactly the authorization this surface needs.

branchRouter.get('/', requireRole('SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'), async (req: Request, res: Response) => {
  const prisma = prismaOf(req);
  try {
    const branches = await prisma.branch.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        code: true,
        address: true,
        phone: true,
        email: true,
        isActive: true,
        createdAt: true,
        _count: { select: { students: true, staff: true, classes: true } },
      },
    });
    res.json(
      branches.map((b) => ({
        id: b.id,
        name: b.name,
        code: b.code,
        address: b.address,
        phone: b.phone,
        email: b.email,
        isActive: b.isActive,
        createdAt: b.createdAt,
        students: b._count.students,
        staff: b._count.staff,
        classes: b._count.classes,
      })),
    );
  } catch (err) {
    logger.error(`branch list failed: ${(err as Error).message}`);
    problem(res, 500, 'branch-list-failed', 'Lookup Failed', 'Could not list branches.');
  }
});

const addBranchSchema = z.object({
  name: z.string().min(2).max(80),
  code: schoolCodeSchema.max(8),
  address: z.string().max(200).optional(),
  phone: z.string().max(15).optional(),
  email: z.string().email().optional(),
  withAcademicYear: z.boolean().optional().default(true),
});

branchRouter.post('/', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  let body: z.infer<typeof addBranchSchema>;
  try {
    body = addBranchSchema.parse(req.body ?? {});
  } catch (err) {
    const flat = (err as z.ZodError).flatten();
    problem(res, 400, 'validation-error', 'Invalid Input', 'Check the highlighted fields.', flat.fieldErrors);
    return;
  }
  try {
    const result = await addBranch(prismaOf(req), body);
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof BootstrapError) {
      problem(res, 409, err.code, 'Branch Not Added', err.message);
      return;
    }
    logger.error(`branch create failed: ${(err as Error).message}`);
    problem(res, 500, 'branch-create-failed', 'Branch Not Added', 'Could not create the branch. Check the service logs.');
  }
});

const patchBranchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(15).optional(),
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
});

branchRouter.patch('/:id', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  let body: z.infer<typeof patchBranchSchema>;
  try {
    body = patchBranchSchema.parse(req.body ?? {});
  } catch (err) {
    const flat = (err as z.ZodError).flatten();
    problem(res, 400, 'validation-error', 'Invalid Input', 'Check the highlighted fields.', flat.fieldErrors);
    return;
  }
  try {
    const branch = await prismaOf(req).branch.update({
      where: { id: req.params.id },
      data: body,
      select: { id: true, name: true, code: true, isActive: true },
    });
    res.json({ ok: true, branch });
  } catch {
    problem(res, 404, 'branch-not-found', 'Not Found', 'No such branch.');
  }
});
