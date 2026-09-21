// ──────────────────────────────────────────────
// Metrics + structured request-log tests (Phase 11.1)
// ──────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { jsonRequestLogger } from '../src/json-logger';
import { metricsMiddleware } from '../src/metrics';

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), lines };
  } finally {
    process.stdout.write = orig;
  }
}

describe('metrics middleware', () => {
  it('serves /metrics in Prometheus text format', async () => {
    const app = express();
    app.use(metricsMiddleware()[0]);
    app.get('/hello', (_req, res) => res.json({ ok: true }));

    await request(app).get('/hello').expect(200);
    const res = await request(app).get('/metrics').expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('http_requests_total{method="GET",route="/hello",status="200"} 1');
    expect(res.text).toContain('http_request_duration_seconds_count{method="GET",route="/hello"} 1');
    expect(res.text).toContain('uptime_seconds');
    expect(res.text).toContain('process_resident_memory_bytes');
  });

  it('normalises id-like path segments on unmatched routes to bound cardinality', async () => {
    const app = express();
    app.use(metricsMiddleware()[0]);

    await request(app).get('/students/9f8e7d6c5b4a3f2e1d0c').expect(404);
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('route="/students/:id"');
    expect(res.text).not.toContain('9f8e7d6c5b4a');
  });
});

describe('jsonRequestLogger', () => {
  it('emits one JSON line with ids, status and duration', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { id?: string }).id = 'req-123';
      (req as express.Request & { assertion?: object }).assertion = {
        tenantId: 't1', userId: 'u1', branchId: 'b1',
      };
      next();
    });
    app.use(jsonRequestLogger({ service: 'test-svc' }));
    app.get('/x', (_req, res) => res.json({}));

    const { lines } = await captureStdout(() => request(app).get('/x').expect(200));
    const entry = JSON.parse(lines.find((l) => l.includes('"request"')) ?? '{}');
    expect(entry.service).toBe('test-svc');
    expect(entry.request_id).toBe('req-123');
    expect(entry.tenant_id).toBe('t1');
    expect(entry.status).toBe(200);
    expect(typeof entry.duration_ms).toBe('number');
  });

  it('marks 5xx as error level', async () => {
    const app = express();
    app.use(jsonRequestLogger({ service: 'test-svc' }));
    app.get('/boom', () => {
      throw new Error('x');
    });

    const { lines } = await captureStdout(() =>
      request(app).get('/boom').catch(() => null),
    );
    const entry = JSON.parse(lines.find((l) => l.includes('"request"')) ?? '{}');
    expect(entry.level).toBe('error');
    expect(entry.status).toBe(500);
  });
});
