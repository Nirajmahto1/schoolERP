# identity-service

Authentication and account lifecycle for the School ERP platform.
Extracted from `student-service` in Phase 3.1 (BUILD_PLAN §3) — auth living
inside students was why that file crossed 1,200 lines.

## Owns

- **Login** — email + password, invite-only (there is no public registration).
  Resolves roles from `UserRoleAssignment` on every login *and* refresh, so a
  deactivated or demoted user cannot refresh into stale privileges.
- **MFA (TOTP)** — `BRANCH_ADMIN`, `PRINCIPAL`, `SUPER_ADMIN`, `FINANCE` and
  `ACCOUNTANT` accounts get a challenge flow: login returns
  `{ mfaRequired, mfaToken }`; `POST /auth/mfa/verify` exchanges it (single
  use, 5-minute TTL) for a real token pair. Enrollment via
  `POST /auth/mfa/enroll` → `/auth/mfa/activate`.
- **Refresh rotation** — every refresh mints a new family token; reusing a
  rotated token revokes the whole family (replay detection).
- **Sessions / device list** — `GET /auth/sessions` projects refresh families
  (one entry per login), `DELETE /auth/sessions/:familyId` revokes one device,
  `POST /auth/sessions/revoke-all` kills the rest.
- **Permission resolution** — `GET /auth/me` returns the user's roles and the
  full `module.action` permission set computed from role assignments at read
  time. The frontend builds navigation from this instead of role strings.
- **Invites** — `POST /auth/invites` (permission `identity.create`) mints a
  one-time, hashed, expiring token; `POST /auth/invites/complete` activates
  the account with a password.
- **Password reset** — request/confirm with the same one-time hashed-token
  pattern; confirming a reset revokes all existing sessions.
- **Impersonation-with-audit** — a `SUPER_ADMIN` may act as another user for
  support. Every start/stop writes an `AuditLog` row (who, whom, why, IP,
  user agent) and the impersonated user's own sessions are untouched.
- **Tenant routing** — via the control plane's `user_directory`
  (email-hash → tenant), falling back to single-database mode when no control
  plane is configured (tests, local dev).

## Trust model

The service is never called directly by browsers. The **gateway** is the only
legitimate caller:

- Public subset (`/login`, `/refresh`, `/logout`, `/mfa/verify`,
  `/password/*`, `/invites/complete`) is network-restricted and rate-limited
  at the gateway.
- Everything else requires a gateway-signed, audience-bound RSA assertion
  (`x-internal-assertion`, ADR-3). Spoofable identity headers are stripped on
  every request, including public ones.

## Routes

| Method | Path | Auth |
|---|---|---|
| POST | `/auth/login` | public |
| POST | `/auth/mfa/verify` | public (mfaToken) |
| POST | `/auth/mfa/enroll` | assertion |
| POST | `/auth/mfa/activate` | assertion |
| POST | `/auth/refresh` | public (refreshToken) |
| POST | `/auth/logout` | public (refreshToken) |
| GET | `/auth/me` | assertion |
| GET | `/auth/sessions` | assertion |
| DELETE | `/auth/sessions/:familyId` | assertion |
| POST | `/auth/sessions/revoke-all` | assertion |
| POST | `/auth/invites` | assertion + `identity.create` |
| POST | `/auth/invites/complete` | public (inviteToken) |
| POST | `/auth/password/request-reset` | public |
| POST | `/auth/password/confirm-reset` | public (resetToken) |
| POST | `/auth/impersonate` | assertion + `SUPER_ADMIN` |

## Environment

See `identityEnvSchema` in `@school-erp/config`. Key variables:
`DATABASE_URL`, `CONTROL_PLANE_DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`, `INTERNAL_ASSERTION_PUBLIC_KEY`, `PORT_IDENTITY_SERVICE`,
plus login throttling (`LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES`,
`LOGIN_LOCKOUT_THRESHOLD`) and password policy (`BCRYPT_COST`,
`PASSWORD_MIN_LENGTH`, `PASSWORD_BREACH_CHECK`).

## Development

```bash
npm run dev      # tsx watch
npm run build    # tsc
npm run lint     # tsc --noEmit
npx vitest run   # 11 tests: login, MFA, rotation, sessions, invites,
                 # reset, impersonation, forged headers, cross-tenant isolation
```
