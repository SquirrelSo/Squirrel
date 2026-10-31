# The Run Module as a container, for the combined stack (../docker-compose.yml).
#
# Kept outside run-module/ so that module stays exactly as its team ships it. Build context is
# run-module/ (compose sets it); the one image serves three roles, picked by the command:
#   migrate   node-pg-migrate up          (one-shot, before the API and worker start)
#   api       src/api/server.ts            (default; MIGRATE_ON_START=1 migrates first)
#   worker    src/workers/start.ts
#
# The package.json scripts load variables with `node --env-file=.env`, which fails when there is no
# .env file; in a container the variables come from the environment, so the commands below call the
# same entry points without that flag.
FROM node:22-slim
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# Full install, not --omit=dev: the entry points run TypeScript through tsx, a dev dependency.
RUN npm ci --no-audit --no-fund
COPY backend/ ./
# Routes read their SQL from ../../../../db/queries relative to src/api/routes, i.e. /app/db.
COPY db/ /app/db/
ENV PORT=3000
EXPOSE 3000
# MIGRATE_ON_START=1 applies migrations before the API starts, for hosts with no separate one-shot
# step (Render's free plan has no pre-deploy command). Compose leaves it unset and runs run-migrate.
CMD ["sh", "-c", "if [ \"$MIGRATE_ON_START\" = 1 ]; then node node_modules/node-pg-migrate/bin/node-pg-migrate.js up --migrations-dir ../db/migrations --database-url-var DATABASE_URL || exit 1; fi; exec node --import tsx/esm src/api/server.ts"]
