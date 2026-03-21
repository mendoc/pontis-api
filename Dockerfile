FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install

RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/

RUN npm run build

# ── Production image ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

LABEL org.opencontainers.image.source="https://github.com/mendoc/pontis-api"
LABEL org.opencontainers.image.description="Pontis API — backend d'une plateforme PaaS auto-hébergée"

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN addgroup -S -g 1001 pontis && adduser -S -u 1001 pontis -G pontis \
  && chmod +x /usr/local/bin/docker-entrypoint.sh \
  && chown -R pontis:pontis /app/node_modules/.prisma

USER pontis

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
