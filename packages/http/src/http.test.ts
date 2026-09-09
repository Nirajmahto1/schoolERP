// ──────────────────────────────────────────────
// @school-erp/http tests — envelope, request id, health
// ──────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  HttpProblemError,
  healthRoutes,
  prismaPing,
  problemNotFoundThenErrorHandler,
  requestId,
} from './index';

describe('request id + problem envelope', () => {
  it('issues an x-request-id and echoes it in problem bodies', async () => {
    const app = express();
    app.use(requestId());
    app.get('/boom', () => {
      throw new HttpProblemError(409, 'conflict', 'Conflict', 'Slug already reserved.');
    });
    const [notFound, errorHandler] = problemNotFoundThenErrorHandler();
    app.use(notFound);
    app.use(errorHandler);

    const res = await request(app).get('/boom');
    expect(res.status).toBe(409);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.type).toBe('conflict');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('honours an incoming x-request-id from the gateway', async () => {
    const app = express();
    app.use(requestId());
    app.get('/x', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/x').set('x-request-id', 'gw-abc-123');
    expect(res.headers['x-request-id']).toBe('gw-abc-123');
  });

  it('formats unmatched routes as problem+json 404s', async () => {
    const app = express();
    app.use(requestId());
    const [notFound, errorHandler] = problemNotFoundThenErrorHandler();
    app.use(notFound);
    app.use(errorHandler);

    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('not-found');
    expect(res.body.title).toBe('Not Found');
  });

  it('hides 500 details in production but logs them', async () => {
    const logs: string[] = [];
    const app = express();
    app.use(requestId());
    app.get('/boom', () => {
      throw new Error('stack trace with secrets');
    });
    const [notFound, errorHandler] = problemNotFoundThenErrorHandler((m) => logs.push(m));
    app.use(notFound);
    app.use(errorHandler);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body.detail).toBe('An unexpected error occurred.');
      expect(logs.join('\n')).toContain('stack trace with secrets');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('health routes', () => {
  it('reports ready when every dependency check passes', async () => {
    const app = express();
    const { register } = healthRoutes([
      { name: 'db', run: async () => undefined },
      { name: 'redis', run: async () => undefined },
    ]);
    register(app);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('returns 503 naming the failing dependency', async () => {
    const app = express();
    const { register } = healthRoutes([
      { name: 'db', run: async () => undefined },
      { name: 'cache', run: async () => { throw new Error('down'); } },
    ]);
    register(app);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.detail).toContain('cache');
  });

  it('prismaPing produces a usable readiness check', async () => {
    const app = express();
    const fake = { $queryRaw: async () => [{ ok: 1n }] };
    const { register } = healthRoutes([prismaPing(fake)]);
    register(app);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
  });
});
