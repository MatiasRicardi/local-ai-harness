# Production image for the Local AI Harness backend.
#
# Build from the repository root (the pnpm workspace root is required so the
# frozen lockfile can be resolved):
#
#   docker build -f backend/Dockerfile -t local-ai-harness-backend:local .
#
# The runtime stage runs compiled JavaScript with Node; `tsx` is only used by
# `pnpm dev` and never appears in this image.

########## build stage ##########
FROM node:22-slim AS build

# Non-interactive Corepack: allow the pinned `packageManager` version to be
# downloaded during the build instead of prompting.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

RUN corepack enable

# Workspace manifests first so the dependency layer stays cached.
# Both workspace package.json files are copied because pnpm validates the
# workspace defined in pnpm-workspace.yaml.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile --filter backend

# Source is copied last. Test files are excluded by the root .dockerignore.
COPY backend/ ./backend/

RUN pnpm --filter backend build

########## runtime stage ##########
FROM node:22-slim AS runtime

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Container defaults. `AI_HOST` must be `0.0.0.0` so the server is reachable
# from outside the container; local `pnpm dev` keeps the application default of
# 127.0.0.1. `AI_UPLOAD_DIR` is absolute so it does not depend on the working
# directory. All values remain overridable with `docker run -e ...`.
ENV AI_HOST=0.0.0.0 \
    AI_ENVIRONMENT=production \
    AI_UPLOAD_DIR=/app/uploads

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Production dependencies only (-P): no TypeScript, tsx, ESLint or Vitest.
RUN pnpm install --frozen-lockfile --filter backend -P

# Compiled output only; application code stays root-owned and read-only for the
# runtime user.
COPY --from=build /app/backend/dist ./backend/dist

# The backend creates and cleans temporary uploads here.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node

WORKDIR /app/backend

EXPOSE 3000

ENTRYPOINT ["node", "dist/server.js"]
