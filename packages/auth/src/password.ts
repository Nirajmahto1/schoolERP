// ──────────────────────────────────────────────
// Password policy
//
// Parents and teachers pick weak passwords, and a school ERP holds children's
// records. Length + breach-checking beats composition rules (NIST SP 800-63B):
// forced symbols produce `Password1!` while a breach check catches it.
// ──────────────────────────────────────────────

import { createHash } from 'crypto';

export class PasswordPolicyError extends Error {
  constructor(
    message: string,
    readonly reason: 'too-short' | 'too-long' | 'breached' | 'too-common' | 'contains-identity',
  ) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/** Passwords seen constantly in Indian school deployments. */
const LOCAL_DENYLIST = new Set([
  'password',
  'password1',
  'password123',
  'school123',
  'admin123',
  'teacher123',
  'student123',
  'welcome123',
  'india@123',
  'abcd1234',
  '12345678',
  '123456789',
  'qwerty123',
  'principal',
]);

export interface PasswordPolicyOptions {
  minLength?: number;
  maxLength?: number;
  /** Query HIBP's k-anonymity range API. Disable in tests and offline installs. */
  breachCheck?: boolean;
  /** Email/name fragments the password must not contain. */
  identityTerms?: string[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Check a password against Have I Been Pwned using k-anonymity: we send only
 * the first 5 characters of the SHA-1 hash, so the full hash never leaves this
 * process and HIBP cannot learn the password.
 *
 * Fails OPEN on network error — a school must not be locked out of creating
 * accounts because an external API is down. The length and denylist checks
 * still apply.
 */
export async function isPasswordBreached(
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;

    const body = await response.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, countRaw] = line.trim().split(':');
      if (hashSuffix === suffix && Number(countRaw) > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Throws `PasswordPolicyError` if the password is unacceptable. */
export async function assertPasswordAcceptable(
  password: string,
  options: PasswordPolicyOptions = {},
): Promise<void> {
  const {
    minLength = 10,
    maxLength = 128,
    breachCheck = true,
    identityTerms = [],
    fetchImpl = fetch,
  } = options;

  if (password.length < minLength) {
    throw new PasswordPolicyError(
      `Password must be at least ${minLength} characters.`,
      'too-short',
    );
  }

  // Bcrypt silently truncates at 72 bytes; cap well below to avoid the surprise.
  if (password.length > maxLength) {
    throw new PasswordPolicyError(
      `Password must be at most ${maxLength} characters.`,
      'too-long',
    );
  }

  const normalized = password.toLowerCase();

  if (LOCAL_DENYLIST.has(normalized)) {
    throw new PasswordPolicyError(
      'That password is too common. Choose something less predictable.',
      'too-common',
    );
  }

  for (const term of identityTerms) {
    const cleaned = term.trim().toLowerCase();
    if (cleaned.length >= 4 && normalized.includes(cleaned)) {
      throw new PasswordPolicyError(
        'Password must not contain your name or email address.',
        'contains-identity',
      );
    }
  }

  if (breachCheck && (await isPasswordBreached(password, fetchImpl))) {
    throw new PasswordPolicyError(
      'That password has appeared in a known data breach. Choose a different one.',
      'breached',
    );
  }
}
