# EduCore Deployment Guide — every step from bare server to running school

> This is the **complete** step-by-step guide. The short version lives in
> `docs/ops/DEPLOY.md`. Follow this top-to-bottom on a fresh Ubuntu 22.04/24.04
> VPS and you end with a running, HTTPS-enabled, backed-up deployment.
>
> Target shape: **one VPS** (4 vCPU / 8 GB / 80 GB disk is comfortable for a
> fleet of small schools). No Kubernetes — the single-node economics hold
> until the fleet forces a second node.

---

## Step 0 — Server + DNS (10 minutes, at your provider)

1. Create a VPS: Ubuntu **22.04 or 24.04**, 4 vCPU / 8 GB RAM / 80 GB SSD.
2. In your DNS provider, add an **A record**: `erp.yourschools.in` → the
   server's public IP. (TTL 300 so mistakes are quick to fix.)
3. Note the server IP and log in once to confirm:
   ```bash
   ssh root@<server-ip>
   ```

## Step 1 — System packages + firewall (5 minutes)

```bash
apt update && apt -y upgrade
apt -y install curl git ufw openssl

# Docker Engine + compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sh

# Firewall: web + SSH only. Port 4000 (gateway) stays internal —
# the Caddy edge is the only public front door.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
```

## Step 2 — Get the code (2 minutes)

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/Nirajmahto1/schoolERP.git educore
cd educore
git log --oneline -1   # should show fbb1158 or newer
```

## Step 3 — Secrets: generate every key this stack needs (10 minutes)

Copy the template and generate the secrets **on the server** (they never
leave the box):

```bash
cd /opt/educore
cp .env.example .env
chmod 600 .env

# ── 1. Database password ──
openssl rand -base64 24        # → POSTGRES_PASSWORD

# ── 2. Auth token signing secret ──
openssl rand -base64 48        # → JWT_SECRET

# ── 3. Operator-console session secret ──
openssl rand -base64 32        # → ADMIN_CONSOLE_SESSION_SECRET

# ── 4. Internal assertion keypair (RS256, RSA-2048) ──
#    The gateway mints short-lived assertions; every service verifies them.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out /tmp/assertion.key 2>/dev/null
openssl rsa -in /tmp/assertion.key -pubout -out /tmp/assertion.pub 2>/dev/null
```

Now edit `.env` and fill the values. **PEM keys go in as single-line values
with `\n` where the newlines were** (dotenv handles this; both keys are
proven to load this way in the dev deployment):

```
INTERNAL_ASSERTION_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n
INTERNAL_ASSERTION_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nMIIBIj...\n-----END PUBLIC KEY-----\n
```

Generate paste-ready single-line keys with:

```bash
awk 'NF {printf "%s\\n", $0}' /tmp/assertion.key   # private → paste into .env
awk 'NF {printf "%s\\n", $0}' /tmp/assertion.pub   # public  → paste into .env
rm -f /tmp/assertion.key /tmp/assertion.pub
```

Set the deployment vars in the Docker block at the bottom of `.env`:

```
POSTGRES_PASSWORD=<generated above>
DOMAIN=erp.yourschools.in
GATEWAY_PORT=4000
ADMIN_CONSOLE_PORT=127.0.0.1:3100
NEXT_PUBLIC_API_URL=https://erp.yourschools.in/api/v1
```

> `NEXT_PUBLIC_*` values are **baked into the browser bundle at image build
> time**. Set them before the first `up`, or rebuild `web` after changing:
> `docker compose -f docker/docker-compose.app.yml up -d --build web`.

Everything else in `.env` is optional and degrades gracefully: Razorpay keys
unlocks online fees; `WHATSAPP_*`/`SMS_*`/`SMTP_URL`/`FCM_*` unlock the
notification channels. Absent = the feature 503s/logs, the stack never
crashes.

**Verify the file parses the way the services will read it:**

```bash
node -e "require('dotenv').config({path:'.env'}); console.log(
  ['POSTGRES_PASSWORD','JWT_SECRET','INTERNAL_ASSERTION_PUBLIC_KEY'].filter(k=>!process.env[k]).length === 0 ? 'secrets OK' : 'MISSING VALUES'
)"
```

## Step 4 — Build and boot the whole stack (one command; first build ~15–30 min)

```bash
cd /opt/educore
docker compose -f docker/docker-compose.app.yml up -d --build
```

What that single command does, in order:

1. **postgres + redis** start (state volumes created),
2. the one-shot **migrate** container applies the control-plane migrations
   then the tenant migrations (`prisma migrate deploy` — pending-only, safe
   on every redeploy),
3. every app service **waits for `migrate` to exit 0** before booting,
4. the **gateway** comes up in compose mode (`UPSTREAM_HOST_STYLE=compose`)
   and resolves each upstream by container name,
5. **9 Node services, 3 Go engines, 2 Python services, web,
   admin-console** boot, and **Caddy** takes :80/:443 and obtains the
   Let's Encrypt certificate for `DOMAIN` automatically.

## Step 5 — Watch it come up (5 minutes)

```bash
docker compose -f docker/docker-compose.app.yml ps          # all "running"/"healthy"
docker compose -f docker/docker-compose.app.yml logs -f migrate   # migrations first
docker compose -f docker/docker-compose.app.yml logs -f api-gateway
```

Healthy signs: `migrate` prints `both databases up to date` and exits; the
gateway log shows route table + listener on 4000; `caddy` logs a certificate
issuance for your domain.

## Step 6 — Verify the deployment (5 minutes)

```bash
# From the server:
curl -s http://localhost/api/v1/health
curl -s https://erp.yourschools.in/api/v1/status | head -40

