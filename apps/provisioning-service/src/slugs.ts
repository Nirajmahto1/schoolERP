// ──────────────────────────────────────────────
// Slug validation & reservation (BUILD_PLAN 1.2.1)
// ──────────────────────────────────────────────

/** Subdomains that must never collide with a real tenant. */
export const RESERVED_SLUGS = new Set([
  'www',
  'api',
  'admin',
  'app',
  'status',
  'support',
  'docs',
  'blog',
  'dev',
  'staging',
  'test',
  'mail',
  'ftp',
  'help',
  'about',
  'billing',
  'account',
  'accounts',
  'assets',
  'cdn',
  'console',
  'dashboard',
  'internal',
  'login',
  'register',
  'auth',
  'legal',
  'privacy',
  'terms',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Returns a human message when invalid, or null when the slug is usable. */
export function slugProblem(slug: string): string | null {
  const normalized = slug.toLowerCase();
  if (!normalized) return 'slug is required';
  if (normalized.length < 3 || normalized.length > 32) {
    return 'slug must be between 3 and 32 characters';
  }
  if (!SLUG_RE.test(normalized)) {
    return 'slug may contain only lowercase letters, digits, and hyphens, and must start/end with a letter or digit';
  }
  if (RESERVED_SLUGS.has(normalized)) {
    return `slug "${normalized}" is reserved and cannot be used`;
  }
  return null;
}

export function normalizeSlug(slug: string): string {
  return slug.toLowerCase();
}