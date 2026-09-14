// ──────────────────────────────────────────────
// Provider client tests (BUILD_PLAN 5.1 / 5.2)
//
// Both clients take an injected fetch, so these run with zero network: the
// stub asserts the exact wire shape (URL, auth header, payload) that Meta's
// Cloud API and the DLT aggregators expect, and the error paths prove the
// adapter fails closed rather than silently dropping a message.
// ──────────────────────────────────────────────

import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { WhatsAppClient, parseDeliveryStatuses } from '../src/whatsapp';
import { SmsClient } from '../src/sms';
import type { FetchLike } from '../src/whatsapp';

/** A fetch stub that records the call and replies with a canned response. */
function stubFetch(reply: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  return { calls, fn };
}

describe('WhatsAppClient (Meta Cloud API)', () => {
  it('sends a template to the messages endpoint with Bearer auth', async () => {
    const { calls, fn } = stubFetch({ status: 200, body: { messages: [{ id: 'wamid.TEST123' }] } });
    const client = new WhatsAppClient({ token: 'tok', phoneNumberId: 'PNID' }, fn);

    const res = await client.sendTemplate('919000000001', 'fee_receipt', 'en', ['Ravi', '1200']);

    expect(res.ok).toBe(true);
    expect(res.providerMessageId).toBe('wamid.TEST123');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/PNID/messages');
    expect(calls[0].init?.headers?.Authorization).toBe('Bearer tok');
    const body = JSON.parse(calls[0].init!.body!);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('919000000001');
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('fee_receipt');
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Ravi' },
      { type: 'text', text: '1200' },
    ]);
  });

  it('omits the components array when the template has no params', async () => {
    const { calls, fn } = stubFetch({ status: 200, body: { messages: [{ id: 'wamid.X' }] } });
    const client = new WhatsAppClient({ token: 'tok', phoneNumberId: 'PNID' }, fn);

    await client.sendTemplate('919000000001', 'plain');

    const body = JSON.parse(calls[0].init!.body!);
    expect(body.template.components).toBeUndefined();
  });

  it('surfaces Meta error messages instead of throwing', async () => {
    const { fn } = stubFetch({ status: 400, body: { error: { message: '(#131030) Recipient not in allowed list' } } });
    const client = new WhatsAppClient({ token: 'tok', phoneNumberId: 'PNID' }, fn);

    const res = await client.sendText('919000000001', 'hello');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('131030');
  });

  it('verifies webhook HMAC signatures (sha256= prefixed, timing-safe)', () => {
    const secret = 'meta-app-secret';
    const raw = Buffer.from(JSON.stringify({ entry: [] }));
    const good = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

    expect(WhatsAppClient.verifySignature(raw, good, secret)).toBe(true);
    expect(WhatsAppClient.verifySignature(raw, 'sha256=' + '0'.repeat(64), secret)).toBe(false);
    expect(WhatsAppClient.verifySignature(raw, good, 'wrong-secret')).toBe(false);
    expect(WhatsAppClient.verifySignature(raw, undefined, secret)).toBe(false);
    expect(WhatsAppClient.verifySignature(raw, 'md5=deadbeef', secret)).toBe(false);
  });
});

describe('parseDeliveryStatuses (Meta webhook payload)', () => {
  it('maps Meta statuses onto NotificationLog statuses', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.A', status: 'delivered', timestamp: '1757800000' },
                  { id: 'wamid.B', status: 'read' },
                  { id: 'wamid.C', status: 'failed', errors: [{ title: 'Recipient not reachable' }] },
                ],
              },
            },
          ],
        },
      ],
    };
    const out = parseDeliveryStatuses(body);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ providerMessageId: 'wamid.A', status: 'DELIVERED' });
    expect(out[0].timestamp).toBeInstanceOf(Date);
    expect(out[1].status).toBe('READ');
    expect(out[2]).toMatchObject({ providerMessageId: 'wamid.C', status: 'FAILED', error: 'Recipient not reachable' });
  });

  it('treats unknown statuses as FAILED (never silently drops)', () => {
    const out = parseDeliveryStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.Z', status: 'something-new' }] } }] }] });
    expect(out[0].status).toBe('FAILED');
  });

  it('returns an empty list for messages (not statuses) payloads', () => {
    // Inbound parent replies ride value.messages — not delivery statuses.
    expect(parseDeliveryStatuses({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.IN' }] } }] }] })).toEqual([]);
  });
});

describe('SmsClient (DLT aggregator)', () => {
  it('refuses to send without a DLT template id (TRAI fail-closed)', async () => {
    const { calls, fn } = stubFetch({ status: 200, body: { request_id: 'never' } });
    const client = new SmsClient({ apiBase: 'https://api.example.test', apiKey: 'k', senderHeader: 'DPSNOT' }, fn);

    const res = await client.send('919000000001', 'Fee due 1200', '');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('DLT template id');
    expect(calls).toHaveLength(0); // never touched the wire
  });

  it('posts sender, route, numbers, template id to the aggregator', async () => {
    const { calls, fn } = stubFetch({ status: 200, body: { type: 'success', request_id: 'req-1', cost: 0.22 } });
    const client = new SmsClient({ apiBase: 'https://api.example.test', apiKey: 'k', senderHeader: 'DPSNOT' }, fn);

    const res = await client.send('919000000001', 'Fee due Rs.1200', '1107123456789012345');

    expect(res.ok).toBe(true);
    expect(res.providerMessageId).toBe('req-1');
    expect(res.cost).toBe(0.22);
    expect(calls[0].url).toBe('https://api.example.test/sms');
    expect(calls[0].init?.headers?.authkey).toBe('k');
    const body = JSON.parse(calls[0].init!.body!);
    expect(body).toEqual({
      sender: 'DPSNOT',
      route: 'dlt',
      numbers: ['919000000001'],
      dlt_template_id: '1107123456789012345',
      message: 'Fee due Rs.1200',
    });
  });

  it('maps aggregator error payloads to a failed result', async () => {
    const { fn } = stubFetch({ status: 200, body: { type: 'error', message: 'DLT template not registered' } });
    const client = new SmsClient({ apiBase: 'https://api.example.test', apiKey: 'k', senderHeader: 'DPSNOT' }, fn);

    const res = await client.send('919000000001', 'x', '1107bad');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('DLT template not registered');
  });
});