# From your laptop — the public surface:
open https://erp.yourschools.in
```

Then the **first-run wizard**: with a fresh database the web console walks
you through naming the school, creating the first branch and the owner
account (server-side empty-DB guard enforces this; the wizard is the only
way in). From there, configure in this order — each step feeds the next:

1. **Branch** (address, timings, geofence for staff self-attendance)
2. **Classes + sections** (the ladder every other module hangs off)
3. **Fee structures** (heads → amounts → the invoice engine)
4. **Staff** (principal first, then HODs/teachers; logins are emailed/WhatsApped)
5. **Students** (bulk import via the students page if migrating data)
6. **Timetable** (drag-and-drop builder; the constraint solver validates)

## Step 7 — Turn on the money and the messaging (per school, later)

| Feature | Where | Needs |
|---|---|---|
| Online fee checkout | `.env` → rebuild | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| WhatsApp/SMS/email | `.env` → `up -d` (no rebuild) | `WHATSAPP_*`, `SMS_*`, `SMTP_URL` |
| Phone push | `.env` → `up -d` | `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` |
| Late-fee automation | Fee-payments → Late Fees tab | slabs per branch; nightly sweep applies them |
| Backups | next section | 5 minutes |

## Step 8 — Nightly backups (5 minutes, do not skip)

`scripts/backup.sh` dumps **every** non-template database (custom format,
restore-verified) and tars the upload roots (photos/documents/logos), 14-night
retention, non-zero exit on any failure. On the Docker deployment:

```bash
# One-shot test run (adjust paths inside for /opt/educore + docker volume)
bash /opt/educore/scripts/backup.sh && tail -5 /opt/educore/backups/backup.log
```

Schedule it (host cron; the script is idempotent and logs its own progress):

```bash
crontab -e
# 02:30 nightly
30 2 * * * /bin/bash /opt/educore/scripts/backup.sh >> /opt/educore/backups/cron.log 2>&1
```

Restore procedure + the drill log live in `docs/BACKUPS.md`. **Do a restore
drill within the first week** — a backup that has never been restored is a
hope, not a backup.

## Step 9 — Monitoring (optional, 10 minutes, strongly recommended)

```bash
docker compose -f docker/docker-compose.yml \
               -f docker/docker-compose.staging.yml up -d pgbouncer prometheus grafana
```

Every app service publishes `/metrics` (scraped every 15 s); dashboards and
alert→runbook links are in `docs/ops/RUNBOOKS.md`. When connection counts
grow, point `DATABASE_URL` at pgbouncer (port 6432) instead of postgres.

## Day-2 operations cheat sheet

| Task | Command |
|---|---|
| Deploy new code | `git pull && docker compose -f docker/docker-compose.app.yml up -d --build` |
| Logs for one service | `docker compose -f docker/docker-compose.app.yml logs -f fee-service` |
| Restart one service | `docker compose -f docker/docker-compose.app.yml restart fee-service` |
| Postgres shell | `docker compose -f docker/docker-compose.app.yml exec postgres psql -U postgres school_erp` |
| Stop (data kept) | `docker compose -f docker/docker-compose.app.yml down` |
| **Destroy data** | `… down -v` ← never on production |
| Check everything is up | `docker compose -f docker/docker-compose.app.yml ps` |

## Where state lives (the volumes that ARE the deployment)

| Data | Volume |
|---|---|
| Both databases | `educore_postgres_data` |
| Photos + documents | `educore_staff_data` |
| School logos | `educore_provision_data` |
| TLS certificates | `educore_caddy_data` |

Everything else is stateless. `down` keeps all volumes; only `down -v` or
deleting the volume destroys school data.

## Troubleshooting quick table

| Symptom | Likely cause → fix |
|---|---|
| `up` refuses immediately | a `:?set` var missing → fill `POSTGRES_PASSWORD`, `JWT_SECRET`, `INTERNAL_ASSERTION_PUBLIC_KEY` in `.env` |
| Services restart-loop after boot | migrations failed → `logs migrate` first, always first |
| Certificate not issued | DNS A record not propagated, or :80 blocked → `dig +short $DOMAIN`, `ufw status` |
| 502 from a route | that upstream is unhealthy → `docker compose ps`, check the specific service's logs |
| `/files` route 502s | expected — no file-service container exists yet; the route is registered but unimplemented |
| Web loads but no data | `NEXT_PUBLIC_API_URL` baked wrong at build time → fix `.env`, `up -d --build web` |
| Password reset email never arrives | SMTP unset → set `SMTP_URL`, `up -d` |

## Scaling past one box (later, deliberately)

State is already isolated (postgres/redis/volumes); every app container is
stateless and movable. The gateway's `UPSTREAM_HOST_STYLE` switch
(`single-host` ↔ `compose`) is the seam for a Swarm/K8s port — upstreams
resolve by DNS either way. Don't reach for it until the metrics say so.

---

**Known first-build caveats** (also in DEPLOY.md): images were validated
statically on a machine without Docker; the first `up` on a real host may
surface platform-specific fixups. `NEXT_PUBLIC_*` is build-time inlined.
The admin console is loopback-only by default (`ADMIN_CONSOLE_PORT`) — reach
it through an SSH tunnel: `ssh -L 3100:127.0.0.1:3100 root@<server>`.
