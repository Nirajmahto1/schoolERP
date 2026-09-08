// ──────────────────────────────────────────────
// Generate local secrets + the RS256 (RSA-2048) assertion keypair
//
// The .env must NEVER reuse the placeholder values that shipped with
// .env.example — @school-erp/config rejects them at boot. Run:
//
//     npm run keygen
//
// and copy the printed block into .env (only needed once per developer
// machine / environment). Production uses a secret manager (AWS Secrets
// Manager / Doppler / sops), not a .env file.
// ──────────────────────────────────────────────

import { generateKeyPairSync, randomBytes } from 'node:crypto';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

const jwtSecret = b64url(randomBytes(48));
const refreshSecret = b64url(randomBytes(48));
const nextauthSecret = b64url(randomBytes(48));

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const block = `# ── Replace these in your .env (phone-home safe: never commit .env) ──
JWT_SECRET=${jwtSecret}
JWT_REFRESH_SECRET=${refreshSecret}
NEXTAUTH_SECRET=${nextauthSecret}
INTERNAL_ASSERTION_PRIVATE_KEY="${privateKey.trim()}"
INTERNAL_ASSERTION_PUBLIC_KEY="${publicKey.trim()}"
`;

process.stdout.write(block + '\n');