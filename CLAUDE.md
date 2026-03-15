# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pontis is a self-hosted PaaS (Platform as a Service) — a Netlify/Vercel/Heroku alternative with full sovereignty over data, infrastructure, and costs. Every project is deployed as its own Docker container, reachable at `<slug>.app.ongoua.pro` with automatic HTTPS via Let's Encrypt DNS-01.

**Current status:** Phase 2 (authentication + monorepo) is complete. Phase 3 (Static Sites) is next.

## Monorepo Structure

```
/api      — Fastify backend (Node.js 20), port 3001  ✅ implemented
/webhook  — GitHub webhook receiver (Node.js, no deps), port 9000  ✅ implemented
/web      — Next.js 14 dashboard (App Router + Tailwind CSS)  🔜 planned
/worker   — BullMQ background worker (build jobs)  🔜 planned
```

## Development Commands

**Start local dependencies (PostgreSQL + Redis):**
```bash
docker compose -f docker-compose.dev.yml up -d
```

**API development (from repo root or /api):**
```bash
npm run dev:api          # hot-reload via ts-node-dev, loads ../.env
cd api && npm run dev    # same, from inside /api
```

**Build:**
```bash
npm run build:api        # from root
cd api && npm run build  # TypeScript → dist/
```

**Tests — Vitest (TypeScript natif, découverte automatique) :**
```bash
cd api && npm test                                                        # run once
cd api && npm run test:watch                                              # watch mode
cd api && npx vitest run src/__tests__/modules/auth.service.test.ts     # single file
```
`NODE_ENV=test` et `BCRYPT_ROUNDS=1` sont injectés par `vitest.config.ts`. Le helper `api/src/__tests__/helpers/build.ts` crée une instance Fastify en mémoire via `buildApp({ prismaOverride })` avec une paire RSA 2048 bits de test ; `helpers/prisma.ts` fournit une factory de mock Prisma.

Tests organisés en `src/__tests__/{modules,routes,plugins,middleware}/`.

**Database:**
```bash
cd api && npm run db:migrate    # prisma migrate dev
cd api && npm run db:generate   # regenerate Prisma client after schema changes
cd api && npm run db:studio     # Prisma Studio GUI
```

**Environment:** copy `.env.example` → `.env` at repo root. `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` are auto-generated at startup in dev if absent (a warning is printed); they must be set explicitly in production.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router) + Tailwind CSS |
| Backend API | Node.js 20 + Fastify + Zod |
| Database | PostgreSQL 16 + Prisma ORM |
| Cache & Queues | Redis 7 + BullMQ |
| Containers | Docker Engine 29.x + Docker SDK (node) |
| Reverse Proxy | Traefik v3 (dynamic config via Docker labels) |
| SSL | Let's Encrypt wildcard via ACME DNS-01 (Porkbun) |
| Auth | GitLab OAuth2 (custom implementation via undici) + JWT RS256 (email/password) |
| Build detection | Nixpacks |

## Architecture

All services (Pontis internals + every deployed user app) share a single Docker bridge network named `pontis_network`. This network is created once by the main Pontis Docker Compose and referenced as `external: true` by each deployed app's compose file.

**Core services (main docker-compose.yml):**
- `traefik` — only component exposed to the internet (ports 80/443); routes traffic to all containers via Docker labels; handles Let's Encrypt DNS-01 via Porkbun API
- `api` — Fastify backend; has access to `/var/run/docker.sock` (read-only) to manage containers
- `postgres` — internal only, never exposed via Traefik
- `redis` — internal only

**Deployed app pattern** (generated per project by the worker):
```
projet-slug/
├── docker-compose.yml   # service always named "app", Traefik labels carry the slug
├── Dockerfile
└── server.js            # or other entrypoint
```

Traefik label uniqueness is enforced by slug (stored in PostgreSQL), not by the Docker service name.

## Data Model

| Table | Key fields |
|---|---|
| `users` | id, email, password_hash, gitlab_id, gitlab_token, created_at |
| `refresh_tokens` | id, user_id, family_id, token_hash, expires_at, revoked_at |
| `projects` | id, user_id, name, slug, type (git\|static), domain, port, status |
| `deployments` | id, project_id, commit_sha, status (pending\|building\|success\|failed), logs, created_at |
| `env_vars` | id, project_id, key, value_encrypted |
| `ports` | id, port_number, project_id, allocated_at |

Refresh tokens use a **token family** pattern: reusing a revoked token revokes all tokens in the same family (reuse detection).

