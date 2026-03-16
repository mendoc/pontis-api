# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pontis is a self-hosted PaaS (Platform as a Service) — a Netlify/Vercel/Heroku alternative. This repository (`github.com/mendoc/pontis-api`) is the standalone Fastify backend API (Node.js 20), port 3001.

**Current status:** Phase 2 (authentication) is complete. Phase 3 (Static Sites) is next.

## Development Commands

All commands run from this directory (`/api`).

**Start local dependencies (PostgreSQL + Redis only):**
```bash
docker compose -f docker-compose.dev.yml up postgres redis -d
```

**Start full dev stack (deps + API container with hot-reload):**
```bash
docker compose -f docker-compose.dev.yml up -d
```

**API dev locally (hot-reload via ts-node-dev, loads .env):**
```bash
npm run dev
```

**Build (TypeScript → dist/):**
```bash
npm run build
```

**Tests — Vitest (TypeScript native, auto-discovery):**
```bash
npm test                                                              # run once
npm run test:watch                                                    # watch mode
npx vitest run src/__tests__/modules/auth.service.test.ts            # single file
npx vitest run --coverage                                             # with coverage
```

`NODE_ENV=test` and `BCRYPT_ROUNDS=1` are injected by `vitest.config.ts`. Tests are in `src/__tests__/{modules,routes,plugins,middleware}/`.

**Database:**
```bash
npm run db:migrate    # prisma migrate dev
npm run db:generate   # regenerate Prisma client after schema changes
npm run db:studio     # Prisma Studio GUI
```

**Environment:** create `.env` from `.env.example`. `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` are auto-generated at startup in dev if absent (warning printed); must be explicit in production.

## API Architecture (`src/`)

All routes are mounted under the `/api/v1` prefix.

- **`app.ts`** — Fastify app builder; accepts `prismaOverride` option (used in tests); registers plugins (cors, cookies, prisma, jwt) and mounts routes
- **`index.ts`** — entry point; binds to `0.0.0.0:3001`
- **`plugins/jwt.ts`** — RS256 access tokens (15 min) via `jsonwebtoken`; HS256 refresh tokens (7 days) stored as httpOnly `refresh_token` cookie; auto-generates ephemeral RSA keypair in dev
- **`plugins/prisma.ts`** — singleton PrismaClient decorated onto Fastify instance as `fastify.prisma`
- **`modules/auth/`** — auth module:
  - `auth.routes.ts` — register, login, refresh, logout, GitLab OAuth2 (`/auth/gitlab` + callback)
  - `auth.service.ts` — `AuthService` class; depends on `JwtOperations` interface (injected from jwt plugin)
  - `auth.schemas.ts` — Zod schemas for request bodies
  - `auth.errors.ts` — `AuthError` class with typed `AuthErrorCode` enum mapped to HTTP status codes
- **`middleware/authenticate.ts`** — Bearer token extractor; decorate protected routes with `{ preHandler: [authenticate] }`
- **`config/cookies.ts`** — shared cookie name (`REFRESH_COOKIE`) and options (`cookieOpts`)

## Testing Patterns

**`src/__tests__/helpers/build.ts`** exports `buildTestApp({ prisma?, onRegister? })` which:
- Sets JWT env vars to a pre-generated 2048-bit RSA test keypair
- Calls `buildApp({ prismaOverride })` with a mock or real Prisma client
- Returns a fully-initialized Fastify instance (no real network binding needed — use `app.inject()`)

**`src/__tests__/helpers/prisma.ts`** exports `makeMockPrisma(methods?)` — builds a typed partial mock of PrismaClient. Only `user` and `refreshToken` models are mocked; extend as new modules are added.

Pattern for route tests: use `app.inject()`, never start a real server. Pattern for service tests: instantiate `AuthService` directly with a mock Prisma and mock `JwtOperations`.

## Data Model

| Table | Key fields |
|---|---|
| `users` | id (uuid), email (unique), passwordHash?, gitlabId?, gitlabToken?, createdAt |
| `refresh_tokens` | id, userId, familyId, tokenHash (unique), expiresAt, revokedAt? |
| `projects` | id, userId, name, slug (unique), type (git\|static), domain?, status, port? |
| `deployments` | id, projectId, commitSha?, status (pending\|building\|success\|failed), logs? |
| `env_vars` | id, projectId, key, valueEncrypted |
| `ports` | id, portNumber (unique), projectId (unique), allocatedAt |

Refresh tokens use a **token family** pattern: reusing a revoked token revokes all tokens in the same family (reuse detection). Port allocation range: **10000–60000**.

## Infrastructure & Architecture

All services share a single Docker bridge network `pontis_network`. Traefik is the only component exposed to the internet; it routes to containers via Docker labels. `exposedByDefault: false` — only containers with `traefik.enable=true` are routed.

**Deployed app pattern** (generated per project by the worker):
```
projet-slug/
├── docker-compose.yml   # service always named "app", Traefik labels carry the slug
├── Dockerfile
└── server.js
```

**Blue/green deployment:** start new container → poll `/health` for HTTP 200 (30s timeout) → switch Traefik labels → stop old container. On timeout: rollback, mark deployment `failed`.

## Security Invariants

- Never mount `/var/run/docker.sock` in user project containers — only Traefik and the Pontis API get this.
- JWT: RS256 access token (15 min), HS256 refresh token (7 days, httpOnly/Secure cookie).
- User env vars: encrypted AES-256-GCM before storing; injected at container start via `--env-file`; never logged.
- Every deployed project container runs as non-root.

## Development Roadmap

- **Phase 1 — Infrastructure** ✅
- **Phase 2 — Authentication** ✅ Prisma schema, JWT + GitLab OAuth2
- **Phase 3 — Static Sites** — project CRUD, file upload, Nginx container per project
- **Phase 4 — GitLab Build Pipeline** — Nixpacks, blue/green, real-time WebSocket logs
- **Phase 5 — Auto CI/CD** — GitLab push webhooks, BullMQ async jobs
- **Phase 6 — Observability** — container logs/metrics, rollback
