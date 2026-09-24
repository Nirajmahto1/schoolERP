// ──────────────────────────────────────────────
// Assemble sales-assets/EduCore-Product-Sheet.pdf from the captured shots.
// Shots must exist in .setuprun/sales-shots/ (sales-shots.cjs + -parent.cjs).
// Run: node scripts/generate-sales-sheet.cjs
// ──────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, '.setuprun', 'sales-shots');
const ASSETS = path.join(ROOT, 'sales-assets');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const need = ['01-dashboard.png', '02-fee-payments.png', '03-students.png', '04-attendance.png', '05-timetable.png', '06-financial-reports.png', '07-parent-child-overview.png', '08-parent-my-fees.png', '09-parent-child-results.png'];
for (const f of need) {
  if (!fs.existsSync(path.join(SHOTS, f))) {
    console.error(`missing ${f} — run .setuprun/sales-shots.cjs and sales-shots-parent.cjs first`);
    process.exit(1);
  }
}
fs.mkdirSync(path.join(ASSETS, 'shots'), { recursive: true });
for (const f of need) fs.copyFileSync(path.join(SHOTS, f), path.join(ASSETS, 'shots', f));

const img = (f) => `shots/${f}`;

const card = (file, title, sub) => `
  <figure class="card">
    <img src="${img(file)}" alt="${title}"/>
    <figcaption><strong>${title}</strong><span>${sub}</span></figcaption>
  </figure>`;

const phone = (file, title) => `
  <figure class="phone">
    <div class="frame"><img src="${img(file)}" alt="${title}"/></div>
    <figcaption>${title}</figcaption>
  </figure>`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>EduCore Product Sheet</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; color: #111827; width: 210mm; }
  .page { padding: 11mm 12mm 9mm; display: flex; flex-direction: column; height: 297mm; }
  header { border-bottom: 2.5px solid #5048E5; padding-bottom: 4mm; margin-bottom: 5mm; }
  h1 { margin: 0; font-size: 21pt; letter-spacing: -0.3px; }
  h1 span { color: #5048E5; }
  header p { margin: 1.5mm 0 0; color: #6B7280; font-size: 9.5pt; }
  section h2 { font-size: 11pt; margin: 4.5mm 0 2.5mm; color: #111827; }
  section h2 em { font-style: normal; color: #5048E5; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }
  .card { margin: 0; }
  .card img { width: 100%; border: 1px solid #E5E7EB; border-radius: 2.5mm; display: block; }
  figcaption { font-size: 8.5pt; margin-top: 1.6mm; line-height: 1.35; }
  figcaption span { color: #6B7280; }
  .phones { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6mm; margin-top: 1mm; }
  .phone { margin: 0; text-align: center; }
  .frame { border: 1.4mm solid #111827; border-radius: 5.5mm; overflow: hidden; background: #111827; }
  .frame img { width: 100%; display: block; }
  .phone figcaption { font-size: 8.5pt; margin-top: 1.8mm; color: #374151; }
  footer { margin-top: auto; border-top: 1px solid #E5E7EB; padding-top: 3mm;
           display: flex; justify-content: space-between; align-items: baseline; }
  .price { font-size: 10.5pt; }
  .price b { color: #5048E5; }
  .cta { font-size: 8.5pt; color: #6B7280; text-align: right; }
</style></head>
<body><div class="page">
  <header>
    <h1>Edu<span>Core</span> — see it running</h1>
    <p>Live screenshots from the demo environment: 3 campuses &middot; 1,200 students &middot; a full year of attendance, fees and exams.</p>
  </header>

  <section>
    <h2><em>Own the numbers</em> — the owner's dashboard, consolidated across campuses</h2>
    <div class="grid">
      ${card('01-dashboard.png', 'Group dashboard', 'Enrollment, attendance % and collection per campus — no Excel compiling.')}
      ${card('06-financial-reports.png', 'Financial reports', 'Fee funnel, expense vs income, day-wise collection.')}
    </div>
  </section>

  <section>
    <h2><em>Collect every rupee</em> — cash or UPI, one receipt trail</h2>
    <div class="grid">
      ${card('02-fee-payments.png', 'Fee desk with online collection', 'Razorpay checkout, automatic reconciliation, printable receipts.')}
      ${card('03-students.png', '1,200-student records', 'Search, filter, class-wise views across all branches.')}
    </div>
  </section>

  <section>
    <h2><em>Run the day</em> — 30-second attendance, clash-free timetables</h2>
    <div class="grid">
      ${card('04-attendance.png', 'Attendance', 'Mark in seconds; absences push to parents instantly.')}
      ${card('05-timetable.png', 'Timetable builder', 'Drag-and-drop with live clash detection (teacher double-booking caught).')}
    </div>
  </section>

  <section>
    <h2><em>In every parent's pocket</em> — the mobile app</h2>
    <div class="phones">
      ${phone('07-parent-child-overview.png', 'Child overview: attendance, dues, results')}
      ${phone('08-parent-my-fees.png', 'Fees: pay online, receipt in-app')}
      ${phone('09-parent-child-results.png', 'Results: published report cards')}
    </div>
  </section>

  <footer>
    <div class="price">From <b>&#8377;150 per student / year</b> &middot; onboarding includes data import + staff training</div>
    <div class="cta">Full details in the one-pager &middot; book a 20-min live demo &middot; 20 minutes, your data shape</div>
  </footer>
</div></body></html>`;

const htmlPath = path.join(ASSETS, 'PRODUCT-SHEET.html');
fs.writeFileSync(htmlPath, html);
console.log(`wrote ${htmlPath}`);

const pdfPath = path.join(ASSETS, 'EduCore-Product-Sheet.pdf');
execFileSync(CHROME, [
  '--headless', '--disable-gpu', '--no-pdf-header-footer',
  `--print-to-pdf=${pdfPath}`,
  `file:///${htmlPath.replace(/\\/g, '/')}`,
], { stdio: 'ignore' });
const size = fs.statSync(pdfPath).size;
console.log(`wrote ${pdfPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
