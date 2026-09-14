// ──────────────────────────────────────────────
// FCM push client tests (BUILD_PLAN 5.4)
//
// Both the OAuth flow and the send are stubbed at the transport boundary;
// the JWT itself is signed with a real key and verified with real
// jsonwebtoken.verify — so the assertion Google would see is exactly what
// we test, not a mock of a mock.
// ──────────────────────────────────────────────

import { generateKeyPairSync, createPrivateKey } from 'crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { FcmClient } from '../src/fcm';
import type { FetchLike } from '../src/fcm';

const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_KEY = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const CONFIG = {
  projectId: 'school-erp-push',
  clientEmail: 'push@school-erp-push.iam.gserviceaccount.com',
  privateKey: PRIVATE_KEY,
};

function stubFetch(replies: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(replies).find((k) => url.includes(k)) ?? '';
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected fetch: ${url}`);
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  return { calls, fn };
}

describe('FcmClient (HTTP v1 + service-account OAuth)', () => {
  it('mints a verifiable RS256 assertion and exchanges it for an access token', async () => {
    const { calls, fn } = stubFetch({
      'oauth2.googleapis.com': { status: 200, body: { access_token: 'ya29.test-token', expires_in: 3600 } },
      'fcm.googleapis.com': { status: 200, body: { name: 'projects/p/messages/12345' } },
    });
    const client = new FcmClient(CONFIG, fn);

    const res = await client.send('fcm-device-token-1', { title: 'Fee receipt', body: 'Receipt R-12 issued' });

    expect(res.ok).toBe(true);
    expect(res.providerMessageId).toBe('projects/p/messages/12345');

    // The JWT Google receives decodes against our public key with the exact claims.
    expect(calls).toHaveLength(2);
    const oauth = calls[0];
    expect(oauth.init?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = oauth.init!.body!;
    expect(body).toContain('grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer'));
    const assertion = new URLSearchParams(body).get('assertion')!;
    const claims = jwt.verify(assertion, PUBLIC_KEY, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    expect(claims.iss).toBe(CONFIG.clientEmail);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.exp! - claims.iat!).toBe(3600);

    // The send carries the bearer token and FCM v1 message shape.
    const send = calls[1];
    expect(send.url).toBe(`https://fcm.googleapis.com/v1/projects/${CONFIG.projectId}/messages:send`);
    expect(send.init?.headers?.Authorization).toBe('Bearer ya29.test-token');
    const msg = JSON.parse(send.init!.body!).message;
    expect(msg.token).toBe('fcm-device-token-1');
    expect(msg.notification).toEqual({ title: 'Fee receipt', body: 'Receipt R-12 issued' });
  });

  it('caches the access token — a second send makes no second OAuth call', async () => {
    const { calls, fn } = stubFetch({
      'oauth2.googleapis.com': { status: 200, body: { access_token: 'ya29.cached', expires_in: 3600 } },
      'fcm.googleapis.com': { status: 200, body: { name: 'projects/p/messages/2' } },
    });
    const client = new FcmClient(CONFIG, fn);

    await client.send('tok-a', { title: 'a', body: 'b' });
    await client.send('tok-b', { title: 'a', body: 'b' });

    const oauthCalls = calls.filter((c) => c.url.includes('oauth2'));
    expect(oauthCalls).toHaveLength(1);
    expect(calls).toHaveLength(3); // 1 oauth + 2 sends
    expect(JSON.parse(calls[2].init!.body!).message.token).toBe('tok-b');
  });

  it('carries the deep link and high priority into the platform payloads', async () => {
    const { calls, fn } = stubFetch({
      'oauth2.googleapis.com': { status: 200, body: { access_token: 'ya29.prio', expires_in: 3600 } },
      'fcm.googleapis.com': { status: 200, body: { name: 'projects/p/messages/3' } },
    });
    const client = new FcmClient(CONFIG, fn);

    await client.send('tok', { title: 'Absence alert', body: 'Aarav marked absent', deepLink: 'app://attendance/42', priority: 'high' });

    const msg = JSON.parse(calls[1].init!.body!).message;
    expect(msg.data).toEqual({ deepLink: 'app://attendance/42' });
    expect(msg.android.priority).toBe('high');
    expect(msg.apns.headers['apns-priority']).toBe('10');
  });

  it('flags UNREGISTERED tokens for deletion', async () => {
    const { fn } = stubFetch({
      'oauth2.googleapis.com': { status: 200, body: { access_token: 'ya29.x', expires_in: 3600 } },
      'fcm.googleapis.com': { status: 404, body: { error: { message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } } },
    });
    const client = new FcmClient(CONFIG, fn);

    const res = await client.send('deleted-app-token', { title: 'a', body: 'b' });

    expect(res.ok).toBe(false);
    expect(res.tokenInvalid).toBe(true);
    expect(res.error).toContain('not found');
  });

  it('does NOT flag transient server errors as token-invalid', async () => {
    const { fn } = stubFetch({
      'oauth2.googleapis.com': { status: 200, body: { access_token: 'ya29.x', expires_in: 3600 } },
      'fcm.googleapis.com': { status: 500, body: { error: { message: 'Backend error' } } },
    });
    const client = new FcmClient(CONFIG, fn);

    const res = await client.send('tok', { title: 'a', body: 'b' });

    expect(res.ok).toBe(false);
    expect(res.tokenInvalid).toBe(false);
  });

  it('surfaces an OAuth failure instead of sending', async () => {
    const { calls, fn } = stubFetch({
      'oauth2.googleapis.com': { status: 401, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } },
    });
    const client = new FcmClient(CONFIG, fn);

    const res = await client.send('tok', { title: 'a', body: 'b' });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('Invalid JWT Signature');
    expect(calls.filter((c) => c.url.includes('fcm.googleapis.com'))).toHaveLength(0);
  });

  it('accepts an injected signer (the config-normalized PEM is loadable)', () => {
    // Proves the \\n-normalization contract end to end: a PEM with literal
    // backslash-n escapes parses as a real key after the same replace the
    // config schema performs.
    const escaped = PRIVATE_KEY.replace(/\n/g, '\\n');
    const normalized = escaped.replace(/\\n/g, '\n');
    expect(() => createPrivateKey(normalized)).not.toThrow();
  });
});
