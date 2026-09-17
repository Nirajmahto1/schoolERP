# Store Data-Safety & Privacy Declarations — Children's Data

**Scope:** the mobile app (`apps/mobile`) submitted to Google Play and the Apple App Store, in both the neutral (EduCore) build and any school-branded white-label build.
**Audience:** whoever fills the Play Console "Data safety" form and App Store Connect "App Privacy" labels; also the evidence base for the school's own privacy policy.
**Last verified against code:** 2026-09-18 — every claim below traces to a file in this repo; the "Evidence" column names it. Re-verify before each store submission; the answers must match the shipped build.

---

## 1. What the app is, in data terms

The app is a school portal for four roles (admin/principal, teacher, finance, parent). Children's data is **displayed to authorized adults** (parents see their own child; teachers see their assigned classes) — the app does not target children under 13 as an audience, and no child uses it directly. This distinction drives every answer below: the data is *about* children, *handled on behalf of* the school (the data controller), by the platform operator (the data processor under the school's instructions).

Store-form implication: declare data **collection**, answer "is this data shared" honestly (it is transmitted to the school's own ERP backend and its processors — Razorpay for payments, FCM for push), and select the "this app is not directed at children under 13 but may contain data about them via an institutional relationship" posture where the form offers it.

## 2. Data inventory — what actually leaves or lives on the device

| # | Data | Where it goes / lives | Why | Evidence (file) |
|---|------|----------------------|-----|-----------------|
| 1 | Email, password | `POST /auth/login` → school ERP backend | Authentication. Password never stored on device. | `lib/api.ts` (`authApi.login`) |
| 2 | Access + refresh tokens (opaque JWTs carrying role/branch claims) | AsyncStorage keys `erp_token`, `erp_refresh_token` | Session continuity; refresh is single-flight on 401 | `lib/api.ts`, `lib/api.ts` refresh logic |
| 3 | Academic-year hint | AsyncStorage key `erp_academic_year_id` | Avoid re-picking the year each launch | `lib/api.ts` |
| 4 | Child's name, class/section, attendance %, fee dues, published grades | Retrieved from backend, rendered in-memory; never written to device storage | Parent dashboard ("children-summary") | `components/screens/ParentDashboard.tsx` via `lib/api.ts` |
| 5 | Fee payment: order id, amount (paise), Razorpay order/token | Razorpay's native checkout SDK → Razorpay (PCI-DSS); capture verified by our backend | Fee payment. **Card/UPI credentials never touch our code or servers** — the native sheet collects them; we only receive the signature triple for server-side HMAC verification | `StudentFeesScreen.tsx`, fee-service `/fees/checkout/*` |
| 6 | Receipt number (after capture) | Rendered in-app from backend response | Proof of payment | `StudentFeesScreen.tsx` |
| 7 | FCM push token + platform (`ANDROID`/`IOS`/`WEB`) + device label | `POST /communication/devices` → backend | Deliver push notifications to this device; row is upserted by token so "newest account on the phone wins" | `lib/push.ts` (`registerPushToken`) |
| 8 | Attendance marks (per-student status, remarks, date, class/section) — **teacher role** | Queued offline in AsyncStorage key `erp_attendance_outbox`, then `POST /attendance/mark` | Offline-first marking in corridors with bad connectivity; batch id is a client UUID so server upsert is replay-safe | `lib/offline-attendance.ts` |
| 9 | Deep-link payload in pushes (`fees`, `attendance`, `results`, `timetable`, `announcements` — path only, no personal data) | Via FCM, opened by the app | Navigate the user to the relevant tab | `lib/push.ts` (`routeForDeepLink`) |
| 10 | Network reachability | NetInfo (on-device only) | Decides when the outbox syncs | `TeacherAttendanceEntry.tsx` |

**What the app does NOT do** (verified against the dependency tree, 2026-09-18):
- No analytics, ads, crash-reporting, or tracking SDKs (no Sentry/Crashlytics/analytics packages in `apps/mobile/package.json`).
- No location, contacts, camera, microphone, photos, or storage-permission access.
- No third-party webviews that could observe content.
- No data sold, and no data shared with third parties *except* the two processors named above (Razorpay, Google FCM), both acting to deliver the service the school bought.

## 3. Google Play "Data safety" — answer sheet

**Does your app collect or share any of the required user data types?** → Yes

**Is all of the user data collected by your app encrypted in transit?** → Yes (app talks to the backend over HTTPS; Razorpay SDK enforces TLS; FCM is TLS).

**Do you provide a way for users to request that their data is deleted?** → Yes (see §6 — deletion is routed through the school's account-admin/ERP flow, plus uninstall clears the device).

**Data types to declare:**

| Play category | Declared? | Collected | Shared | Ephemeral | Notes |
|---|---|---|---|---|---|
| Personal info → Email addresses | Yes | Yes | Yes (school backend) | No | #1 |
| Personal info → User IDs | Yes | Yes | Yes (school backend) | No | JWT subject/claims (#2) |
| App activity → In-app actions (attendance marks, fee payments) | Yes | Yes | Yes (school backend) | No | #5, #8 — these are the product's records, stored as the school's books |
| Financial info → Purchase history | Yes | Yes | Yes (school backend; Razorpay as processor) | No | Receipt number, invoice state (#5, #6). **Not** card numbers — declare "no financial info collected by developer" for payment credentials |
| Messages → Other user-generated content? | **No** | — | — | — | Push bodies carry school notices; the app has no chat. Remarks on attendance go to the backend like any form field — covered by App activity |
| Device or other IDs | Yes | Yes | Yes (Google FCM as processor) | No | Push token (#7) |
| App info and performance | **No** | — | — | — | No crash/analytics SDKs |
| Location | **No** | — | — | — | — |
| Photos and videos / Audio / Files | **No** | — | — | — | — |

**Purposes to tick** for everything declared: *App functionality* only. Do **not** tick advertising, analytics, developer communications, or personalization — none are true.

**Data deletion:** point the form at the school-operated deletion request path (§6).

**Play families policy note:** the app is submitted as a general-audience app used by schools; if the store listing markets it to children directly, the Families policy applies and this doc must be re-reviewed against it.

## 4. Apple App Store "App Privacy" — answer sheet

**Do you or your third-party partners collect data from this app?** → Yes

Declare (all under "App functionality", not linked to identity for tracking, no "tracking" across other companies' apps — zero trackers exist):

- **Contact Info → Email Address** — collected (login), linked to identity.
- **Identifiers → User ID** — collected (session claims), linked to identity.
- **Usage Data → Product Interaction** — *decline*: no analytics SDK; in-app actions like attendance are educational records transmitted for app function, not product-interaction telemetry.
- **Purchases → Purchase History** — collected (fee receipts), linked to identity.
- **Other Data → Device Token** (push) — collected, linked to the logged-in account while registered.

**"Is this data used to track you?"** → No for everything (no cross-app tracking exists in the build).

**App Store privacy-nutrition guidance for minors:** the app handles student education records on behalf of schools; the school remains the controller. Apple's "Data Not Collected" label must **not** be used — email + tokens + records are collected.

## 5. Permissions the build requests

| Permission | When | Justification for store review notes |
|---|---|---|
| Notifications | On first login (parent/teacher value) | Attendance-absence, fee-due, results, announcements — all school-triggered |
| Internet | Always | The app is a portal; nothing works offline except queued attendance |
| None else | — | No camera/mic/location/storage permissions are requested anywhere in the code |

## 6. Retention, deletion, and the user's controls

**On-device retention:**
- Session tokens + academic-year hint: until logout (`AsyncStorage.multiRemove(['erp_token','erp_refresh_token','erp_academic_year_id'])` in `navigation/AppNavigator.tsx`) or uninstall.
- Offline attendance outbox: until synced (then the batch is removed); retained across logout on purpose — the pending school record survives an account switch. Uninstall clears it.
- Child data shown on dashboards: in-memory only, never persisted.

**Server-side retention:** governed by the school's own policy — the platform operator keeps student records as long as the school's contract instructs (these are the school's statutory books: attendance registers, fee ledgers). Deletion requests from a parent are executed by the school admin in the ERP (students, invoices, devices); the platform's job is to make that possible and audited.

**User-facing controls shipped today:**
- Logout clears tokens (# above).
- Deleting a device's push registration: server endpoint exists (`DELETE /communication/devices`); recommended follow-up: expose it on logout or in a settings screen (see §7).
- Data export/access: via the school's admin, not in-app (declared accordingly in the privacy policy).

## 7. Honest gaps before submission (do not ship without these)

1. **Privacy policy URL is required by both stores.** Each school-branded build needs *the school's* policy URL; the platform should ship a template under `docs/` that schools fill in. The form field cannot be left blank.
2. **Push deregistration on logout** — currently the FCM row stays (device keeps receiving the *next* account's pushes by design of the upsert). If reviewers ask, or a school demands it, call `DELETE /communication/devices` in the logout path. Deliberate open choice, documented here.
3. **Account deletion (Play requirement for apps with account creation):** school admins delete accounts; the store form asks for an in-app or web path — route it to the school's admin/deletion request page and declare that.
4. **Razorpay's own privacy policy must be linked** in the school's policy (it is a processor for payment instruments).
5. **Play Console declaration of the FCM SDK:** Google's own guidance exempts device-to-Google transmission for FCM from the "shared" declaration — re-check the current policy text at submission time; if the console forces it, declare Device IDs → shared → Google (processor).

## 8. Change log

- 2026-09-18 — Initial declarations doc, verified against code: login/tokens, children-summary display, offline outbox, push registration, Razorpay checkout, zero analytics/ads SDKs. Logout token-clearing added in the same change (`AppNavigator.tsx`) so §6's on-device retention claim is true.
