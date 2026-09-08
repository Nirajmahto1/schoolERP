// ──────────────────────────────────────────────
// Auth endpoint tests (BUILD_PLAN 0.7.3)
//
// Exercise the HTTP surface: login, refresh rotation, reuse detection, logout
// revocation, and the deactivated-user path that /auth/refresh must re-check
// on every call. Pure-token behaviour is covered at unit level in
// packages/auth/src/tokens.test.ts; these tests prove the routes wire it up.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { createIdentityApp } from '../app';
import { makeIdentityTestEnv, TEST_PASSWORD } from './test.setup';

describe('auth endpoints', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let app: Express;
  let seed: TenantSeed;

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    app = createIdentityApp({
      env: makeIdentityTestEnv(db.url, testKeypair()),
      prisma,
    });
    // Lowercase code on purpose: login lowercases the submitted email before
    // lookup, and Postgres email comparison is case-sensitive.
    seed = await seedTenant(prisma, { code: 'alpha', name: 'Alpha School' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  /** Point the seeded admin at a real bcrypt hash so login can succeed. */
  async function setAdminPassword(password: string): Promise<void> {
    await prisma.user.update({
      where: { id: seed.adminUserId },
      data: { passwordHash: await bcrypt.hash(password, 10) },
    });
  }

  async function setAdminActive(active: boolean): Promise<void> {
    await prisma.user.update({
      where: { id: seed.adminUserId },
      data: { isActive: active },
    });
  }

  const adminEmail = () => `admin@alpha.example.test`;

  it('rejects an unknown email with the same generic message as a bad password', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@nowhere.test', password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('Email or password is incorrect.');
  });

  it('rejects a wrong password for a real account', async () => {
    await setAdminPassword(TEST_PASSWORD);
    const res = await request(app)
      .post('/auth/login')
      .send({ email: adminEmail(), password: 'DefinitelyWrong!9' });

    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('Email or password is incorrect.');
  });

  it('rejects a malformed login payload without echoing which field failed', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('email');
  });

  it('logs in a valid user and issues a 15-minute access token', async () => {
    await setAdminPassword(TEST_PASSWORD);
    const res = await request(app)
      .post('/auth/login')
      .send({ email: adminEmail(), password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.id).toBe(seed.adminUserId);
    expect(res.body.user.roles).toEqual(['BRANCH_ADMIN']);
  });

  it('rejects login for a deactivated user', async () => {
    await setAdminPassword(TEST_PASSWORD);
    await setAdminActive(false);
    try {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: adminEmail(), password: TEST_PASSWORD });

      expect(res.status).toBe(401);
    } finally {
      await setAdminActive(true);
    }
  });

  it('rotates the refresh token and burns the old one', async () => {
    await setAdminPassword(TEST_PASSWORD);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: adminEmail(), password: TEST_PASSWORD });
    const firstRefresh = login.body.refreshToken;

    const rotated = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: firstRefresh });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(firstRefresh);

    // Replaying the rotated-away token is detected and the family dies.
    const replay = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: firstRefresh });
    expect(replay.status).toBe(401);
  });

  it('refuses to refresh a deactivated user (roles re-read from DB)', async () => {
    await setAdminPassword(TEST_PASSWORD);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: adminEmail(), password: TEST_PASSWORD });

    await setAdminActive(false);
    try {
      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: login.body.refreshToken });
      expect(res.status).toBe(401);
    } finally {
      await setAdminActive(true);
    }
  });

  it('logout revokes the refresh family and is idempotent', async () => {
    await setAdminPassword(TEST_PASSWORD);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: adminEmail(), password: TEST_PASSWORD });

    const logout = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ refreshToken: login.body.refreshToken });
    expect(logout.status).toBe(204);

    // The refresh token is dead after logout.
    const refresh = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(refresh.status).toBe(401);

    // Logout must not disclose whether the tokens were valid.
    const again = await request(app).post('/auth/logout').send({});
    expect(again.status).toBe(204);
  });

  it('requires a refresh token body', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
  });
});