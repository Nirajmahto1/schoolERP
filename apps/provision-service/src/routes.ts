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
import bcrypt from 'bcryptjs';
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
  // Staff self-attendance geofence as a bounding box: two latitudes and two
  // longitudes (any corner order — normalized on write). All four travel
  // together; a partial box is rejected rather than half-stored.
  minLatitude: z.number().min(-90).max(90).optional(),
  maxLatitude: z.number().min(-90).max(90).optional(),
  minLongitude: z.number().min(-180).max(180).optional(),
  maxLongitude: z.number().min(-180).max(180).optional(),
  // Late-arrival cutoff: minutes past midnight (branch local, IST).
  lateAfterMinutes: z.number().int().min(0).max(1439).nullable().optional(),
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

// ── Branch admins ──
// Creating a branch provisioned its year and classes, but nobody could WORK
// in it: there was no way to attach an account, and the owner's session was
// pinned to their first branch. These routes make a branch operable:
//   GET    /branches/:id/admins  → who can manage it
//   POST   /branches/:id/admins  → attach an EXISTING user, or create a new
//                                  branch-admin account inline
//   DELETE /branches/:id/admins/:userId → remove that user's branch role
// A user attached here can switch into the branch from the topbar switcher
// (POST /auth/switch-branch honors exactly these assignments).

const branchIdParam = z.string().min(1).max(64);

const addAdminSchema = z.object({
  // Either attach an existing account…
  userId: z.string().min(1).max(64).optional(),
  // …or create a fresh branch-admin with these.
  email: z.string().email().optional(),
  password: z.string().min(10).max(128).optional(),
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().min(1).max(60).optional(),
  phone: z.string().max(15).optional(),
  roleCode: z.enum(['BRANCH_ADMIN', 'PRINCIPAL']).optional().default('BRANCH_ADMIN'),
});

