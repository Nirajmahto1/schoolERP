# Deploying EduCore — the one-command walkthrough

> Target shape: **one VPS** (4 vCPU / 8 GB is comfortable for a fleet of small
> schools), Docker + Compose plugin, a domain with an A record pointing at it.
> This is the same single-node economics the build plan assumes — no
> Kubernetes until the fleet forces a second node.

## 0. Prerequisites (once per server)

```bash
# Ubuntu 22.04/24.04
curl -fsSL https://get.docker.com | sh        # Docker Engine + compose plugin
ufw allow 80,443/tcp && ufw allow 22/tcp && ufw enable   # 4000 stays internal
```

Get the code and its secrets:

```bash
git clone <your-repo-url> educore && cd educore
cp .env.example .env
```

Fill **at minimum** in `.env` (every `:?set …` var makes the stack refuse to
boot without it — that is deliberate):

| Variable | What |
|---|---|
| `POSTGRES_PASSWORD` | DB superuser password — generate: `openssl rand -base64 24` |
| `JWT_SECRET` | auth token signing key — generate the same way |
| `INTERNAL_ASSERTION_PUBLIC_KEY` / `_PRIVATE_KEY` | service-to-service assertion keypair (see §4 of `.env.example`) |
| `RAZORPAY_KEY_ID/SECRET` | live fee collection (skip to start without payments) |
| `WHATSAPP_*, SMS_*, SMTP_URL, FCM_*` | notification channels (all optional; absent = feature degrades, never crashes) |

## 1. Boot

```bash
docker compose -f docker/docker-compose.app.yml up -d --build
```

One command. Compose:

1. starts **postgres + redis**,
2. runs the one-shot **migrate** container (control-plane DB, then tenant DB —
   `prisma migrate deploy`, pending-only, safe on every redeploy),
3. every service **waits for migrations to complete** before booting
   (`service_completed_successfully` gates),
4. brings up the gateway, 9 Node services, 3 Go engines, 2 Python services,
   web + admin-console, and the **Caddy edge** on :80/:443.

First build takes a while (per-service `npm ci` + turbo builds are cached in
layers — later builds are fast).

Watch it come up:

```bash
docker compose -f docker/docker-compose.app.yml ps
docker compose -f docker/docker-compose.app.yml logs -f api-gateway
```

## 2. Verify

```bash
curl -s https://$DOMAIN/api/v1/health          # or http://<server-ip>/api/v1/health
curl -s https://$DOMAIN/api/v1/status | head   # per-service aggregation
open https://$DOMAIN                           # web console → first-run setup wizard
```

No school exists on a fresh database, so the web app walks you through
**naming the school, creating the first branch and the owner account** — the
same wizard proven on the setup DB. From there: branches → staff → classes →
students → fees, all in the console.

> **DNS/TLS:** set `DOMAIN=erp.yourschools.in` in `.env` and Caddy obtains the
> Let's Encrypt certificate automatically on boot. Without `DOMAIN` everything
> works over plain HTTP on :80 (fine for a LAN trial; never for production).

## 3. Day-2 operations

| Task | Command |
|---|---|
| Deploy new code | `git pull && docker compose -f docker/docker-compose.app.yml up -d --build` |
| Watch logs | `docker compose -f docker/docker-compose.app.yml logs -f <service>` |
| Restart one service | `docker compose -f docker/docker-compose.app.yml restart fee-service` |
| Postgres backup | the nightly dump script (`docs/ops/restore-drill-log.md`) — point it at the `postgres_data` volume's container |
| Enter DB | `docker compose -f docker/docker-compose.app.yml exec postgres psql -U postgres school_erp` |
| Stop everything (data kept) | `docker compose -f docker/docker-compose.app.yml down` |
| **Destroy data too** | `… down -v` ← deletes the volumes; never on production |

### Where state lives

| Data | Volume |
|---|---|
| Both databases | `educore_postgres_data` |
| Photos + documents | `educore_staff_data` (staff-service `data/`) |
| School logos | `educore_provision_data` |
| TLS certificates | `educore_caddy_data` |

Everything else is stateless containers — replaceable, re-buildable, no
`docker commit` snowballs.

### Monitoring

The Phase-11 ops plane is a separate overlay on the same network:

```bash
docker compose -f docker/docker-compose.yml \
               -f docker/docker-compose.staging.yml up -d pgbouncer prometheus grafana
```

Every app service already publishes `/metrics` (Prometheus scrapes them via
`docker/prometheus.yml`); alert rules and runbook links live in
`docs/ops/RUNBOOKS.md`. When connection counts grow, point `DATABASE_URL` at
the pgbouncer port (6432) instead of postgres directly.

## 4. Scaling past one box (later, not now)

The split is already clean: state (postgres/redis/volumes) is pinned to the
compose file's services; every app service is a stateless container that can
move to a second host behind a load balancer. The gateway's
`UPSTREAM_HOST_STYLE=single-host|compose` switch is the seam — a Swarm/K8s
port resolves upstreams by DNS name either way. Don't reach for this until
the metrics say so.

---

**Build notes / first-build caveats**

- Images build from the repo root (`Dockerfile.service`, `Dockerfile.nextjs`,
  `Dockerfile.db-migrate`) or the engine dir itself (`Dockerfile.go-engine`,
  `Dockerfile.python`); `.dockerignore` files keep secrets and `node_modules`
  out of every context.
- `NEXT_PUBLIC_*` values are **build-time** inlined (Next.js semantics):
  changing `NEXT_PUBLIC_API_URL` means rebuilding `web`/`admin-console`.
- The gateway's `/files` route targets a `file-service` that is not
  implemented yet — it 502s harmlessly; no container exists for it.
- This stack was validated statically (compose config parse, per-image
  contracts, gateway route matrix) on a machine without Docker; the first
  `up` on a real host may surface platform-specific fixups — treat them as
  build log noise, not design errors.
