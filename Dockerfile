# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────────────────────
# Measure Once — production container image
#
# Multi-stage build that produces a slim runtime image suitable for any
# container host (Cloud Run, Fly, ECS, etc.), independent of Replit's build
# pipeline. This is ADDITIVE: Replit deployment (.replit / replit.nix) remains
# the source of truth until the GCP cutover and is untouched by this file.
#
# Build:
#   docker build -t measure-once .
#   docker build -t measure-once --build-arg INCLUDE_STORYBOOK=false .
#
# Run (PORT defaults to 8080 here; the server reads process.env.PORT):
#   docker run -p 8080:8080 \
#     -e PORT=8080 \
#     -e DATABASE_URL=postgres://… \
#     -e SESSION_SECRET=… \
#     measure-once
#
# Database migrations are NEVER run during build or at container boot. Apply the
# schema with ONE of:
#   1. Boot flag — run the container with RUN_MIGRATIONS_ON_BOOT=true so the
#      server runs pending migrations on startup (fail-closed: a migration error
#      logs and exits the process). Suited to single-instance hosts.
#   2. Pre-deploy one-off (preferred for multi-instance hosts) — run
#      `npm run db:migrate` against the production DATABASE_URL before rolling
#      out new instances, e.g.:
#        docker run --rm -e DATABASE_URL=postgres://… measure-once npm run db:migrate
# Neither is enabled by default.
# ──────────────────────────────────────────────────────────────────────────────

# ── Builder stage ─────────────────────────────────────────────────────────────
# Installs ALL dependencies (incl. devDependencies) and produces the build
# artifacts: public/react, public/sw.js and (optionally) public/storybook.
FROM node:20-bookworm-slim AS builder

# Never download Chromium during npm ci — Puppeteer is a devDependency used only
# by the test suites, which do not run in this image. CI=true keeps npm quiet and
# non-interactive. NODE_ENV is left unset here on purpose: `npm ci` still installs
# devDependencies (needed to build), while `vite build` defaults to a production
# build. Setting NODE_ENV=development would bundle the React *development* build
# and inflate the always-loaded chunks past their gzip budget.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CI=true

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source (respects .dockerignore).
COPY . .

# Build the React island + service worker, and (by default) Storybook.
# Set --build-arg INCLUDE_STORYBOOK=false to skip the Storybook build and slim
# the resulting runtime image.
ARG INCLUDE_STORYBOOK=true
RUN npm run build:react \
    && if [ "$INCLUDE_STORYBOOK" = "true" ]; then npm run build:storybook; fi

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Slim image with production dependencies only, no Chromium, no devDependencies,
# no build tooling executed at boot (CMD runs `node server.js` directly, which
# bypasses npm's prestart hook).
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PORT=8080

WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source needed at runtime. Root *.js / *.cjs modules are all
# server-side runtime modules; the directories below are required by the server
# (views for EJS, migrations for the optional db:migrate step, shared for the
# *.cjs modules required by server.js, scripts for `npm run db:migrate`, and
# public for static assets). The built artifacts (public/react, public/sw.js and
# optionally public/storybook) come baked into builder's public/ directory.
COPY --from=builder /app/*.js /app/*.cjs /app/.node-pg-migraterc /app/workflow.json ./
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/views ./views
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/public ./public

# The server creates ./data at boot and writes ./workflow.json at runtime, so the
# non-root runtime user needs write access to the app root, that file, and ./data.
# node_modules and the static source are only ever read, so they stay root-owned
# (world-readable) — a recursive chown over node_modules would be needlessly slow.
RUN mkdir -p /app/data \
    && touch /app/workflow.json \
    && chown node:node /app /app/workflow.json \
    && chown -R node:node /app/data

USER node

EXPOSE 8080

CMD ["node", "server.js"]
