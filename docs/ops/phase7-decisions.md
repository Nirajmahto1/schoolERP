# Phase 7 decisions

Three questions Phase 7 left open, and the answer each one got. Written down
because all three are the kind of decision that gets silently reversed six
months later by someone who never saw the reasoning.

---

## 1. MongoDB: removed (BUILD_PLAN §7.3)

> *"It's in `docker-compose` and `.env` for 'logs' but nothing uses it. Either
> give it a real job (audit/event stream, notification logs) or delete it. An
> unused datastore is a security surface, a backup obligation, and a line item."*

**Decision: delete it.** Verified before removing — no application code, no
`.ts`/`.py`/`.go` file, no package manifest referenced Mongo; the only hits in
the repo were its own compose service, its own `.env` keys, and the plan.

Its two candidate jobs were already being done in Postgres, next to the data
they describe:

| Candidate job | Where it actually lives |
|---|---|
| Audit / event stream | `audit_logs` (append-only, written by the services that mutate) |
| Notification logs | `notification_logs` + `notifications` (Phase 5, per-recipient and per-provider) |

Postgres is the right home for both: one backup, one restore drill (GATE 1,
`docs/ops/restore-drill-log.md`), one consistency model, and a log row that can
be joined to the tenant data it refers to. A second datastore buys nothing here
and costs a deployment, a credential set, and a backup path.

**What changed:** the `mongodb` service and its volume are gone from
`docker/docker-compose.yml` and `docker/docker-compose.dev.yml`, and
`MONGODB_URI` is gone from `.env.example`. If you have a stale
`mongodb_data` volume on your machine, `docker volume rm` it — nothing in this
repo references it.

---

## 2. At-risk detection lives in analytics-service, not ai-service (§7.2)

The plan puts at-risk under **ai-service**. It is implemented in
**analytics-service**, deliberately, and this is the reasoning so the next
person doesn't "fix" it by moving it.

The plan also says: *"Ship it as a ranked list with reasons, never a black-box
score."* The shipped model is **pure statistics over data the analytics service
already reads** — attendance rate, exam averages, fee arrears, each compared
against a published threshold. There is no trained weight anywhere:

- `apps/analytics-service/scoring.py` is the single definition of the rules —
  the live ranked list and the held-out validation both score through it.
- The reasons a principal reads ("attendance 58% (below 60%, 9 absences in 30
  days)") are produced by that same function.
- Validation is a temporal hold-out over real history, not a fit
  (`apps/analytics-service/validation.py`, evidence in
  `docs/ops/gate-7-evidence.md`).

So it needs a **read replica of the tenant database** and nothing else —
exactly what analytics-service already is. Putting it in ai-service would mean
shipping tenant PII to a second service and a second database credential for
zero modelling benefit.

**When to move it:** the moment the model stops being explainable — a learned
score, an OCR-derived feature, a document model. At that point it belongs in
ai-service with the rest of the ML surface, and it should arrive with the same
validation harness (repointed at the learned model) before anyone sees a
number.

Not shipped from §7.2, and deliberately so: OCR, timetable suggestions,
lead scoring, natural-language query. Each needs data this deployment does not
have yet, and the plan's own warning applies — *"AI on invented data is a demo
that dies in the first pilot."*

---

## 3. Scheduled reports: analytics renders, communication-service sends

A scheduled report has two halves, and the split matters:

| Concern | Owner |
|---|---|
| Render the report (XLSX/PDF), snapshot the bytes, mint the download token | analytics-service (`reports.py`, `pdf.py`) |
| Address, queue, retry, fall back between providers, respect quiet hours and unsubscribe | communication-service (`/dispatch`) |
| Provider APIs (WhatsApp BSP, DLT SMS, FCM, email) | communication-service's client modules |

analytics-service therefore **never talks to a provider**. Its `delivery.py`
makes one authenticated POST to communication-service and records the outcome.
Two consequences worth keeping:

- The **snapshot is the product**: `report_deliveries.artifact` holds the exact
  bytes that were sent, so the number a principal was emailed is the number they
  open a week later even though the school kept collecting fees meanwhile.
- **The download link's token is the credential.** It is 32 bytes of entropy,
  stored only as a SHA-256 hash, bound to one artifact, expiring in 14 days, and
  counted on each download. That is why the gateway keeps
  `/api/v1/analytics/reports/download/*` public — the reader clicked a link in
  an email and has no session.

**A missed sweep delays a report; it cannot drop or duplicate one.** The
schedule's `nextRunAt` only advances when a run completes, and every run writes
a delivery row whether it succeeded or failed. Failures are visible on the
deliveries list with the reason, and there is no retry storm — the next run
renders fresh numbers anyway.

**Staff-only delivery.** Reports go to staff, so the dispatcher was taught
`staffOnly` rather than the alternative (mailing a principal's fee-arrears
report to all 400 guardians, which is what the default audience did). A
staff-only dispatch resolves recipients from **user role assignments**, not the
Staff (HR) table — a branch admin usually has no HR record, and keying the
audience off `staff` silently reached nobody.
