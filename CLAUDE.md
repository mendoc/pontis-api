# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pontis is a self-hosted PaaS (Platform as a Service) — a Netlify/Vercel/Heroku alternative. This repository (`github.com/mendoc/pontis-api`) is the standalone Fastify backend API (Node.js 20), port 3001.

**Current status:** Phase 3 (Static Sites) is largely complete — project CRUD, ZIP upload, Nginx container deployment, versioned deployments, rollback, and persistent compose files are implemented. Role/permission system (`developer`/`admin`) is implemented. Blue/green and GitLab pipeline are next.

## Development Commands

All commands run from this directory (`/api`).

**Start local dependencies (PostgreSQL + Redis + Mailpit) :**
```bash
docker compose -f docker-compose.dev.yml up postgres redis mailpit -d
```
Mailpit est le serveur SMTP de développement — UI sur http://localhost:8025, SMTP sur port 1025.

**Start full dev stack avec hot-reload automatique (recommandé) :**
```bash
docker compose -f docker-compose.dev.yml watch
```
`watch` synchronise `src/` dans le container à chaque modification (ts-node-dev redémarre seul) et rebuild l'image si `package.json`, `package-lock.json` ou `Dockerfile.dev` changent. C'est la commande à utiliser en développement — évite de devoir rebuild manuellement.

**Démarrer sans watch (pas de hot-rebuild sur package.json) :**
```bash
docker compose -f docker-compose.dev.yml up -d
```

**Rebuild de l'image dev (après mise à jour du code ou de package.json) :**
```bash
docker compose -f docker-compose.dev.yml up -d --build
```
Le `Dockerfile.dev` copie `node_modules/` depuis l'hôte et exécute `npm rebuild` pour recompiler les modules natifs (bcrypt, etc.) pour la plateforme glibc du container. Si le volume `api_api_node_modules` est corrompu ou obsolète, le supprimer avec `docker volume rm api_api_node_modules` avant de relancer.

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
- **`plugins/jwt.ts`** — RS256 access tokens (15 min) via `jsonwebtoken`; HS256 refresh tokens (7 days) stored as httpOnly `refresh_token` cookie; auto-generates ephemeral RSA keypair in dev; `JwtPayload` inclut `role: 'developer' | 'admin'`
- **`plugins/prisma.ts`** — singleton PrismaClient decorated onto Fastify instance as `fastify.prisma`
- **`plugins/docker.ts`** — Dockerode instance decorated onto Fastify as `fastify.docker`; connects via `/var/run/docker.sock`
- **`modules/auth/`** — auth module:
  - `auth.routes.ts` — register, login, refresh, logout, GitLab OAuth2 (`/auth/gitlab` + callback), **password reset flow** (`POST /auth/forgot-password` → `POST /auth/verify-reset-code` → `POST /auth/reset-password`)
  - `auth.service.ts` — `AuthService` class; depends on `JwtOperations` interface (injected from jwt plugin); `requestPasswordReset()` génère un code 6 chiffres haché, `verifyResetCode()` valide sans le consommer, `resetPassword()` réinitialise le mot de passe et révoque tous les refresh tokens
  - `auth.schemas.ts` — Zod schemas for request bodies (incl. `ForgotPasswordBody`, `VerifyResetCodeBody`, `ResetPasswordBody`)
  - `auth.errors.ts` — `AuthError` class with `AuthErrorCode` enum (incl. `EMAIL_NOT_FOUND`, `RESET_CODE_INVALID`, `RESET_CODE_EXPIRED`, `SSO_ACCOUNT_RESET_NOT_ALLOWED`)
