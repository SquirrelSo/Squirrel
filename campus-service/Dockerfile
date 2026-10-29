# Squirrel campus-service — API (default) or worker (CMD ["node","dist/worker.js"])
#
# Single free web service (e.g. Render): set MIGRATE_ON_START=1 (applies migrations/*.sql once each,
# before listening), SEED_ZONES_ON_START=1 (hostels + placeholder zones only; never dev users/crews) and
# WORKER_INLINE=1. One-off equivalents: `node dist/db/migrate.js`, `node dist/seed/run.js --zones-only`.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# dist/db/migrate.js reads ../../migrations relative to itself → /app/migrations
COPY migrations ./migrations
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
