# Sales Assets — share these with prospects

Everything prospect-facing lives here. Print the PDFs, attach the APK,
send the sheet. Regenerate any piece from source — nothing here is hand-made.

| File | What it is | Regenerate with |
|---|---|---|
| `EduCore-One-Pager.pdf` | One-page leave-behind: problem → product → pricing | `node scripts/generate-one-pager-pdf.cjs` (source: [docs/go-to-market/ONE-PAGER.md](../docs/go-to-market/ONE-PAGER.md)) |
| `EduCore-Product-Sheet.pdf` | One-page visual: 9 live screenshots of the real demo tenant | `node scripts/capture-sales-shots.cjs && node scripts/capture-sales-shots-parent.cjs && node scripts/generate-sales-sheet.cjs` |
| `EduCore-ParentApp.apk` | The Android parent app (release build) — install and sign in with a demo parent login | `cd apps/mobile_flutter && flutter build apk --release && cp build/app/outputs/flutter-apk/app-release.apk sales-assets/EduCore-ParentApp.apk` |
| `PRODUCT-SHEET.html` + `shots/` | Source of the product sheet — edit copy here, then re-run the generator | — |

## Demo logins (tenant `demo-main`)

| Role | Email | Password |
|---|---|---|
| Group owner / admin | `admin@demo-main.demo.edu.in` | `Admin@123` |
| Parent | `parent1@demo-main.demo.edu.in` | `Admin@123` |
| Student | `student.probe@demo-main.demo.edu.in` | `Student@123` |

Point the app or browser at the gateway (`http://<host>:4000`; on the dev
hotspot LAN `http://192.168.137.1:4000`).

## Before you send anything

1. **Rebuild the APK** if the app changed since the last build — check the
   timestamp against the last commits to `apps/mobile_flutter/`.
2. **Re-capture screenshots** if the UI changed — the sheet must show the
   product the prospect will buy, not last month's.
3. **Razorpay is in TEST mode** in the demo — payments simulate; say so
   proudly, it means you can demo collections without real money.
4. The demo school is a fictional **"Sunrise Public School"** (3 campuses,
   1,200 students) — no real school's name is used anywhere.
