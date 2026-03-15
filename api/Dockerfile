FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY api/package*.json ./
COPY api/prisma ./prisma/

# --ignore-scripts skips postinstall (prisma migrate deploy needs a running DB — handled at startup)
RUN npm pkg delete scripts.postinstall && npm install

RUN npx prisma generate

# tsconfig.base.json lives at repo root; tsconfig.json extends ../tsconfig.base.json → /tsconfig.base.json
COPY tsconfig.base.json /tsconfig.base.json
COPY api/tsconfig.json ./
COPY api/src ./src/

RUN npm run build

# ── Production image ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

LABEL org.opencontainers.image.source="https://github.com/mendoc/pontis"

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

COPY api/package*.json ./
COPY api/prisma ./prisma/

RUN npm pkg delete scripts.postinstall && npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Copy prisma CLI so the entrypoint can run migrations
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

COPY api/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN addgroup -S pontis && adduser -S pontis -G pontis \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

USER pontis

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
