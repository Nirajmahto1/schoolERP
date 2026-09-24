// ──────────────────────────────────────────────
// Capture sales screenshots from the LIVE demo tenant via headless Chrome.
// Outputs PNGs to .setuprun/sales-shots/ (assembled into the sales sheet later).
// Requires: stack booted on demo DB (boot-demo.sh), web on :3000.
// Run: node .setuprun/sales-shots.cjs
// ──────────────────────────────────────────────
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9793;
const PROFILE = 'C:/Users/niraj/AppData/Local/Temp/cdp-sales-shots';
const OUT = path.join(__dirname, '..', '.setuprun', 'sales-shots');
fs.mkdirSync(OUT, { recursive: true });

function wsSend(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', onMsg); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); });
  return ws;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try { ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach((f) => { try { fs.rmSync(`${PROFILE}/${f}`, { force: true }); } catch {} }); } catch {}
  const child = execFile(CHROME, [`--remote-debugging-port=${CDP_PORT}`, '--headless=new', `--user-data-dir=${PROFILE}`, '--no-first-run', '--hide-scrollbars', 'about:blank']);
  await sleep(3000);
  try {
    const tabs = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
    });
    const page = tabs.find((t) => t.type === 'page');
    const ws = await cdp(page.webSocketDebuggerUrl);
    await wsSend(ws, 'Page.enable');
    const ev = async (expr) => (await wsSend(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

    const setViewport = async (w, h, mobile = false) => {
      await wsSend(ws, 'Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 2, mobile,
      });
    };

    const shot = async (name) => {
      const res = await wsSend(ws, 'Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'));
      console.log(`shot: ${name}.png`);
    };

    const goto = async (url, waitMs) => {
      await wsSend(ws, 'Page.navigate', { url });
      await sleep(waitMs);
    };

    // ── Desktop: login once, then tour the console ──
    await setViewport(1440, 900);
    await goto('http://localhost:3000/', 6000);
    await ev(`(() => { const e = document.querySelector('input[type=email]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(e, 'admin@demo-main.demo.edu.in'); e.dispatchEvent(new Event('input', { bubbles: true })); return !!e; })()`);
    await ev(`(() => { const p = document.querySelector('input[type=password]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(p, 'Admin@123'); p.dispatchEvent(new Event('input', { bubbles: true })); return !!p; })()`);
    await ev(`[...document.querySelectorAll('button')].find(b => /sign in/i.test(b.textContent))?.click()`);
    await sleep(6000);
    console.log('after login url:', await ev('location.pathname'));

    const shots = [
      ['01-dashboard', 'http://localhost:3000/dashboard', 9000],
      ['02-fee-payments', 'http://localhost:3000/dashboard/fee-payments', 9000],
      ['03-students', 'http://localhost:3000/dashboard/students', 9000],
      ['04-attendance', 'http://localhost:3000/dashboard/attendance', 9000],
      ['05-timetable', 'http://localhost:3000/dashboard/timetable', 9000],
      ['06-financial-reports', 'http://localhost:3000/dashboard/financial-reports', 9000],
    ];
    for (const [name, url, wait] of shots) {
      await goto(url, wait);
      await ev('window.scrollTo(0, 0)');
      await sleep(800);
      await shot(name);
    }

    // ── Mobile: parent portal in a phone-size viewport ──
    await setViewport(390, 844, true);
    await goto('http://localhost:3000/dashboard/child-overview', 9000);
    await shot('07-parent-child-overview');
    await goto('http://localhost:3000/dashboard/child-overview?tab=fees', 7000);
    await shot('08-parent-fees');

    console.log('DONE — shots in', OUT);
  } finally {
    try { child.kill(); } catch {}
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
