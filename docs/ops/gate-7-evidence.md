# GATE 7 — evidence

> **GATE 7**
> - Branch-comparison dashboard renders for a 3-branch tenant in under 2s.
> - At-risk model validated against held-out historical data with reported
>   precision/recall.

Measured 2026-09-16 against the dev tenant (**Delhi Public School**, 3 branches,
1,200 students) with the real stack running — gateway → identity-service →
analytics-service, plus communication-service for delivery. Every number below
comes from a live request, not a fixture.

---

## 1. Branch comparison — 3 branches

Endpoint: `GET /api/v1/analytics/branch-comparison` (through the gateway as
`admin@demo-main.demo.edu.in`).

| Run | Wall time |
|---|---|
| 1 | **37 ms** |
| 2 | **71 ms** |
| 3 | **86 ms** |
| Earlier runs under parallel test load | 131 ms, 139 ms, 218 ms |

Budget is **2,000 ms**; the slowest observed call used **4.3%** of it, with a
~23× headroom on the fastest. Payload is the full three-branch comparison:

```json
[
  {"branch":"Main Campus","students":400,"staff":31,"revenue":"1260500.00","pending_fees":"2321500.00","attendance_rate_30d":"92.3"},
  {"branch":"North Campus","students":400,"staff":30,"revenue":"1260000.00","pending_fees":"2320000.00","attendance_rate_30d":"92.2"},
  {"branch":"South Campus","students":400,"staff":30,"revenue":"1260000.00","pending_fees":"2320000.00","attendance_rate_30d":"92.0"}
]
```

**Criterion met.** Caveat, stated plainly: this is a local dev workstation with
a local Postgres and 1,200 students. It proves the query shape (one round trip,
`GROUP BY` over indexed branch columns, no per-branch loop) — it does not prove
the 2s budget at 50,000 students. Re-measure on production hardware before
quoting the number.

---

## 2. At-risk model — held-out validation

Endpoint: `GET /api/v1/analytics/at-risk/validation`. Method and leakage guards
are documented in `apps/analytics-service/validation.py`; the scoring rules it
exercises are the ones the live ranked list ships (`scoring.py`).

**The split (a real temporal hold-out, not a re-scoring of the same data):**

| | |
|---|---|
| Split (`labelFrom`) | 2026-02-20 — the start of the most recent published examination (*Term I Examination*, published 2026-03-10) |
| Feature window | 2025-02-20 → 2026-02-20 (365 days; includes the *Annual Examination*, 2025-02-20) |
| Label window | 2026-02-20 → 2026-09-16 |
| Cohort | 400 enrolled students (Main Campus) |

Marks and fee features are truncated to **before** the split; using the
label-window exam as a feature would be leakage and would manufacture a
precision figure that means nothing.

**Feature coverage (what the model could actually see):**

| Feature | Coverage |
|---|---|
| Attendance (feature window) | 100% |
| Prior exam marks (before the split) | 100% |
| **Fee arrears raised before the split** | **0%** |
| Label exam marks | 100% |
| Label attendance | 100% |

**Results — every label definition, at the top-10% cut-off:**

| Label | Positives | Prevalence | Estimable | Precision | Recall | Lift |
|---|---|---|---|---|---|---|
| `EXAM_FAIL` (< 33% overall) | 0 | 0% | **no** | — | — | — |
| `EXAM_BOTTOM_DECILE` | 40 | 10% | yes | **0.15** | **0.15** | **1.5** |
| `ATTENDANCE_BELOW` (< 75%) | 0 | 0% | **no** | — | — | — |
| `COMPOSITE` (any of the above) | 40 | 10% | yes | 0.15 | 0.15 | 1.5 |

Other cut-offs, `EXAM_BOTTOM_DECILE`: `ANY_SIGNAL` flags **1** student
(precision 1.00, recall 0.025); `HIGH` flags **0**; `TOP_20%` precision 0.087;
`TOP_30%` precision 0.083. Nothing is cherry-picked — the endpoint returns all
of them, with the confusion matrix for each.

**What this actually says.** The gate's second criterion is reportable but
**weak, and the reason is visible in the response** rather than hidden:

- **Two of the four labels cannot be validated at all on this tenant.** Not one
  of 400 students scores below 33% overall or below 75% attendance, so
  precision/recall for `EXAM_FAIL` and `ATTENDANCE_BELOW` would be a figure
  computed from zero cases. The harness refuses to state one and says so
  (`estimable: false`, with the reason) — that is the intended behaviour, not a
  failed run.
- **The model barely fires.** Only **1 of 400** students trips any shipped
  threshold (`ANY_SIGNAL`), because attendance for this cohort sits at ~92% and
  marks at ~69%. On the estimable label, that single flag is a true positive —
  precision 1.00, recall 0.025. High precision, negligible recall.
- **The ranked ordering does carry signal, and it is measured:**
  top-10% precision 0.15 against a 0.10 base rate — **lift 1.5**. Real, but far
  from a screen a principal should trust unaided.
