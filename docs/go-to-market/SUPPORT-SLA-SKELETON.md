# Support & SLA Skeleton (§13.4)

> Ready-to-operate support on day one of the pilot. The lawyer reviews the
> SLA wording when the MSA is drafted; the operational reality below is the
> commitment — don't promise what this page doesn't do.

## Channels
1. **WhatsApp line** — Indian schools will use WhatsApp regardless of what
   you set up, so make it the official channel from day one. Business hours:
   8:00–17:00 IST, Mon–Sat.
2. **Email** — support@[yourdomain]; creates a ticket in [Freshdesk/Zoho].
3. **Phone** — pilot schools get the direct number; the rest get callbacks.

## Severity ladder (response / resolution targets)

| Sev | Example | Response | Resolution target |
|-----|---------|----------|-------------------|
| **S1** — platform down | Tenant cannot log in; fee desk blocked on collection day | **1 h** (any hour) | Same day; hourly status updates |
| **S2** — module broken | Attendance saves but doesn't notify; report card PDF errors | 4 business h | Same/next business day |
| **S3** — wrong result | A report shows a number the school can reproduce as wrong | 1 business day | 5 business days |
| **S4** — how-do-I | "Where is the TC certificate?" | 1 business day | Answered |

**S1 means the school cannot operate.** Everything else can wait for
business hours — saying so out loud is what makes S1 credible.

## Support access rule (§13.4.2)
- No shared admin password, ever. Every school-side intervention goes through
  a **support grant**: time-boxed (max 72 h), reason required (visible to the
  school), one-time activation code, every action attributed to the grant in
  the school's own audit trail.
- The grant is created in the platform console; the code is shown once.
- Revoke takes one click; live tokens die within 15 minutes.

## Escalation & on-call reality check
- **You are the on-call rotation.** Decide now what you answer at 7 a.m. on
  results day: S1, yes; S4, after breakfast. Publish the rule, then follow it.
- Escalation path: support line → you → (later, first hire) onboarding/support
  lead. Post-mortem within 48 h for any S1, in the changelog.

## Status & release comms (§13.4.3)
- Public status page: `/status` on the web app (fed by the gateway probe).
- Changelog: `/changelog` — updated per release; incident post-mortems land
  here too.
- In-app release notes: dashboard banner on first login after a release.
