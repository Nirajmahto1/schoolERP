// ──────────────────────────────────────────────
// Parent-portal sales shots: mobile viewport, logged in as the demo parent.
// Run: node .setuprun/sales-shots-parent.cjs
// ──────────────────────────────────────────────
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9795;
const PROFILE = 'C:/Users/niraj/AppData/Local/Temp/cdp-sales-parent';
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

    await wsSend(ws, 'Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const shot = async (name) => {
      const res = await wsSend(ws, 'Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'));
      console.log(`shot: ${name}.png`);
    };

    await wsSend(ws, 'Page.navigate', { url: 'http://localhost:3000/' });
    await sleep(6000);
    await ev(`(() => { const e = document.querySelector('input[type=email]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(e, 'parent1@demo-main.demo.edu.in'); e.dispatchEvent(new Event('input', { bubbles: true })); return !!e; })()`);
    await ev(`(() => { const p = document.querySelector('input[type=password]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(p, 'Admin@123'); p.dispatchEvent(new Event('input', { bubbles: true })); return !!p; })()`);
    await ev(`[...document.querySelectorAll('button')].find(b => /sign in/i.test(b.textContent))?.click()`);
    await sleep(6000);
    console.log('after login url:', await ev('location.pathname'));

    for (const [name, url, wait] of [
      ['07-parent-child-overview', 'http://localhost:3000/dashboard/child-overview', 9000],
      ['08-parent-my-fees', 'http://localhost:3000/dashboard/my-fees', 9000],
      ['09-parent-child-results', 'http://localhost:3000/dashboard/child-results', 9000],
    ]) {
      await wsSend(ws, 'Page.navigate', { url });
      await sleep(wait);
      await ev('window.scrollTo(0, 0)');
      await sleep(800);
      await shot(name);
      console.log('  text sample:', (await ev('document.body.innerText.replace(/\\s+/g," ").slice(0,160)')));
    }
    console.log('DONE — parent shots in', OUT);
  } finally {
    try { child.kill(); } catch {}
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
