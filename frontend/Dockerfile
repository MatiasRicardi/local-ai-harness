# Production image for the Local AI Harness frontend.
#
# Build from the repository root (the pnpm workspace root is required so the
# frozen lockfile can be resolved):
#
#   docker build -f frontend/Dockerfile -t local-ai-harness-frontend:local .
#
# The runtime stage is a static file server only: `vite dev` is never used and
# no backend connectivity is configured here (Step 24.2 owns that).

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

# The browser build needs devDependencies (vue-tsc, Vite), so no -P here.
RUN pnpm install --frozen-lockfile --filter frontend

# Source is copied last. Test files are excluded by the root .dockerignore.
COPY frontend/ ./frontend/

RUN pnpm --filter frontend build

########## runtime stage ##########
FROM nginx:1-alpine AS runtime

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80
