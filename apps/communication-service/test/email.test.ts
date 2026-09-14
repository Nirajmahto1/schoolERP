// ──────────────────────────────────────────────
// Email provider tests (BUILD_PLAN 5.3)
//
// Postmark is asserted at the wire level (headers, payload, MessageID back).
// SES's SigV4 signature is verified the hard way: recompute the expected
// signature from the stubbed clock and canonical request and compare it to
// the Authorization header the client actually sent — a real crypto check,
// not a mock of a mock.
// ──────────────────────────────────────────────

import { createHash, createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { EmailClient } from '../src/email';
import type { FetchLike } from '../src/email';

function stubFetch(reply: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  return { calls, fn };
}

describe('EmailClient — Postmark', () => {
  it('posts From/To/Subject/HtmlBody with the server token and returns MessageID', async () => {
    const { calls, fn } = stubFetch({ status: 200, body: { MessageID: 'pm-1234-5678', ErrorCode: 0 } });
    const client = new EmailClient(
      { provider: 'postmark', fromAddress: 'school@parentlink.in', fromName: 'Vidya Public School', serverToken: 'tok-1' },
      fn,
    );

    const res = await client.send('parent@example.com', 'Fee receipt', '<p>Receipt R-12</p>', 'Receipt R-12');

    expect(res.ok).toBe(true);
    expect(res.providerMessageId).toBe('pm-1234-5678');
    const call = calls[0];
    expect(call.url).toBe('https://api.postmarkapp.com/email');
    expect(call.init?.headers?.['X-Postmark-Server-Token']).toBe('tok-1');
    expect(call.init?.headers?.Accept).toBe('application/json');
    const body = JSON.parse(call.init!.body!);
    expect(body.From).toBe('Vidya Public School <school@parentlink.in>');
    expect(body.To).toBe('parent@example.com');
    expect(body.Subject).toBe('Fee receipt');
    expect(body.HtmlBody).toContain('Receipt R-12');
    expect(body.TextBody).toBe('Receipt R-12');
    expect(body.MessageStream).toBe('outbound');
  });

  it('maps Postmark error codes to a failed result', async () => {
    const { fn } = stubFetch({ status: 422, body: { ErrorCode: 406, Message: 'Inactive recipient' } });
    const client = new EmailClient({ provider: 'postmark', fromAddress: 's@p.in', serverToken: 'tok' }, fn);

    const res = await client.send('parent@example.com', 'x', '<p>y</p>');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('Inactive recipient');
  });
});

describe('EmailClient — AWS SES (SigV4)', () => {
  // Pinned clock so the signature is reproducible.
  const CLOCK = new Date('2026-09-14T06:00:00.000Z');
  const CONFIG = {
    provider: 'ses' as const,
    fromAddress: 'school@parentlink.in',
    fromName: 'Vidya Public School',
    region: 'ap-south-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };

  it('sends a SigV4-signed SendEmail whose signature recomputes exactly', async () => {
    const { calls, fn } = stubFetch({ status: 200, body: { MessageId: 'ses-msg-0001' } });
    const client = new EmailClient(CONFIG, fn, () => CLOCK);

    const res = await client.send('parent@example.com', 'Exam schedule', '<p>Exams start Monday</p>', 'Exams start Monday');

    expect(res.ok).toBe(true);
    expect(res.providerMessageId).toBe('ses-msg-0001');
    const call = calls[0];
    expect(call.url).toBe('https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails');
    expect(call.init?.headers?.['X-Amz-Target']).toBe('SESv2.SendEmail');
    expect(call.init?.headers?.['X-Amz-Date']).toBe('20260914T060000Z');

    // Recompute SigV4 independently and compare with the sent Authorization.
    const body = call.init!.body!;
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const canonicalHeaders =
      `content-type:application/x-amz-json-1.0\n` +
      `host:email.ap-south-1.amazonaws.com\n` +
      `x-amz-date:20260914T060000Z\n` +
      `x-amz-target:SESv2.SendEmail\n`;
    const canonicalRequest = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\ncontent-type;host;x-amz-date;x-amz-target\n${payloadHash}`;
    const scope = '20260914/ap-south-1/ses/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', '20260914T060000Z', scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const kDate = createHmac('sha256', `AWS4${CONFIG.secretAccessKey}`).update('20260914').digest();
    const kRegion = createHmac('sha256', kDate).update('ap-south-1').digest();
    const kService = createHmac('sha256', kRegion).update('ses').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const auth = call.init!.headers!.Authorization;
    expect(auth).toContain(`Credential=AKIDEXAMPLE/${scope}`);
    expect(auth).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-target');
    expect(auth).toContain(`Signature=${expected}`);

    // And the payload is the SESv2 shape with the display-name From.
    const msg = JSON.parse(body);
    expect(msg.FromEmailAddress).toBe('Vidya Public School <school@parentlink.in>');
    expect(msg.Destination.ToAddresses).toEqual(['parent@example.com']);
    expect(msg.Content.Simple.Subject.Data).toBe('Exam schedule');
  });

  it('maps SES error payloads to a failed result', async () => {
    const { fn } = stubFetch({ status: 403, body: { __type: 'AccessDeniedException', message: 'User is not authorized' } });
    const client = new EmailClient(CONFIG, fn, () => CLOCK);

    const res = await client.send('parent@example.com', 'x', '<p>y</p>');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('User is not authorized');
  });
});

describe('EmailClient — misconfiguration', () => {
  it('refuses both providers set at once (double-send ambiguity)', () => {
    expect(() =>
      EmailClient.validate({
        region: 'ap-south-1',
        accessKeyId: 'a',
        secretAccessKey: 'b',
        serverToken: 'tok',
      }),
    ).toThrow(/only one email provider/i);
  });

  it('accepts exactly one provider', () => {
    expect(() => EmailClient.validate({ serverToken: 'tok' })).not.toThrow();
    expect(() => EmailClient.validate({ region: 'r', accessKeyId: 'a', secretAccessKey: 'b' })).not.toThrow();
    expect(() => EmailClient.validate({})).not.toThrow(); // none configured = fine
  });
});
