// ──────────────────────────────────────────────
// Initialize/replace secrets in the local .env (idempotent, never committed)
//
//   npm run keygen        # prints a block (manual paste)
//   node scripts/dev/init-local-env.cjs   # writes into .env directly
//
// Generates: JWT_SECRET, JWT_REFRESH_SECRET, NEXTAUTH_SECRET, the RS256
// (RSA-2048) assertion keypair, and (if missing) CORS_ALLOWED_ORIGINS /
// LOG_LEVEL. All
// other lines of .env are preserved byte-for-byte.
// ──────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { generateKeyPairSync, randomBytes } = require('crypto');

const root = path.resolve(__dirname, '..', '..');
const envPath = path.join(root, '.env');

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

function generate() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    set: {
      JWT_SECRET: b64url(randomBytes(48)),
      JWT_REFRESH_SECRET: b64url(randomBytes(48)),
      NEXTAUTH_SECRET: b64url(randomBytes(48)),
      JWT_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '30d',
      INTERNAL_ASSERTION_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      INTERNAL_ASSERTION_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      INTERNAL_ASSERTION_TTL_SECONDS: '60',
    },
    setIfMissing: {
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:8081',
      LOG_LEVEL: 'info',
    },
  };
}

if (!fs.existsSync(envPath)) {
  console.error(`No ${envPath} — copy .env.example first.`);
  process.exit(1);
}

const { set, setIfMissing } = generate();
const original = fs.readFileSync(envPath, 'utf8');
const lines = original.split(/\r?\n/);
const present = new Set();
const out = [];

for (const line of lines) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) {
    out.push(line);
    continue;
  }
  const key = m[1];
  present.add(key);
  if (set[key] !== undefined) {
    out.push(valueLine(key, set[key]));
  } else if (setIfMissing[key] !== undefined) {
    out.push(valueLine(key, setIfMissing[key]));
  } else {
    out.push(line);
  }
}

// Append anything not present in the file at all.
for (const [key, value] of Object.entries({ ...set, ...setIfMissing })) {
  if (!present.has(key)) out.push(valueLine(key, value));
}

fs.writeFileSync(envPath, out.join('\n') + '\n', 'utf8');
console.log('Updated .env with fresh secrets + RS256 assertion keypair.');
console.log('Hint: .env is gitignored — never commit it. Prod uses a secret manager.');

function valueLine(key, value) {
  // PEM keys contain newlines: keep them inside a double-quoted value, which
  // the dotenv parser handles.
  const needsQuoting = value.includes('\n') || value.includes('#');
  return `${key}=${needsQuoting ? `"${value}"` : value}`;
}