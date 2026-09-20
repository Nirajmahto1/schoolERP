# Personal-Data Breach Notification Runbook (BUILD_PLAN 10.1 #5)

> Rehearsed timeline required by Gate 10. Owner: [CTO / you]. Review date:
> every 6 months or after any real incident.

## The two clocks

| Clock | Deadline | Action |
|---|---|---|
| **Internal** | **T+4 hours** — detection → severity classified → incident channel open | Don't investigate silently; classify fast |
| **Fiduciary (school) notice** | **T+24 hours** — written notice to the affected school's named grievance officer/principal | Per DPA §3(f); template below |
| **DPDP Board (via Fiduciary)** | As the Act/Rules prescribe | We assist; the school is the Fiduciary and notifies |

## Severity classification (T+4h)

| Level | Example | First response |
|---|---|---|
| **S1 — confirmed exfiltration** of child data | DB dump found public; tenant isolation bug exploited | Page owner now; preserve logs; prepare 24h notice |
| **S2 — confirmed exposure, no exfiltration evidence** | Misconfigured storage made photos public briefly | Contain + forensic pass; notice likely |
| **S3 — suspected only** | Weird bulk API pulls in access logs; leaked cred in a repo but rotated | Investigate 48h; document decision either way |
| **S4 — no personal data** | Downtime, defaced static page | Standard incident process |

## Containment checklist

1. Rotate the implicated credentials/keys (DB, gateway, BSP, Razorpay, FCM).
2. Revoke active sessions: refresh-token family for affected users; force
   re-login (identity-service has the levers).
3. Snapshot **before** fixing: access logs, audit tables, error traces —
   the DPDP Board and the school's lawyer will ask what moved.
4. Fix the root cause; deploy; verify with the isolation tests
   (cross-tenant probe suite from Gate 6).

## School notice (T+24h) — template

> To: [school grievance officer] · Subject: Personal data breach notice —
> [school name]
>
> We became aware at [UTC time] of [description of the breach]. Data
> potentially affected: [categories; specifically whether children's
> data]. Scope: [N users / which branch]. Containment completed at [time]:
> [actions]. Our investigation continues; you will receive a full report
> by [date]. Recommended immediate school actions: [force password reset?
> notify parents?]. Our grievance contact for this incident:
> [name, email, phone].

## Rehearsal (every 6 months)

- 60-minute tabletop: "photos bucket public" scenario — classify,
  contain, draft the notice. Everyone on the rotation participates.
- Verify: can you actually pull the last-24h access log for one tenant in
  under 15 minutes? If not, fix logging retention.

## Evidence register (keep per incident)

Detection time/source, timeline of actions, root cause, data categories +
affected scope, notices sent, prevention items with owners and dates.
