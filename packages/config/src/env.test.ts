import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseEnv, secretString, csvList, jwtDuration } from './env';

/**
 * `parseEnv` calls process.exit(1) on failure. We stub it to throw so the test
 * can assert the failure without killing the test runner.
 */
function expectExit(fn: () => unknown): string {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('__EXIT__');
  }) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  try {
    fn();
    throw new Error('expected parseEnv to exit, but it returned successfully');
  } catch (err) {
    expect((err as Error).message).toBe('__EXIT__');
    const output = stderr.mock.calls.map((c) => String(c[0])).join('');
    return output;
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
  }
}

const GOOD_SECRET = 'K7fQ2xLmR9vTnA4pW6yZbC8dE3gH5jS1uV0oI7kM2nB4';

describe('secretString', () => {
  it('accepts a sufficiently long random secret', () => {
    expect(secretString(32).parse(GOOD_SECRET)).toBe(GOOD_SECRET);
  });

  it('rejects a secret that is too short', () => {
    expect(secretString(32).safeParse('short').success).toBe(false);
  });

  // These are the exact literals that were hardcoded as `||` fallbacks in the
  // gateway and auth routes, plus the placeholders shipped in .env.example.
  it.each([
    'secret',
    'fallback-secret',
    'refresh-secret',
    'changeme',
    'your-super-secret-jwt-key-change-in-production',
    'your-refresh-secret-key',
  ])('rejects the known placeholder %j even when padded to length', (placeholder) => {
    const schema = secretString(1);
    expect(schema.safeParse(placeholder).success).toBe(false);
    expect(schema.safeParse(placeholder.toUpperCase()).success).toBe(false);
  });
});

describe('csvList', () => {
  it('splits, trims, and drops empties', () => {
    expect(csvList.parse('http://a.test, http://b.test ,')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('rejects an empty list', () => {
    expect(csvList.safeParse('  ,  ').success).toBe(false);
  });
});

describe('jwtDuration', () => {
  it.each(['15m', '24h', '30d', '60s'])('accepts %s', (v) => {
    expect(jwtDuration.parse(v)).toBe(v);
  });

  it.each(['forever', '15', 'm15', ''])('rejects %j', (v) => {
    expect(jwtDuration.safeParse(v).success).toBe(false);
  });
});

describe('parseEnv', () => {
  const schema = z.object({
    JWT_SECRET: secretString(32),
    PORT: z.coerce.number().int().default(4000),
  });

  it('returns typed config when valid', () => {
    const env = parseEnv(schema, 'test-service', {
      JWT_SECRET: GOOD_SECRET,
      PORT: '4321',
    } as NodeJS.ProcessEnv);

    expect(env.JWT_SECRET).toBe(GOOD_SECRET);
    expect(env.PORT).toBe(4321);
  });

  it('exits when a required secret is missing rather than falling back', () => {
    const output = expectExit(() =>
      parseEnv(schema, 'test-service', {} as NodeJS.ProcessEnv),
    );
    expect(output).toContain('JWT_SECRET');
    expect(output).toContain('cannot start');
  });

  it('reports every problem at once, not just the first', () => {
    const multi = z.object({
      JWT_SECRET: secretString(32),
      JWT_REFRESH_SECRET: secretString(32),
      REDIS_URL: z.string().url(),
    });
    const output = expectExit(() =>
      parseEnv(multi, 'test-service', { REDIS_URL: 'not-a-url' } as NodeJS.ProcessEnv),
    );
    expect(output).toContain('JWT_SECRET');
    expect(output).toContain('JWT_REFRESH_SECRET');
    expect(output).toContain('REDIS_URL');
  });

  it('exits when a secret is present but is a known placeholder', () => {
    const output = expectExit(() =>
      parseEnv(schema, 'test-service', {
        JWT_SECRET: 'your-super-secret-jwt-key-change-in-production',
      } as NodeJS.ProcessEnv),
    );
    expect(output).toContain('JWT_SECRET');
    expect(output).toContain('placeholder');
  });
});
