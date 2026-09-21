# Go-to-Market Pack (Phases 13–14)

Everything buildable for launch lives here; the business decisions only you
can make are listed as open items. The engineering phases (0–12) are closed —
this pack is what turns them into a sale.

## Sales assets (§13.2)
| Asset | Where |
|---|---|
| Demo tenant (3 branches, 1,200 students, full year) | `npm run seed:demo` — verify before every demo |
| 20-minute demo script | [DEMO-SCRIPT.md](./DEMO-SCRIPT.md) |
| Pricing page (public) | `/pricing` on the web app |
| Security page (public, for procurement) | `/security` on the web app |
| Request-demo form → lead pipeline | `/request-demo` → `demo_leads` (control plane) → admin console |
| Status page / changelog (public) | `/status`, `/changelog` on the web app |

## Onboarding machine (§13.3)
| Asset | Where |
|---|---|
| Import templates | `GET /api/v1/students/import-template` (generated CSV, headers = importer schema) |
| Onboarding checklist | [ONBOARDING-CHECKLIST.md](./ONBOARDING-CHECKLIST.md) |
| Parent-app adoption campaign | [ADOPTION-CAMPAIGN.md](./ADOPTION-CAMPAIGN.md) — metric: `GET /api/v1/analytics/parent-app-adoption` |

## Support & legal (§13.4–13.5)
| Asset | Where |
|---|---|
| Support grants (time-boxed, audited access) | Built: console → `support_grants` → identity `/auth/support/activate` |
| SLA + support channels | [SUPPORT-SLA-SKELETON.md](./SUPPORT-SLA-SKELETON.md) |
| Pilot agreement | [PILOT-AGREEMENT-SKELETON.md](./PILOT-AGREEMENT-SKELETON.md) |
| MSA / DPA / AUP checklist | [CONTRACTS-SKELETON.md](./CONTRACTS-SKELETON.md) |

## Open items only you can do
1. **Validate pricing locally** (§13.1) — the ₹150/300/500 tiers are the
   market shape, not a decision; call 3 schools and ask what they pay now.
2. **Pick the pilot schools** (§14.1) — one single-branch, one multi-branch.
3. **Lawyer** — MSA/DPA/SLA/AUP from the skeletons; insurance quote.
4. **Register the business + bank + Razorpay live account** — test mode is
   wired; going live needs the KYC.
5. **Buy the domain + email** (security@ for the disclosure policy).
6. **Commission external VAPT** before the first paying tenant (Gate 12 gap).
