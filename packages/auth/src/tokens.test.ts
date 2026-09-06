import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryTokenStore } from './memory-store';
import {
  TokenError,
  issueTokenPair,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  verifyAccessToken,
  type LiveUser,
  type TokenConfig,
} from './tokens';

const config: TokenConfig = {
  accessSecret: 'a'.repeat(48),
  refreshSecret: 'b'.repeat(48),
  accessExpiresIn: '15m',
  refreshExpiresIn: '30d',
};

let store: MemoryTokenStore;
let user: LiveUser;

beforeEach(() => {
  store = new MemoryTokenStore();
  user = {
    id: 'usr_teacher',
    email: 'teacher@dps.test',
    isActive: true,
    tenantId: 'tnt_dps',
    branchId: 'brn_noida',
    roles: ['TEACHER'],
  };
});

const reload = (override?: Partial<LiveUser> | null) => async () =>
  override === null ? null : ({ ...user, ...override } as LiveUser);

describe('issue and verify', () => {
  it('issues a verifiable access token with a 15 minute TTL', async () => {
    const pair = await issueTokenPair(user, config, store);
    expect(pair.expiresIn).toBe(900);

    const claims = await verifyAccessToken(pair.accessToken, config, store);
    expect(claims.sub).toBe('usr_teacher');
    expect(claims.tenantId).toBe('tnt_dps');
    expect(claims.roles).toEqual(['TEACHER']);
    expect(claims.jti).toBeTruthy();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const pair = await issueTokenPair(user, config, store);
    await expect(
      verifyAccessToken(pair.accessToken, { ...config, accessSecret: 'c'.repeat(48) }, store),
    ).rejects.toThrow(TokenError);
  });

  it('does not store the raw refresh token', async () => {
    const pair = await issueTokenPair(user, config, store);
    const dumped = JSON.stringify([...(store as unknown as { entries: Map<string, { value: string }> })
      .entries.values()]);
    expect(dumped).not.toContain(pair.refreshToken);
  });
});

describe('refresh rotation', () => {
  it('exchanges a refresh token for a new pair', async () => {
    const first = await issueTokenPair(user, config, store);
    const second = await rotateRefreshToken(first.refreshToken, config, store, reload());

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    await expect(verifyAccessToken(second.accessToken, config, store)).resolves.toBeTruthy();
  });

  it('invalidates the old refresh token after rotation', async () => {
    const first = await issueTokenPair(user, config, store);
    await rotateRefreshToken(first.refreshToken, config, store, reload());

    await expect(
      rotateRefreshToken(first.refreshToken, config, store, reload()),
    ).rejects.toMatchObject({ reason: 'reused' });
  });

  // The stolen-token scenario: attacker replays a token the real user already
  // rotated. Correct response is to revoke the whole family, not just refuse.
  it('revokes the entire family when a rotated token is replayed', async () => {
    const first = await issueTokenPair(user, config, store);
    const second = await rotateRefreshToken(first.refreshToken, config, store, reload());
    const third = await rotateRefreshToken(second.refreshToken, config, store, reload());

    await expect(
      rotateRefreshToken(first.refreshToken, config, store, reload()),
    ).rejects.toMatchObject({ reason: 'reused' });

    // The legitimate user's newest token is dead too — they must log in again.
    await expect(
      rotateRefreshToken(third.refreshToken, config, store, reload()),
    ).rejects.toBeInstanceOf(TokenError);
    expect(store.size()).toBe(0);
  });

  it('keeps other login families alive when one is burned', async () => {
    const phone = await issueTokenPair(user, config, store);
    const laptop = await issueTokenPair(user, config, store);

    await rotateRefreshToken(phone.refreshToken, config, store, reload());
    await expect(
      rotateRefreshToken(phone.refreshToken, config, store, reload()),
    ).rejects.toMatchObject({ reason: 'reused' });

    // Laptop session is a separate family and is unaffected.
    await expect(
      rotateRefreshToken(laptop.refreshToken, config, store, reload()),
    ).resolves.toBeTruthy();
  });

  // This is the defect that let a fired teacher keep working access for 30 days.
  it('reads live user state instead of re-signing stale claims', async () => {
    const first = await issueTokenPair(user, config, store);

    const promoted = await rotateRefreshToken(
      first.refreshToken,
      config,
      store,
      reload({ roles: ['PRINCIPAL'], branchId: 'brn_gurgaon' }),
    );

    const claims = await verifyAccessToken(promoted.accessToken, config, store);
    expect(claims.roles).toEqual(['PRINCIPAL']);
    expect(claims.branchId).toBe('brn_gurgaon');
  });

  it('refuses to refresh a deactivated user and kills their sessions', async () => {
    const first = await issueTokenPair(user, config, store);

    await expect(
      rotateRefreshToken(first.refreshToken, config, store, reload({ isActive: false })),
    ).rejects.toMatchObject({ reason: 'user-inactive' });
    expect(store.size()).toBe(0);
  });

  it('refuses to refresh a deleted user', async () => {
    const first = await issueTokenPair(user, config, store);
    await expect(
      rotateRefreshToken(first.refreshToken, config, store, reload(null)),
    ).rejects.toMatchObject({ reason: 'user-missing' });
  });

  it('rejects a refresh token signed with the wrong secret', async () => {
    const pair = await issueTokenPair(user, config, store);
    await expect(
      rotateRefreshToken(pair.refreshToken, { ...config, refreshSecret: 'z'.repeat(48) }, store, reload()),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });
});

describe('revocation', () => {
  it('makes logout actually revoke the access token', async () => {
    const pair = await issueTokenPair(user, config, store);
    await expect(verifyAccessToken(pair.accessToken, config, store)).resolves.toBeTruthy();

    await revokeSession(pair.accessToken, pair.refreshToken, config, store);

    await expect(verifyAccessToken(pair.accessToken, config, store)).rejects.toMatchObject({
      reason: 'revoked',
    });
  });

  it('prevents refreshing after logout', async () => {
    const pair = await issueTokenPair(user, config, store);
    await revokeSession(pair.accessToken, pair.refreshToken, config, store);

    await expect(
      rotateRefreshToken(pair.refreshToken, config, store, reload()),
    ).rejects.toBeInstanceOf(TokenError);
  });

  it('revokes every device on password change', async () => {
    const phone = await issueTokenPair(user, config, store);
    const laptop = await issueTokenPair(user, config, store);
    const tablet = await issueTokenPair(user, config, store);

    await revokeAllSessions(user.id, store);

    for (const pair of [phone, laptop, tablet]) {
      await expect(
        rotateRefreshToken(pair.refreshToken, config, store, reload()),
      ).rejects.toBeInstanceOf(TokenError);
    }
    expect(store.size()).toBe(0);
  });

  it('tolerates a malformed token on logout without throwing', async () => {
    await expect(
      revokeSession('not-a-token', 'also-not-a-token', config, store),
    ).resolves.toBeUndefined();
  });
});