Port allocation range: **10000–60000**, tracked in the `ports` table.

## Build Pipeline

1. Clone repo from GitLab CE via API
2. Nixpacks detects runtime (package.json, requirements.txt, etc.)
3. Build Docker image
4. Push to local Docker registry (`registry.local/<slug>:<commit-sha>`)
5. Blue/green deployment + Traefik label switch

**Blue/green sequence:** start new container on port N+1 → poll `/health` for HTTP 200 (30s timeout) → switch Traefik labels → stop old container. On timeout: rollback, mark deployment `failed`.

## Security Invariants

- **Never** mount `/var/run/docker.sock` in user project containers — only Traefik and the Pontis API worker get this mount.
- `exposedByDefault: false` in traefik.yml — only containers with `traefik.enable=true` label are routed.
- PostgreSQL and Redis are on `pontis_network` only, no Traefik labels, never reachable from outside.
- JWT: RS256, access token 15 min, refresh token 7 days (httpOnly/Secure cookie).
- User env vars: encrypted AES-256-GCM before storing in database; injected at container start via `--env-file`; never logged or shown in UI after entry.
- Porkbun API keys are environment variables on the host, never committed.
- Every deployed project container runs as non-root.

## Webhook Service (`/webhook/`)

Minimal GitHub webhook receiver — zero external dependencies, pure Node.js stdlib.

- **Route:** `POST /deploy/:slug` — verifies `X-Hub-Signature-256` HMAC-SHA256, ignores non-default-branch pushes, then: fetches `docker-compose.yml` (or `compose.yml`) from the GitHub repo's raw content, writes it to `$APPS_DIR/<slug>/`, then runs `docker compose pull` + `docker compose up -d` + `docker image prune -f`.
- **Concurrency guard:** one deploy at a time per slug (in-memory `Set`); duplicate pushes are silently skipped.
- **Required env vars:** `GITHUB_WEBHOOK_SECRET`, `APPS_DIR` (path to the directory containing per-app subdirs).
- **Optional env vars:** `GITHUB_TOKEN` (required for private repos), `PATHS_CONFIG` (path to a JSON file mapping `slug → custom project dir`, overrides `$APPS_DIR/<slug>`).
- **Run:** `node server.js` (no build step). Deployed via its own `docker-compose.yml` in `/webhook/`.

## API Architecture (`/api/src/`)

All routes are mounted under the `/api/v1` prefix.

- **`app.ts`** — Fastify app builder; accepts `prismaOverride` option (used in tests); registers plugins (cors, cookies, prisma, jwt) and mounts routes
- **`index.ts`** — entry point; binds to `0.0.0.0:3001`
- **`plugins/jwt.ts`** — RS256 access tokens (15 min) via `jsonwebtoken`; HS256 refresh tokens (7 days) stored as httpOnly `refresh_token` cookie; auto-generates ephemeral RSA keypair in dev
- **`plugins/prisma.ts`** — singleton PrismaClient decorated onto Fastify instance
- **`modules/auth/`** — auth module split into four files:
  - `auth.routes.ts` — register, login, refresh, logout, GitLab OAuth2 (`/auth/gitlab` + callback)
  - `auth.service.ts` — `AuthService` class; depends on `JwtOperations` interface (injected from jwt plugin)
  - `auth.schemas.ts` — Zod schemas for request bodies
  - `auth.errors.ts` — `AuthError` class with typed `AuthErrorCode` enum
- **`middleware/authenticate.ts`** — Bearer token extractor; throws 401 on missing/invalid/expired token; decorate protected routes with `{ preHandler: [authenticate] }`

## Development Roadmap

- **Phase 1 — Infrastructure** ✅ Validated in production
- **Phase 2 — Authentication** ✅ monorepo init, Prisma schema, JWT + GitLab OAuth2
- **Phase 3 — Static Sites** — project CRUD, file upload, Nginx container per project
- **Phase 4 — GitLab Build Pipeline** — Nixpacks, blue/green, real-time WebSocket logs
- **Phase 5 — Auto CI/CD** — GitLab push webhooks, BullMQ async jobs
- **Phase 6 — Observability** — container logs/metrics from dashboard, rollback

## Production Environment

- OS: Debian 6.1.0-43-cloud-amd64
- Docker: Engine 29.3.0
- Domain: `*.app.ongoua.pro` — single wildcard DNS A record (Porkbun) pointing to server IP
- SSL: wildcard cert requires DNS-01 challenge (HTTP-01 cannot issue wildcards)
