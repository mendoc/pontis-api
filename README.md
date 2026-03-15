# Pontis

PaaS auto-hébergé — alternative à Netlify/Vercel/Heroku avec souveraineté totale sur les données, l'infrastructure et les coûts.

## Prérequis

- Docker Engine 29+
- `cp .env.example .env` et remplir les variables (voir ci-dessous)

## Démarrage rapide (dev)

Copier et remplir les variables d'environnement :

```bash
cp .env.example .env
```


Démarrer postgres, redis et l'API (migrations automatiques au démarrage) :

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Ouvrir un shell dans le conteneur API :

```bash
docker compose -f docker-compose.dev.yml exec api sh
```

Une fois dans le shell, lancer l'API en hot-reload → http://localhost:3001 :

```sh
npm run dev:docker
```


Exécuter les tests :

```sh
npm test
```

Créer une nouvelle migration Prisma :

```sh
npm run db:migrate
```

Ouvrir Prisma Studio :

```sh
npm run db:studio
```

Quitter le shell (les autres conteneurs restent actifs) :

```sh
exit
```

## Variables d'environnement

| Variable | Description |
|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credentials PostgreSQL |
| `DATABASE_URL` | URL de connexion Prisma (host : `localhost` hors Docker, ignorée dans Docker) |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | Clés RS256 — auto-générées en dev, **obligatoires en prod** |
| `JWT_REFRESH_SECRET` | Secret HMAC pour les refresh tokens |
| `GITLAB_URL` / `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` / `GITLAB_CALLBACK_URL` | OAuth2 GitLab CE (optionnel en dev) |
| `GHCR_TOKEN` | Token GitHub (`write:packages`) pour pousser l'image sur GHCR |

Générer les clés JWT pour la production :

```bash
./scripts/gen-jwt-keys.sh >> .env
```

## Déploiement (GHCR)

Définir le token GitHub avec les droits `write:packages` :

```bash
export GHCR_TOKEN=ghp_xxx
```

Builder et pousser l'image API sur `ghcr.io/mendoc/pontis-api` :

```bash
npm run deploy:api
```

L'image est taguée avec la version du `package.json` **et** `:latest`.

## Commandes utiles

Reconstruire l'image API (après changement de dépendances) :

```bash
docker compose -f docker-compose.dev.yml up -d --build api
```

Voir les logs de l'API :

```bash
docker compose -f docker-compose.dev.yml logs -f api
```

Tout arrêter :

```bash
docker compose -f docker-compose.dev.yml down
```

Tout arrêter et effacer les volumes (base de données incluse) :

```bash
docker compose -f docker-compose.dev.yml down -v
```

## Structure du monorepo

```
/api      — Fastify backend (Node.js 20), port 3001  ✅ implémenté
/web      — Next.js 14 dashboard (App Router + Tailwind)  🔜 prévu
/worker   — BullMQ worker (jobs de build)  🔜 prévu
```
