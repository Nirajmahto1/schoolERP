# Onboarding Checklist (§13.3.3)

> "The main reason school ERP deals die is data migration. Industrialise it."
> One page per school. Print it. Every box gets a date and an owner.

## 0. Kickoff (Day 0)
- [ ] Signed pilot/contract + onboarding-fee invoice sent
- [ ] School-side champion named (usually the office manager) + a deputy
- [ ] Scope recorded: branches, class/section ladder, grading scheme, fee heads
- [ ] Decision recorded: convenience fee on online payments — school-borne or parent-borne
- [ ] Go-live target date set (anchor to a term boundary, not mid-term)

## 1. Data collection (Days 1–7)
- [ ] Hand over the Excel templates: students (GET /api/v1/students/import-template), staff, fee structure, previous marks
- [ ] Collect the school's own exports (any format) as backup source
- [ ] Admission-number policy decided: keep theirs or re-issue — **decide once, in writing**
- [ ] Photos: class-wise photo collection plan (the app shows faces; missing photos stall adoption)

## 2. Import (Days 5–10)
- [ ] Dry-run import on students — review the per-row error report with the champion
- [ ] Fix source data (duplicates, missing sections, bad dates) at the SOURCE, not in the tool
- [ ] Commit import; spot-check 20 random students against paper records
- [ ] Import staff, map roles (teacher/HOD/principal/accountant), verify logins
- [ ] Configure fee heads + terms + concession rules; import opening balances
- [ ] Import previous-term marks so report cards have history on day one

## 3. Configure (Days 8–12)
- [ ] Academic year + calendars (holidays, exam windows)
- [ ] Timetable generated + reviewed by HODs (locked slots honoured)
- [ ] Branch geofence coordinates set for staff self-attendance
- [ ] Late-arrival cut-off time per branch
- [ ] WhatsApp/SMS credits purchased; DLT templates approved (India)
- [ ] MFA enrolled for owner + principals; passwords force-changed from invites

## 4. Train (Days 10–15)
- [ ] Admin/office: 60-minute session (admissions, fees, receipts, TC)
- [ ] Teachers: 30-minute session (attendance, marks, leaves) — in their staff room, not a lab
- [ ] Front-desk kiosk demo for walk-in parents
- [ ] Quick-reference cards printed (English + Hindi) — one per teacher
- [ ] Record who was trained; untrained names are support tickets waiting to happen

## 5. Parent app rollout (Days 12–20) — the campaign
- [ ] WhatsApp broadcast to parent groups with the download link + login invite
- [ ] Poster at the gate with QR; class teachers announce in the diary
- [ ] First push sent (welcome + fee receipt sample) to verify delivery
- [ ] **Measure adoption daily** (analytics/parent-app-adoption) — call the laggard classes, not individuals
- [ ] Target: >70% installed within 30 days

## 6. Go-live (Day 21)
- [ ] Parallel run ends; paper registers retired
- [ ] First live attendance marked; first fee collected; first receipt issued
- [ ] Support line shared: WhatsApp number + hours posted in the staff room
- [ ] Daily 15-minute check-in call for the first week

## 7. 30-day check-in (Day 30–35)
- [ ] Adoption rate reviewed with the principal (target >70%)
- [ ] Top 5 friction points from support tickets fixed or scheduled
- [ ] Time saved in the accounts office measured → this number becomes the case study
- [ ] Written permission for the case study requested (§13.2.4)
- [ ] Invoice the subscription; ask for the referral
