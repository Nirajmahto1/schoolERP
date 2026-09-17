// ──────────────────────────────────────────────
// White-label build configuration (Phase 9.6 / Gate 9).
//
// "School-branded builds for big chains — chains will ask for their own app
// icon and name, and charging for it is good business" (§9.6). One codebase,
// one build command per school:
//
//   SCHOOL_BRAND=dps npx expo run:android
//   SCHOOL_BRAND=dps eas build --profile production
//
// Each brand is a static file under brands/ (checked in, reviewed like code):
// display name, slug, bundle identifiers, colors, asset paths, and the
// deep-link scheme the push dispatcher's erp:// links ride on.
//
// app.json is DELETED in favour of this file — Expo reads app.config.ts
// natively, and a static JSON cannot express the brand switch. With no
// SCHOOL_BRAND set, DEFAULT is used so `npx expo start` keeps working
// untouched for development.
// ──────────────────────────────────────────────
import type { ExpoConfig } from 'expo/config';
import { DEFAULT_BRAND, getBrand } from './brands';

const brandName = process.env.SCHOOL_BRAND?.trim();
const brand = getBrand(brandName);

const config: ExpoConfig = {
  name: brand.appName,
  slug: brand.slug,
  version: brand.appVersion,
  orientation: 'portrait',
  icon: brand.iconPath,
  userInterfaceStyle: 'light',
  // sdkVersion omitted — pinned by the expo package.
  newArchEnabled: true,

  scheme: brand.scheme, // deep links: ${scheme}://fees etc.

  splash: {
    image: brand.splashImagePath,
    resizeMode: 'contain',
    backgroundColor: brand.colors.splashBackground,
  },

  ios: {
    supportsTablet: true,
    bundleIdentifier: brand.iosBundleId,
    // Apple review requires the app name to match the school brand, and
    // children's data means the privacy declarations must be accurate
    // (see docs/ops/store-data-safety.md).
    infoPlist: {
      CFBundleDisplayName: brand.appName,
    },
  },

  android: {
    package: brand.androidPackage,
    adaptiveIcon: {
      foregroundImage: brand.adaptiveIconPath,
      backgroundColor: brand.colors.adaptiveIconBackground,
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
  },

  web: {
    favicon: brand.faviconPath,
  },

  // Notification tint per brand — Android requires the channel color to
  // match the school's identity or the push looks foreign.
  plugins: [
    ['expo-notifications', { color: brand.colors.notification }],
  ],

  extra: {
    // Surfaced to JS as expo-constants — the app can show the school's name
    // on its login screen without a fetch.
    brand: {
      key: brand.key,
      appName: brand.appName,
      schoolName: brand.schoolName,
      scheme: brand.scheme,
    },
    eas: {
      projectId: brand.easProjectId,
    },
  },
};

export default config;
export { DEFAULT_BRAND };
