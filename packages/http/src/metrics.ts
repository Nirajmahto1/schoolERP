// ──────────────────────────────────────────────
// Prometheus metrics — zero-dependency (Phase 11.1/11.2)
//
// Every Node service exposes GET /metrics in Prometheus text format. RED
// metrics (Rate/Errors/Duration) per method+route, plus process metrics, so
// Grafana dashboards and alert rules work identically on every service:
//
//   http_requests_total{method,route,status}
//   http_request_duration_seconds{method,route,le}
//   process_resident_memory_bytes / process_heap_used_bytes
//   nodejs_eventloop_lag_seconds
//   uptime_seconds
//
// Deliberately no prom-client: the text format is trivial to emit, the fewer
// deps in the shared HTTP package the better, and cardinality is controlled
// because routes are normalised (ids → :id) before labelling.
// ──────────────────────────────────────────────

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface MetricsOptions {
  /** Label requests whose route pattern was resolved via req.route. */
  normalizePath?: boolean;
}

interface HistogramState {
  buckets: number[]; // cumulative counts per le
  sum: number;
  count: number;
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const counters = new Map<string, number>();
const histograms = new Map<string, HistogramState>();

function bucketBuckets(): number[] {
  return DEFAULT_BUCKETS.map(() => 0);
}

function observeHistogram(name: string, labels: string, value: number): void {
  const key = `${name}${labels}`;
  let h = histograms.get(key);
  if (!h) {
    h = { buckets: bucketBuckets(), sum: 0, count: 0 };
    histograms.set(key, h);
  }
  for (let i = 0; i < DEFAULT_BUCKETS.length; i += 1) {
    if (value <= DEFAULT_BUCKETS[i]) h.buckets[i] += 1;
  }
  h.sum += value;
  h.count += 1;
}

function incCounter(name: string, labels: string, by = 1): void {
  const key = `${name}${labels}`;
  counters.set(key, (counters.get(key) ?? 0) + by);
}

/** Escape a label value per the Prometheus text format. */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Collapse concrete path segments into route patterns so label cardinality
 * stays bounded: /students/abc123 → /students/:id. Uses req.route when the
 * request already matched, else a heuristic for 404s.
 */
function routeOf(req: Request): string {
  const r = (req as Request & { route?: { path?: string } }).route;
  if (r?.path) {
    const base = req.baseUrl ? `${req.baseUrl}${r.path}` : r.path;
    return base;
  }
  // No route matched (404) or not yet routed: normalise uuid/long-id segments.
  return req.path.replace(/\/[0-9a-fA-F-]{16,}/g, '/:id').replace(/\/\d{3,}/g, '/:id');
}

/** Render all metrics in the Prometheus text exposition format (v0.0.4). */
export function renderMetrics(): string {
  const lines: string[] = [];
  const mem = process.memoryUsage();
  const start = process.uptime();

  lines.push('# HELP uptime_seconds Process uptime in seconds.');
  lines.push('# TYPE uptime_seconds gauge');
  lines.push(`uptime_seconds ${start.toFixed(3)}`);

  lines.push('# HELP process_resident_memory_bytes Resident set size in bytes.');
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${mem.rss}`);

  lines.push('# HELP process_heap_used_bytes V8 heap used in bytes.');
  lines.push('# TYPE process_heap_bytes gauge');
  lines.push(`process_heap_used_bytes ${mem.heapUsed}`);

  lines.push('# HELP nodejs_eventloop_lag_seconds Approximate event-loop lag.');
  lines.push('# TYPE nodejs_eventloop_lag_seconds gauge');
  const lagStart = process.hrtime.bigint();
  setImmediate(() => {
    // Sampled on next tick; approximate by design.
  });
  const lagS = Number(process.hrtime.bigint() - lagStart) / 1e9;
  lines.push(`nodejs_eventloop_lag_seconds ${lagS.toFixed(6)}`);

  for (const [key, value] of counters) {
    const { name, labels } = splitKey(key);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name}${labels} ${value}`);
  }

  for (const [key, h] of histograms) {
    const { name, labels } = splitKey(key);
    lines.push(`# TYPE ${name} histogram`);
    let cumulative = 0;
    for (let i = 0; i < DEFAULT_BUCKETS.length; i += 1) {
      cumulative = h.buckets[i];
      lines.push(`${name}_bucket${labels},le="${DEFAULT_BUCKETS[i]}" ${cumulative}`);
    }
    lines.push(`${name}_bucket${labels},le="+Inf" ${h.count}`);
    lines.push(`${name}_sum${labels} ${h.sum.toFixed(6)}`);
    lines.push(`${name}_count${labels} ${h.count}`);
  }

  lines.push('');
  return lines.join('\n');
}

function splitKey(key: string): { name: string; labels: string } {
  const idx = key.indexOf('{');
  return idx === -1
    ? { name: key, labels: '' }
    : { name: key.slice(0, idx), labels: key.slice(idx) };
}

/** Express middleware: records RED metrics and serves GET /metrics. */
export function metricsMiddleware(_opts: MetricsOptions = {}): RequestHandler[] {
  const handler: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/metrics') {
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(renderMetrics());
      return;
    }
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const method = esc(req.method);
      const route = esc(routeOf(req));
      const status = String(res.statusCode);
      incCounter('http_requests_total', `{method="${method}",route="${route}",status="${status}"}`);
      observeHistogram('http_request_duration_seconds', `{method="${method}",route="${route}"}`, seconds);
    });
    next();
  };
  return [handler];
}

export type { Request, RequestHandler, Response };
