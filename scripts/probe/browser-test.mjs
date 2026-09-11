// Browser verification: fees, invoicing, staff, exams screens against live data.
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = 9333;
const API = 'http://localhost:4000/api/v1';
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'erp-chrome-'))}`,
  'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTargetWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/list`);
      const page = (await res.json()).find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error('chrome devtools not reachable');
}
const ws = new WebSocket(await getTargetWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) events.push(msg.method);
};
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(res => pending.set(mid, res));
};
const waitEvent = (method, timeoutMs = 45000) => {
  const start = Date.now();
  return new Promise((res, rej) => {
    const t = setInterval(() => {
      const i = events.indexOf(method);
      if (i >= 0) { events.splice(i, 1); clearInterval(t); res(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(t); rej(new Error('timeout: ' + method)); }
    }, 50);
  });
};
await send('Page.enable');
await send('Runtime.enable');

const loaded1 = waitEvent('Page.loadEventFired');
await send('Page.navigate', { url: 'http://localhost:3000/' });
await loaded1;
const seed = await send('Runtime.evaluate', {
  awaitPromise: true,
  expression: `(async () => {
    const r = await fetch('${API}/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo-main.demo.edu.in', password: 'Admin@123' }) });
    const j = await r.json();
    if (!r.ok) return 'LOGIN FAILED ' + r.status;
    localStorage.setItem('erp_token', j.accessToken);
    localStorage.setItem('erp_refresh_token', j.refreshToken);
    localStorage.setItem('erp_user', JSON.stringify({ id: j.user.id, name: 'Admin', email: j.user.email, roles: j.user.roles || [], role: (j.user.roles || [])[0] || 'BRANCH_ADMIN', permissions: [], branchId: j.user.branchId }));
    return 'SEEDED';
  })()`,
});
console.log('seed:', seed.result?.result?.value);
if (seed.result?.result?.value !== 'SEEDED') process.exit(1);

async function visit(path, settleMs, markers, label) {
  const ev = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: 'http://localhost:3000' + path });
  await ev;
  await sleep(settleMs);
  const dom = await send('Runtime.evaluate', { expression: 'document.body.innerText' });
  const text = dom.result?.result?.value ?? '';
  const found = markers.filter(m => text.includes(m));
  const status = found.length === markers.length ? '✅' : '⚠️';
  console.log(`${status} ${label}: ${found.length}/${markers.length} [${found.join(' | ')}]`);
  if (found.length !== markers.length) {
    console.log('   sample:', text.slice(0, 400).replace(/\n+/g, ' / '));
  }
}

await visit('/dashboard/fees', 7000, ['Fee Management', 'INV-', 'Total Collected'], 'fees');
await visit('/dashboard/invoicing', 7000, ['Invoicing', 'Generate Invoice'], 'invoicing');
await visit('/dashboard/staff', 7000, ['Staff & HR', 'Aarav', 'Teacher'], 'staff');
await visit('/dashboard/exams', 9000, ['Exams & Results', 'Term I Examination'], 'exams (examinations tab)');

ws.close();
chrome.kill();
process.exit(0);
