# Parent-App Adoption Campaign (§13.3.5) & Pilot→Scale (§14)

> "This is where pilots visibly succeed or fail. Aim for >70% of parents
> installed within 30 days, **and measure it.**" The measurement now exists:
> `GET /api/v1/analytics/parent-app-adoption` (per branch, family-level).

## The campaign (30 days, per school)

### Week 0 — before rollout
- Principal announces it in assembly — the app arrives top-down, from the
  school, not from a vendor
- Class teachers get the one-line script: *"The school's app — your child's
  attendance, fees, results and messages, in your phone"*
- WhatsApp broadcast scheduled per class group; poster with QR at the gate

### Week 1 — install drive
- WhatsApp broadcast (per class, from the class teacher — not one school-wide
  blast): download link + their ward's admission number
- Front desk helps walk-in parents install; 2 minutes each
- Push #1 goes out to all installed devices (a welcome + the first fee
  receipt). Every parent who receives it becomes proof to the others.

### Week 2–3 — the laggards
- Dashboard: adoption % per class. **Call the class, not the parent** — the
  teacher whose class is at 40% tells you why in one conversation
- Typical blockers: wrong phone number in records (fix at the source — it
  also fixes absences/fee reminders), shared family phone (one guardian is
  enough), iPhone vs Android confusion (send the right store link)

### Week 4 — close
- Second broadcast with the adoption percentage: *"78% of our parents are
  already connected"*
- Assembly mention + class-level prizes cost nothing and work
- Report final number to the principal; that number is the pilot's §14
  success criterion

## Measuring it
- `analytics/parent-app-adoption`: families (guardians of enrolled students
  with `receivesComms`) vs adopted (guardian has an active FCM device
  registration — the closest proxy for "installed and opened")
- Surfaces in the analytics dashboard; review weekly during rollout, monthly
  after

## §14 — Pilot to scale (the operating plan)

1. **Pilot: 1–2 friendly schools** — one single-branch, one multi-branch;
   free or discounted, signed as a pilot with feedback obligations
   (PILOT-AGREEMENT-SKELETON.md). Visit in person; watch the front-office
   clerk. One morning beats a month of planning.
2. **Instrument everything** (usage, time-on-task, ticket themes, adoption)
   and fix the top 5 friction points **before selling**.
3. **First paying customers: target 5.** This is where you learn whether
   onboarding is repeatable — the checklist is the repeatable part.
4. **Then 25.** Revisit honestly, with data: PgBouncer headroom, migration
   fan-out time, support load, and whether 12 services helps or taxes a
   two-person operation.
5. **Hire when support eats >40% of your week** — first hire is
   onboarding/support, not a developer.
