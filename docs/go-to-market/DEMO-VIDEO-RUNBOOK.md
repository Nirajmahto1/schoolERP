# Demo Video Runbook — every role, one recording

**Pre-flight (10 min before recording)**
- Boot: `bash .setuprun/boot-demo.sh` → wait ~60 s → probe health:
  `node .setuprun/retest-journey.cjs` must end with `ALL JOURNEY CHECKS PASS ✓`
- Web: http://localhost:3000 · API/gateway: http://localhost:4000
  (phone on the hotspot LAN uses `http://192.168.137.1:4000`)
- Close Slack/mail; Chrome profile clean; record at 1920×1080.
- If anything breaks mid-take: re-seed with `npm run seed:demo` and restart
  the take.

## Credentials — tenant resolves from the email domain (no header needed)

All staff/family demo accounts share the password **`Admin@123`**
(the student probe account uses `Student@123`).

| # | Role (what to show) | Email | Password |
|---|---|---|---|
| 1 | **Group owner / Super admin** — consolidated dashboard, branch comparison | `admin@demo-main.demo.edu.in` | `Admin@123` |
| 2 | **Principal** — same console, school-level lens | `principal@demo-main.demo.edu.in` | `Admin@123` |
| 3 | **Teacher** — attendance in 30 s, timetable, leaves | `teacher0@demo-main.demo.edu.in` | `Admin@123` |
| 4 | **HOD** — department view, leave approvals | `hod@demo-main.demo.edu.in` | `Admin@123` |
| 5 | **Academic head** — exams, marks, report cards | `academic@demo-main.demo.edu.in` | `Admin@123` |
| 6 | **Accountant** — fee desk, receipts, invoices | `accounts@demo-main.demo.edu.in` | `Admin@123` |
| 7 | **Finance manager** — financial reports, Razorpay settlements | `finance@demo-main.demo.edu.in` | `Admin@123` |
| 8 | **Librarian** — library issue/return | `library@demo-main.demo.edu.in` | `Admin@123` |
| 9 | **Transport manager** — vehicles/routes | `transport@demo-main.demo.edu.in` | `Admin@123` |
| 10 | **Parent** — app/web: child overview, pay fee, receipt | `parent1@demo-main.demo.edu.in` | `Admin@123` |
| 11 | **Student** — my fees, results | `student.probe@demo-main.demo.edu.in` | `Student@123` |

Other parents: `parent2@…` – `parent99@demo-main.demo.edu.in` (same
password). Other teachers: `teacher1@…` – `teacher29@…`; the North and
South campus accounts use the domains `@demo-north.demo.edu.in` and
`@demo-south.demo.edu.in` (e.g. `teacher0@demo-north.demo.edu.in`).

## Shot list (suggested 8–10 min cut)

1. **Login screen → owner** (60 s): land on consolidated dashboard; point at
   3 campuses, attendance %, collection rate.
2. **Fee trail** (90 s): accountant `accounts@…` → fee desk → collect cash →
   receipt PDF; then finance `finance@…` → fee payments → Razorpay
   settlements tab → reconcile.
3. **Attendance → parent push** (60 s): teacher `teacher0@…` → attendance →
   mark 2 absent → save; switch to parent app/web → the push banner.
4. **Exams** (60 s): academic head `academic@…` → marks already entered →
   publish → CBSE-style report card PDF.
5. **Timetable** (45 s): teacher or HOD → timetable builder → drag a period →
   clash detected live.
6. **Every role lands somewhere** (60 s): quick-cut logins for HOD,
   librarian, transport — each shows its own home screen.
7. **Parent app close** (60 s): parent `parent1@…` on the phone — fees with
   due amount, pay via Razorpay test checkout, receipt appears; adopt rate
   shown from owner's analytics before cutting.

## Recording notes

- **Razorpay is in TEST mode** — payments simulate end-to-end; say it in the
  voiceover, it is a feature ("try it yourself with your own test keys").
- Demo school is the fictional **Sunrise Public School** (3 campuses,
  1,200 students) — say that too; it preempts "whose data is this?"
- Web console works on any role; the parent experience demos best on the
  phone (APK in `sales-assets/`), student/HOD also exist in the app.