branchRouter.get('/:id/admins', requireRole('SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'), async (req: Request, res: Response) => {
  if (!branchIdParam.safeParse(req.params.id).success) {
    problem(res, 400, 'validation-error', 'Invalid Input', 'A branch id is required.');
    return;
  }
  try {
    const assignments = await prismaOf(req).userRoleAssignment.findMany({
      where: { branchId: req.params.id, isActive: true, role: { code: { in: ['BRANCH_ADMIN', 'PRINCIPAL', 'SUPER_ADMIN'] } } },
      select: {
        id: true,
        role: { select: { code: true } },
        user: {
          select: {
            id: true,
            email: true,
            isActive: true,
            lastLogin: true,
            staff: { select: { firstName: true, lastName: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(
      assignments.map((a) => ({
        assignmentId: a.id,
        userId: a.user.id,
        email: a.user.email,
        name: a.user.staff ? `${a.user.staff.firstName} ${a.user.staff.lastName}`.trim() : null,
        phone: a.user.staff?.phone ?? null,
        roleCode: a.role.code,
        isActive: a.user.isActive,
        lastLogin: a.user.lastLogin,
      })),
    );
  } catch (err) {
    logger.error(`branch admins list failed: ${(err as Error).message}`);
    problem(res, 500, 'admins-list-failed', 'Lookup Failed', 'Could not list branch admins.');
  }
});

branchRouter.post('/:id/admins', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  if (!branchIdParam.safeParse(req.params.id).success) {
    problem(res, 400, 'validation-error', 'Invalid Input', 'A branch id is required.');
    return;
  }
  let body: z.infer<typeof addAdminSchema>;
  try {
    body = addAdminSchema.parse(req.body ?? {});
  } catch (err) {
    const flat = (err as z.ZodError).flatten();
    problem(res, 400, 'validation-error', 'Invalid Input', 'Provide a userId to attach, or email + password to create.', flat.fieldErrors);
    return;
  }
  if (!body.userId && !(body.email && body.password)) {
    problem(res, 400, 'validation-error', 'Invalid Input', 'Provide a userId to attach, or email + password to create.');
    return;
  }

  const prisma = prismaOf(req);
  try {
    const branch = await prisma.branch.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, code: true, schoolId: true } });
    if (!branch) {
      problem(res, 404, 'branch-not-found', 'Not Found', 'No such branch.');
      return;
    }

    const role = await prisma.role.findUnique({ where: { code: body.roleCode }, select: { id: true } });
    if (!role) {
      problem(res, 400, 'validation-error', 'Invalid Input', `Unknown role ${body.roleCode}.`);
      return;
    }

    let userId = body.userId ?? null;
    let created = false;
    if (userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true } });
      if (!user) {
        problem(res, 404, 'user-not-found', 'Not Found', 'No such user.');
        return;
      }
      if (!user.isActive) {
        problem(res, 409, 'user-inactive', 'Conflict', 'That account is deactivated.');
        return;
      }
    } else {
      const email = body.email!.trim().toLowerCase();
      const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (clash) {
        problem(res, 409, 'email-taken', 'Already Exists', 'An account with that email already exists — attach it by user id instead.');
        return;
      }
      const passwordHash = await bcrypt.hash(body.password!, 12);
      const school = await prisma.school.findUnique({ where: { id: branch.schoolId }, select: { code: true } });
      const localPart = email.split('@')[0] || 'Admin';
      const [first, ...rest] = localPart.split(/[._-]+/).filter(Boolean);
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          defaultBranchId: branch.id,
          roleAssignments: { create: { roleId: role.id, branchId: branch.id } },
        },
      });
      // Every account needs a Staff row or staff-scoped surfaces 404 on it
      // (the profile lesson from the setup wizard).
      const staffCount = await prisma.staff.count({ where: { branchId: branch.id } });
      await prisma.staff.create({
        data: {
          userId: user.id,
          employeeId: `ADM-${branch.code}-${String(staffCount + 1).padStart(3, '0')}`,
          firstName: (body.firstName ?? (first ?? 'Branch').charAt(0).toUpperCase() + (first ?? 'Branch').slice(1)).trim(),
          lastName: body.lastName ?? (rest.join(' ') || 'Admin'),
          dateOfBirth: new Date('1970-01-01'),
          gender: 'OTHER',
          designation: body.roleCode === 'PRINCIPAL' ? 'Principal' : 'Branch Admin',
          department: 'Administration',
          qualification: '—',
          joinDate: new Date(),
          salary: 0,
          address: '—',
          phone: body.phone?.trim() || '0000000000',
          branchId: branch.id,
        },
      });
      userId = user.id;
      created = true;
    }

    // Idempotent attach: re-adding an existing (userId, roleId, branchId)
    // triple reactivates a previously-removed assignment instead of erroring.
    const assignment = await prisma.userRoleAssignment.upsert({
      where: { userId_roleId_branchId: { userId: userId!, roleId: role.id, branchId: branch.id } },
      create: { userId: userId!, roleId: role.id, branchId: branch.id },
      update: { isActive: true },
      select: { id: true },
    });

    // A newly created admin lands in their branch on first login.
    if (created) {
      await prisma.user.update({ where: { id: userId! }, data: { defaultBranchId: branch.id, activeBranchId: branch.id }, select: { id: true } });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId! },
      select: { id: true, email: true, staff: { select: { firstName: true, lastName: true } } },
    });

    res.status(201).json({
      ok: true,
      assignmentId: assignment.id,
      userId,
      email: user?.email,
      name: user?.staff ? `${user.staff.firstName} ${user.staff.lastName}`.trim() : null,
      roleCode: body.roleCode,
      created,
    });
  } catch (err) {
    logger.error(`branch admin assign failed: ${(err as Error).message}`);
    problem(res, 500, 'admin-assign-failed', 'Not Assigned', 'Could not assign the branch admin. Check the service logs.');
  }
});

branchRouter.delete('/:id/admins/:userId', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  try {
    const prisma = prismaOf(req);
    // Deactivate, never delete: the assignment's audit history stays intact.
    const result = await prisma.userRoleAssignment.updateMany({
      where: {
        userId: req.params.userId,
        branchId: req.params.id,
        isActive: true,
        role: { code: { in: ['BRANCH_ADMIN', 'PRINCIPAL'] } },
      },
      data: { isActive: false },
    });
    if (result.count === 0) {
      problem(res, 404, 'assignment-not-found', 'Not Found', 'No active admin assignment for that user in this branch.');
      return;
    }
    // Drop any stale active-branch pointer so their next token resolves to a
    // branch they still hold.
    await prisma.user.updateMany({ where: { id: req.params.userId, activeBranchId: req.params.id }, data: { activeBranchId: null } });
    res.json({ ok: true, removed: result.count });
  } catch (err) {
    logger.error(`branch admin remove failed: ${(err as Error).message}`);
    problem(res, 500, 'admin-remove-failed', 'Not Removed', 'Could not remove the branch admin.');
  }
});

const patchBranchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(15).optional(),
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
  minLatitude: z.number().min(-90).max(90).nullable().optional(),
  maxLatitude: z.number().min(-90).max(90).nullable().optional(),
  minLongitude: z.number().min(-180).max(180).nullable().optional(),
  maxLongitude: z.number().min(-180).max(180).nullable().optional(),
  lateAfterMinutes: z.number().int().min(0).max(1439).nullable().optional(),
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