- **`modules/projects/`** — projects module (Phase 3):
  - `projects.routes.ts` — `GET /check-slug`, `POST /` (multipart ZIP upload, 50 MB limit), `GET /`, `GET /:id`, `PATCH /:id` (rename), `DELETE /:id`, `POST /:id/start|stop|restart`, `POST /upload/init|chunk|finalize|redeploy`, `GET|DELETE /:id/deployments`, `GET /:id/deployments/:deploymentId`, `POST /:id/deployments/:deploymentId/rollback`; routes de debug (dev) : `GET|POST /:id/debug/container-inspect|stop|remove|create|start`; all protected by `authenticate`
  - `projects.service.ts` — `ProjectsService` class; `createProject` et `redeployProject` créent un `Deployment` (status `building`) et lancent `buildAndRunStaticProject` en fire-and-forget; à la réussite, l'image est taguée `:deploy-{deploymentId}` (imageTag) et `currentDeploymentId` est mis à jour; `rollbackDeployment` recrée le container depuis l'imageTag du déploiement cible; `listProjects` inclut `lastDeployedAt` (dernier déploiement); `deleteProject` supprime toutes les images versionnées (`pontis-{slug}:*`); `restartProject` utilise `remove({ force: true })` puis recrée depuis `:latest`; `listProjects` supporte pagination, recherche avec normalisation des accents, tri
  - `projects.schemas.ts` — Zod schemas for project bodies
  - `projects.errors.ts` — `ProjectError` with `ProjectErrorCode` enum (incl. `DEPLOYMENT_NOT_FOUND`, `DEPLOYMENT_IN_USE`, `DEPLOYMENT_BUILDING`)
