// ──────────────────────────────────────────────
// Brand registry — one file per school brand, checked in and reviewed.
//
// Adding a school = adding one file here + one build:
//   brands/acme.js → SCHOOL_BRAND=acme eas build --profile production
//
// This is plain CommonJS on purpose: Expo transpiles app.config.ts itself
// but resolves its imports with bare Node require, which cannot load .ts
// modules. Types for TS importers live in index.d.ts.
// ──────────────────────────────────────────────

/**
 * The platform default — what `npx expo start` and CI build when no
 * SCHOOL_BRAND is set. Neutral EduCore branding, un-owned.
 */
const DEFAULT_BRAND = {
  key: 'educore',
  appName: 'EduCore',
  schoolName: 'EduCore School',
  slug: 'educore-mobile',
  appVersion: '1.0.0',
  iosBundleId: 'com.educore.mobile',
  androidPackage: 'com.educore.mobile',
  scheme: 'erp', // the push dispatcher's default deep-link scheme
  iconPath: './assets/icon.png',
  adaptiveIconPath: './assets/adaptive-icon.png',
  splashImagePath: './assets/splash-icon.png',
  faviconPath: './assets/favicon.png',
  colors: {
    splashBackground: '#ffffff',
    adaptiveIconBackground: '#ffffff',
    notification: '#2563EB',
  },
};

const BRANDS = {
  [DEFAULT_BRAND.key]: DEFAULT_BRAND,
  // Register signed school brands here:
  //   dps: require('./dps').dpsBrand,
};

/** Resolve a brand by key; unknown or missing keys fall back to DEFAULT.
 *  A typo in SCHOOL_BRAND must never fail a CI build — but it must never
 *  silently ship the wrong school's identity either, so it warns. */
function getBrand(key) {
  if (!key) return DEFAULT_BRAND;
  const brand = BRANDS[key.toLowerCase()];
  if (!brand) {
    console.warn(
      `[brand] SCHOOL_BRAND='${key}' is not registered — building as '${DEFAULT_BRAND.key}'. ` +
        `Register it in apps/mobile/brands/index.js.`,
    );
    return DEFAULT_BRAND;
  }
  return brand;
}

module.exports = { DEFAULT_BRAND, getBrand };
