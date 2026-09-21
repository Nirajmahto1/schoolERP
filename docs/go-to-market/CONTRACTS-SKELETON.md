# Contracts — Skeletons (§13.5)

> "MSA + DPA + SLA + AUP. Get a lawyer; do not use a US SaaS template
> unmodified for India." These skeletons define what the lawyer fills in and
> keep the commercial positions you have already decided. NOT legal advice.

## Positions already decided (argue for these)
1. **Uptime 99.5%** — honest for a solo operation. 99.9% is a promise you
   cannot keep yet; a missed promise is worse than a lower number.
2. **Data ownership & exit** — "your data is yours, exportable any time."
   Then honour it with the §1.5.4 export path. Exit clause: full export in
   10 business days, deletion within 30 days of confirmation.
3. **Support access** — time-boxed audited support grants only; the school
   can read the reasons in their own audit trail. Put it in the contract —
   it is a selling point, not a concession.
4. **Payment-gateway charges** — parent-borne as a disclosed convenience fee
   by default; school may absorb. Decided per contract, in writing.
5. **Messaging credits** — WhatsApp/SMS passed through at cost + [X]%;
   credits prepaid.

## MSA (Master Service Agreement) — checklist for the lawyer
- [ ] Parties: your legal entity; school trust/society + authorised signatory
- [ ] Term: 1 academic year (April–March), renewal 60 days before expiry
- [ ] Fees: per-student/year tier + band true-up each April; onboarding fee one-time
- [ ] Payment terms: advance for the year; GST invoice; late-payment suspension after 30 days + 7-day notice
- [ ] SLA annex: 99.5% monthly uptime, sev ladder (SUPPORT-SLA-SKELETON.md), service credits (waive [5]% of the term fee per breach month, capped [25]%)
- [ ] Data protection annex (see DPA below)
- [ ] Liability cap: fees paid in the preceding 12 months; no cap for breach of confidentiality/data protection [lawyer: insurance-backed]
- [ ] Termination: 60 days notice; data export + deletion per §2 above
- [ ] Governing law: [your state], India; arbitration seat [city]

## DPA (Data Protection Agreement) — DPDP Act 2023 shape
- [ ] Roles: School = data fiduciary; Provider = data processor
- [ ] Children's data: verifiable parental consent is the SCHOOL's obligation
      to obtain (consent registry tooling provided); Provider processes only
      per documented instructions
- [ ] Security measures annex: the controls in docs/security/ASVS-L2.md
- [ ] Breach notification: Provider notifies School ≤ 24 h of confirming a
      personal-data breach (runbook: docs/compliance/BREACH-NOTIFICATION.md)
- [ ] Sub-processors listed (hosting, messaging BSP, payments) with
      change-notice obligation
- [ ] Erasure on termination per §2, save statutory retention (fee records:
      Income Tax; attendance: board rules — lawyer to confirm periods)

## AUP (Acceptable Use Policy) — short
- No unlawful content; no sharing logins between staff (impersonation and
  grants exist for legitimate sharing needs)
- School warrants parental consent for photos/messages sent through the
  platform
- No scraping the API; fair-use rate limits apply
- Provider may suspend for non-payment or AUP breach with notice

## Insurance (buy before the second paying customer)
- Professional indemnity + cyber, sized to [children's data] exposure —
  the lawyer will size it; the broker will quote it.
