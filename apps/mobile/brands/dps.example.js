// ──────────────────────────────────────────────
// TEMPLATE — copy to brands/<school>.js and fill in, then register in
// brands/index.js's BRANDS map (`dps: require('./dps').dpsBrand`). This
// file is NOT imported anywhere; it documents the white-label flow for
// the next school onboarding. It is plain JS because Expo's config
// loader resolves app.config.ts imports with bare Node require.
//
// Checklist for a new school brand:
//   1. Copy assets: icon.png, adaptive-icon.png, splash-icon.png
//      (1024², 1024² with transparency, ~1284×2778) into assets/<key>/
//   2. Copy this file → brands/<key>.js, fill every field below
//   3. Register in brands/index.js: BRANDS['<key>'] = require('./<key>').<key>Brand
//   4. eas init --owner <owner> --id <new-project> → paste easProjectId
//   5. Build: SCHOOL_BRAND=<key> eas build --profile production -p android
//   6. Store listing: the school's own developer account (their app, their
//      data — this is also the cleanest privacy posture for children's data)
// ──────────────────────────────────────────────

/** @type {import('./index').Brand} */
const dpsBrand = {
  key: 'dps',
  appName: 'DPS Parent App',
  schoolName: 'Delhi Public School',
  slug: 'dps-parent',
  appVersion: '1.0.0',
  // Bundle ids belong to THE SCHOOL's developer account, not ours.
  iosBundleId: 'com.dps.parent',
  androidPackage: 'com.dps.parent',
  scheme: 'dps',
  iconPath: './assets/dps/icon.png',
  adaptiveIconPath: './assets/dps/adaptive-icon.png',
  splashImagePath: './assets/dps/splash-icon.png',
  faviconPath: './assets/dps/favicon.png',
  colors: {
    splashBackground: '#1B3A6B',
    adaptiveIconBackground: '#1B3A6B',
    notification: '#1B3A6B',
  },
  easProjectId: undefined, // set at `eas init` for this brand's project
};

module.exports = { dpsBrand };