- **`lib/static-builder.ts`** — core deployment logic: extract ZIP → normalize directory structure (handles macOS `__MACOSX` artifacts and single-subdirectory ZIPs) → build `nginx:alpine` Docker image (tagged `:latest` + `:deploy-{deploymentId}`) → create & start container with Traefik labels → write `docker-compose.yml` via `compose-writer`. Captures timestamped build logs. Uses env vars `APP_DOMAIN` (default `app.ongoua.pro`) and `DOCKER_NETWORK` (default `pontis_network`).
- **`lib/compose-writer.ts`** — writes `${PROJECTS_DIR}/${slug}/docker-compose.yml` after each successful deployment; `removeProjectDir` called on project deletion. `PROJECTS_DIR` defaults to `/var/lib/pontis/projects` (must be bind-mounted in the API container).
- **`lib/mailer.ts`** — email via nodemailer; `sendPasswordResetEmail()` envoie un code 6 chiffres valable 15 min; en dev pointe vers Mailpit (SMTP localhost:1025)
- **`lib/hash.ts`** — bcrypt helpers
- **`middleware/authenticate.ts`** — Bearer token extractor; decorate protected routes with `{ preHandler: [authenticate] }`
- **`middleware/requirePermission.ts`** — factory `requirePermission(permission)` → preHandler qui renvoie 403 si le rôle JWT n'a pas la permission; toujours placé après `authenticate`
- **`config/cookies.ts`** — shared cookie name (`REFRESH_COOKIE`) and options (`cookieOpts`)
- **`config/permissions.ts`** — type `Permission`, `ROLE_PERMISSIONS` map, `hasPermission(role, permission)`; `developer` a toutes les permissions `projects:*` sauf `projects:debug`; `admin` a toutes les permissions
- **`modules/users/`** — gestion des utilisateurs (admin only) :
  - `users.routes.ts` — `GET /users` (liste paginée avec recherche/tri, requiert `users:list`), `PATCH /users/:id/role` (change le rôle, empêche l'auto-modification et garantit au moins un admin, requiert `users:update`), `PATCH /users/:id/block` (bloque/débloque, révoque tous les refresh tokens si blocage, requiert `users:update`)
- **`modules/admin/`** — vues transversales (admin only) :
  - `admin.routes.ts` — `GET /admin/projects` (liste paginée de tous les projets toutes origines confondues, recherche sur name/slug/domain/email propriétaire, requiert `users:list`)

## Testing Patterns

**`src/__tests__/helpers/build.ts`** exports `buildTestApp({ prisma?, onRegister? })` which:
- Sets JWT env vars to a pre-generated 2048-bit RSA test keypair
- Calls `buildApp({ prismaOverride })` with a mock or real Prisma client
- Returns a fully-initialized Fastify instance (no real network binding needed — use `app.inject()`)

**`src/__tests__/helpers/prisma.ts`** exports `makeMockPrisma(methods?)` — builds a typed partial mock of PrismaClient. Only `user` and `refreshToken` models are mocked; extend with `project` (and others) as new modules are added.

Pattern for route tests: use `app.inject()`, never start a real server. Pattern for service tests: instantiate `AuthService` directly with a mock Prisma and mock `JwtOperations`.

## Data Model

| Table | Key fields |
|---|---|
| `users` | id (uuid), email (unique), name?, passwordHash?, gitlabId?, gitlabToken?, role (developer\|admin), blocked (bool), createdAt |
| `refresh_tokens` | id, userId, familyId, tokenHash (unique), expiresAt, revokedAt? |
| `password_reset_codes` | id, userId, codeHash, expiresAt, usedAt?, createdAt |
| `projects` | id, userId, name, slug (unique), type (git\|static), domain?, status, restartedAt?, currentDeploymentId?, createdAt, port? |
| `deployments` | id, projectId, commitSha?, status (pending\|building\|success\|failed), logs?, imageTag?, createdAt, finishedAt? |
| `env_vars` | id, projectId, key, valueEncrypted |
| `ports` | id, portNumber (unique), projectId (unique), allocatedAt |

Refresh tokens use a **token family** pattern: reusing a revoked token revokes all tokens in the same family (reuse detection). Port allocation range: **10000–60000**.

## Infrastructure & Architecture

All services share a single Docker bridge network `pontis_network`. Traefik is the only component exposed to the internet; it routes to containers via Docker labels. `exposedByDefault: false` — only containers with `traefik.enable=true` are routed.

**Deployed app pattern** — après chaque déploiement réussi, `compose-writer` crée :
```
${PROJECTS_DIR}/${slug}/
└── docker-compose.yml   # service "app", Traefik labels, réseau externe pontis_network
```
Le volume `${PROJECTS_DIR}:${PROJECTS_DIR}` est bind-monté symétrique dans le container API (voir `docker-compose.dev.yml`).

**Versioning des images** — chaque déploiement réussi crée deux tags : `pontis-{slug}:latest` (courant) et `pontis-{slug}:deploy-{deploymentId}` (archivé, stocké dans `deployment.imageTag`). Le rollback recrée le container depuis l'imageTag archivé.

**Blue/green deployment (à implémenter):** start new container → poll `/health` for HTTP 200 (30s timeout) → switch Traefik labels → stop old container. On timeout: rollback, mark deployment `failed`.

## Security Invariants

- Never mount `/var/run/docker.sock` in user project containers — only Traefik and the Pontis API get this.
- JWT: RS256 access token (15 min), HS256 refresh token (7 days, httpOnly/Secure cookie).
- User env vars: encrypted AES-256-GCM before storing; injected at container start via `--env-file`; never logged.
- Every deployed project container runs as non-root.

## Release Workflow

### Au quotidien — développement

```bash
git add <fichiers>
git commit -m "feat|fix|chore: description"  # les tests s'exécutent automatiquement
git push                                      # push sur main ne déclenche PAS GHCR
```

Un hook `pre-commit` (`.githooks/pre-commit`) lance `npm test` automatiquement avant chaque commit et bloque si un test échoue. Il est activé via le script `prepare` au `npm install`. Après un clone, `npm install` suffit à l'activer.

### Publier une version sur GHCR

```bash
npm run release:patch   # bug fix
npm run release:minor   # nouvelle fonctionnalité
npm run release:major   # breaking change
```

Chaque commande bumpe `package.json`, commite, crée le tag et push — le workflow GitHub Actions se déclenche automatiquement. Le hook `pre-commit` lance les tests au moment du commit de bump ; si les tests échouent, le release est annulé.

### En production — après que le workflow GHCR est vert

Un webhook écoute les push d'images sur GHCR et redéploie automatiquement — aucune commande manuelle nécessaire. L'entrypoint du container applique `prisma migrate deploy` au démarrage.

### Règles à respecter

- **Les tests s'exécutent automatiquement au commit** via le hook `pre-commit` — ne rien bypasser avec `--no-verify`
- **Utiliser `npm run release:*` pour publier** — ne jamais créer de tag manuellement
- **Ne jamais re-pousser un tag existant** — créer un nouveau tag patch à la place
- **Les migrations doivent être commitées avant le tag** — sinon elles sont absentes de l'image
- **`prisma migrate dev` en local, `prisma migrate deploy` en prod** — `dev` crée les migrations, `deploy` les applique

## Project Types

### Type `static` (implémenté)
ZIP uploadé → extraction → build image `nginx:alpine` → container avec labels Traefik. Limite 50 Mo.

### Type `docker` (prochain)
ZIP uploadé → extraction (sans `vendor/`) → `docker build` depuis le `Dockerfile` de l'utilisateur → container avec labels Traefik injectés par Pontis.

**Décisions arrêtées :**
- Pas de limite de taille fixe (ou beaucoup plus grande) — les sources Laravel sont légères, c'est l'image buildée qui est lourde
- Le dossier `vendor/` est exclu/ignoré à l'extraction — inutile pour le build (composer install dans le Dockerfile)
- Port interne par défaut : **8000** (configurable à la création du projet)
- Health check par défaut : **`/health`** (configurable à la création du projet)
- Les **labels Traefik sont injectés par Pontis** dans le `docker run`, pas dans le Dockerfile utilisateur
- Volume nommé persistant monté sur `/var/www/html/storage` (ou chemin configurable) pour `storage/` Laravel
- Env vars : l'utilisateur les saisit une à une **ou** colle le contenu de son `.env` → converti en formulaire prérempli avec les valeurs modifiables avant validation
- Port hôte alloué dynamiquement depuis la table `ports` (range 10000–60000), injecté comme variable `PORT` dans le container
- Même système de versioning d'images que les sites statiques (`:latest` + `:deploy-{deploymentId}`)
- Même rollback que les sites statiques (recréer le container depuis l'imageTag archivé)

**Champ `internalPort`** à ajouter sur le modèle `projects` (default `8000`).
**Champ `healthcheckPath`** à ajouter sur le modèle `projects` (default `/health`).

### Type `compose` (phase ultérieure — décisions architecturales)

L'utilisateur fournit un ZIP contenant :
- `docker-compose.yml` — son fichier standard, inchangé
- `pontis.yml` — déclaration minimale spécifique à Pontis

```yaml
# pontis.yml (à la racine du ZIP)
expose:
  service: app        # doit correspondre au nom d'un service dans docker-compose.yml
  port: 8000          # port interne du service exposé
  healthcheck: /health
```

**Comportement de Pontis :**
1. Parse `docker-compose.yml` et vérifie que le service `app` (ou celui déclaré dans `pontis.yml`) existe
2. Génère un fichier `pontis-override.yml` qui ajoute :
   - Labels Traefik sur le service exposé uniquement
   - Connexion au réseau externe `pontis_network` pour le service exposé uniquement
   - Réseau interne isolé par projet (`pontis-{slug}`) pour tous les services (isolation inter-projets)
   - Driver de logs Loki sur tous les services avec labels `project={slug}, service={name}`
3. Lance via `docker compose -f docker-compose.yml -f pontis-override.yml up -d`
4. Les autres services (db, redis, worker…) restent sur le réseau interne uniquement — non exposés

**Isolation réseau :**
```
pontis_network (bridge partagé) — Traefik uniquement
pontis-{slug} (bridge isolé)    — tous les services du projet
```
Deux projets peuvent avoir un service `db` sur le port 5432 sans conflit (réseaux séparés).

**Monitoring (Prometheus) :** géré par Pontis, pas par le développeur.
- cAdvisor scrappe les métriques Docker de chaque container (CPU, RAM, réseau)
- Labels Prometheus injectés dans l'override pour le service exposé
- Si le dev expose un `/metrics`, Pontis configure le scraping automatiquement

**Logs (Loki) :** branchés via l'override, configurés dans la phase compose.

**Ce que Pontis ne fait pas avec le compose :**
- Ne remplace pas le `docker-compose.yml` de l'utilisateur
- Ne provisionne pas de base de données — `DATABASE_URL` est une env var comme les autres
- Ne gère pas le scaling (pas de Swarm/K8s) — l'utilisateur utilise `numprocs` dans supervisord si besoin

## Development Roadmap

- **Phase 1 — Infrastructure** ✅
- **Phase 2 — Authentication** ✅ Prisma schema, JWT + GitLab OAuth2 + password reset flow
- **Phase 3 — Static Sites** ⚙️ Largely done — project CRUD, chunked ZIP upload, Nginx deployment, versioned deployments (imageTag), rollback, persistent compose files, role/permission system; blue/green pending
- **Phase 4 — Docker (Dockerfile)** — type `docker`, upload ZIP sans vendor/, build depuis Dockerfile user, env vars via formulaire ou paste .env, port 8000 + healthcheck /health configurables, labels Traefik injectés par Pontis, volume storage persistant, blue/green
- **Phase 5 — Compose** — type `compose`, pontis.yml + override généré, isolation réseau par projet, Loki logs
- **Phase 6 — Observability** — Prometheus + cAdvisor, Grafana par projet, métriques container
- **Phase 7 — CI/CD** — GitLab push webhooks, BullMQ async jobs, pipeline Nixpacks
