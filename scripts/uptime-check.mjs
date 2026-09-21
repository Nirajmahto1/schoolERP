#!/usr/bin/env node
// ──────────────────────────────────────────────
// Uptime check (Phase 11.2/11.9)
//
// Polls the gateway's /status aggregation and:
//   • exits 0 when operational, 1 otherwise (Task Scheduler / cron friendly)
//   • POSTs a short JSON alert to STATUS_WEBHOOK_URL when set and the state
//     is not operational (Slack/Discord-compatible: { text } is understood by
//     both; a generic JSON body works for anything else)
//
// Windows:  schtasks /Create /SC 5m /TN "EduCore Uptime Check" ^
//             /TR "C:\Program Files\nodejs\node.exe D:\...\scripts\uptime-check.mjs"
// Linux:    */5 * * * * node /opt/educore/scripts/uptime-check.mjs >> /var/log/uptime.log 2>&1
//
// Teardown note (Node 24 on Windows): calling process.exit() while undici's
// socket pool still holds a handle trips a libuv assertion and yields exit
// code 127 — which the scheduler would read as a failure. Every path here
// therefore sets process.exitCode and lets the event loop drain naturally.
// ──────────────────────────────────────────────

const GATEWAY = process.env.STATUS_GATEWAY_URL ?? 'http://localhost:4000/status';
const WEBHOOK = process.env.STATUS_WEBHOOK_URL ?? '';

let body = {};
let httpStatus = 0;
let unreachable = null;

try {
  const res = await fetch(GATEWAY);
  httpStatus = res.status;
  body = await res.json().catch(() => ({}));
} catch (e) {
  unreachable = e.message;
}

const stamp = new Date().toISOString();

if (unreachable) {
  console.error(`${stamp} ALERT gateway unreachable: ${unreachable}`);
  if (WEBHOOK) {
    try {
      await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `EduCore status: gateway unreachable (${unreachable})` }),
      });
    } catch (e) {
      console.error(`webhook failed: ${e.message}`);
    }
  }
  process.exitCode = 1;
} else if (httpStatus === 200 && body.status === 'operational') {
  console.log(`${stamp} OK all services up`);
  process.exitCode = 0;
} else {
  const down = (body.services ?? []).filter((s) => s.status !== 'up');
  const line = `${stamp} ALERT ${body.status ?? `http ${httpStatus}`} — down: ${
    down.map((s) => `${s.service}(${s.status})`).join(', ') || 'unknown'
  }`;
  console.log(line);
  if (WEBHOOK) {
    try {
      await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `EduCore status: ${line}` }),
      });
    } catch (e) {
      console.error(`webhook failed: ${e.message}`);
    }
  }
  process.exitCode = 1;
}