- **The fee signal was not exercised.** All invoices in this tenant were seeded
  on 2026-09-09, so none predate the split; coverage is reported as 0% and the
  run validates the attendance + prior-marks rules only.

**Conclusion: criterion met as a harness, and it produced a real, honest
number — which is a weak one.** That is the correct outcome for synthetic seed
data, and it is also the plan's own instruction (*"Validate against a year of
history before you show it to a principal"*). Two things must happen before
this appears on a principal's screen:

1. **Recalibrate the thresholds.** Absolute cut-offs (< 75% attendance, < 50%
   marks) fire on almost nobody in a healthy cohort, which is why recall is
   2.5%. Branch-relative thresholds (bottom decile of *this* branch) would
   discriminate; the harness is already the place to measure that change.
   → **Measured. See §3.**
2. **Re-run on a tenant with real history** — a year of attendance, published
   exams, and invoices raised before the split (so the fee signal is in scope).

Both are measured with the same endpoint; no code change is needed to re-run.

---

## 3. Recalibration — branch-relative thresholds, measured

The §2 recommendation was implemented and then measured with the same harness.
`scoring.py` now carries a `Thresholds` object with two modes, both exposed on
the API (`thresholdMode=absolute | branch-relative` on `/analytics/at-risk` and
`/analytics/at-risk/validation`):

- **absolute** — the shipped regulatory lines (75% attendance eligibility /
  50% marks; critical floors 60% / 33%).
- **branch-relative** — the branch's **median** becomes the at-risk line and
  its **10th percentile** the critical line, floored at the regulatory
  minimums so a failing branch can never look healthy by comparison.
  Derivation: `at-risk = median, critical = p10, floored at 60% / 33%`.

On the live branch (Main Campus, 400 students) the derived lines are
**92% / 84% attendance and 69.5% / 62.6% marks** — against cohort means of
~92% and ~69%. `GET /analytics/at-risk/thresholds` returns both lenses with
their basis (sample sizes, the raw quantiles, the rule), because a threshold a
principal cannot read is a black box with extra steps.

### A/B through the same harness (all numbers live through the gateway)

| Lens | ANY_SIGNAL flagged | Recall (bottom-decile label) | TOP_10% precision | TOP_10% lift |
|---|---|---|---|---|
| absolute (baseline) | 1 of 400 | **0.025** | 0.15 | 1.5 |
| branch-relative | 287 of 400 | **0.65** | 0.175 | 1.75 |

Recall improves 26× and ranked lift rises — and the same run shows the cost.
Quantile **membership** ("below the branch median today") flags 287 of 400
students at precision 0.091, *below* the 0.10 base rate (lift 0.91). A
membership-level probe across operating points confirms it: p10 → lift 0.54,
p25 → 0.34, p50 → 0.45. On this tenant, today's branch-relative position
carries no information about the label window — expected for synthetic marks
drawn independently per exam, and the harness is what makes that visible
instead of guessable.

### Shipping decision

- **Screen default stays absolute.** In a healthy branch the absolute lines
  correctly flag almost nobody: an empty list is the right answer, and when
  they do fire (fee arrears, a real attendance collapse) precision is high.
- **Branch-relative ships as the measured recall-oriented lens**
  (`thresholdMode=branch-relative`) for peer-comparison watch lists, with its
  precision cost documented rather than hidden.
- **The recalibration is real, but its payoff is data-dependent.** Where a
  cohort has a persistent weak-student factor (real schools do), position
  within the branch predicts the next exam and the lens earns its keep. The
  §2 method note stands: re-run this harness on a tenant with a year of real
  history before trusting either lens's numbers.

---

## Reproducing

Both numbers come from ordinary authenticated API calls — nothing bespoke:

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@demo-main.demo.edu.in","password":"Admin@123"}' | jq -r .token)

# Criterion 1 — time it
time curl -s localhost:4000/api/v1/analytics/branch-comparison -H "Authorization: Bearer $TOKEN"

# Criterion 2 — the whole validation report (all labels, all cut-offs, caveats)
curl -s localhost:4000/api/v1/analytics/at-risk/validation -H "Authorization: Bearer $TOKEN" | jq

# Same harness, recalibrated lens (branch median / p10 lines)
curl -s "localhost:4000/api/v1/analytics/at-risk/validation?thresholdMode=branch-relative" -H "Authorization: Bearer $TOKEN" | jq

# What the lines are and where they came from (both lenses)
curl -s localhost:4000/api/v1/analytics/at-risk/thresholds -H "Authorization: Bearer $TOKEN" | jq
```

The validation endpoint is quiet about nothing: it takes `labelFrom`,
`examFailPct`, `attendanceBelow`, `bottomFraction` and `featureDays` as query
parameters, so re-running it after a threshold change — or on a tenant with real
history — is the same single call.
