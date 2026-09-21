# 20-Minute Demo Script (§13.2.2)

**Before you start:** demo tenant `demo-main` seeded with 3 branches, 1,200
students, a full year of attendance (`npm run seed:demo`). **Never demo on
empty tables.** Phone charged with the parent app logged in as a real
guardian of Class 5B. Close Slack.

The arc: *one school, one morning, one rupee trail* — attendance → fee →
receipt → parent's phone. Every 5 minutes ends with something the principal
can see.

## Minutes 0–3 — Multi-branch consolidated dashboard
- Log in as the group owner. Open **Dashboard**.
- Show all three branches in the branch-comparison view: enrollment, today's
  attendance %, fee collection rate per campus.
- Say: *"Your coordinators compare campuses; your principal never has to
  compile an Excel sheet again."*

## Minutes 3–7 — Attendance in 30 seconds
- Open **Attendance** as a Class 5B teacher → "Mark all present" → flip two
  students absent → save.
- **Hand the principal YOUR PHONE**: the parent's push arrives with the
  child's name while they hold it. (This is the moment that sells.)
- Point at the office kiosk: staff check-in/out with geofence + server time.

## Minutes 7–11 — Fee collection + receipt
- Fee desk → find a student with dues → collect cash: receipt number minted,
  ledger posted.
- Then the online path: Razorpay test checkout → payment success → *the same
  receipt* in the parent app.
- Say: *"Reconciliation is the number on the receipt — one trail, cash or
  UPI."*

## Minutes 11–14 — Auto report card
- Exams → marks already entered → publish → CBSE-style report card PDF with
  grades, co-scholastics, result line.
- Open it from the **parent app** (results tab). Same document, zero teacher
  formatting work.

## Minutes 14–17 — Timetable + analytics
- Timetable builder: show the drag-and-drop grid, clash detection, the
  HOD/academic-head roles.
- Analytics: at-risk list (explain the branch-relative lens), fee funnel,
  parent-app adoption rate — *"the number that tells you if parents actually
  installed."*

## Minutes 17–20 — The parent app, on the real phone
- Attendance history calendar, fees with dues, results, class chat, school
  announcements, push notifications.
- Close with: *"Everything you saw lives in your school's own database —
  isolated, exportable, DPDP-compliant. The onboarding fee covers us
  importing this term's data and training your staff."*

**Objection one-liners**
- *"Can your staff see our data?"* → No standing access; support is
  time-boxed with a one-time code, every action attributed in YOUR audit log.
- *"We already have Excel."* → So does every school that left their old
  vendor; show the fee-funnel numbers instead of arguing.
- *"Teachers won't use it."* → Attendance takes 30 seconds; watch the demo;
  teachers get leaves + timetable in the app they already wanted.
