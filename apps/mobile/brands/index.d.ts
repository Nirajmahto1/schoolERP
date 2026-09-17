// Types for brands/index.js — the registry is CommonJS because Expo's
// config loader resolves imports with bare Node require (no TS support).

export interface Brand {
  /** MACHINE key used in SCHOOL_BRAND=... and file naming. */
  key: string;
  /** Store-listing and device name ("EduCore — Delhi Public School"). */
  appName: string;
  /** Human school name shown on the login screen. */
  schoolName: string;
  /** Expo slug + EAS project separation. */
  slug: string;
  appVersion: string;
  iosBundleId: string;
  androidPackage: string;
  /** Deep-link scheme for push taps: `${scheme}://fees`, `${scheme}://attendance`… */
  scheme: string;
  iconPath: string;
  adaptiveIconPath: string;
  splashImagePath: string;
  faviconPath: string;
  colors: {
    splashBackground: string;
    adaptiveIconBackground: string;
    notification: string;
  };
  /** EAS project for this brand (from `eas init`). Undefined until provisioned. */
  easProjectId?: string;
}

export declare const DEFAULT_BRAND: Brand;
export declare function getBrand(key?: string): Brand;
