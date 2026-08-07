# syntax=docker/dockerfile:1
# OpenWiki OCI image.
#
# Build context: the open-cowork monorepo root (root pnpm-lock.yaml is used):
#   docker build -f products/wiki/packaging/Dockerfile -t openwiki:local .
#
# One image, three roles (choose via command): serve (web UI + HTTP API + MCP over
# HTTP, default), worker (Postgres queue consumer), cron (backup/sync scheduler).
# All roles share a single wiki root volume; see packaging/README.md for the env
# contract and compose stack wiring.

ARG NODE_VERSION=22.23.2

# ---------- build stage ----------
FROM node:${NODE_VERSION}-alpine AS build
ARG PNPM_VERSION=10.32.1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# Copy the monorepo sources (.dockerignore prunes node_modules, dist, git,
# derived stores, and the wiki product's own wiki content). All workspace
# manifests must be present for frozen-lockfile resolution.
COPY . .

# Install only the wiki workspace and its (workspace) dependencies.
RUN pnpm install --frozen-lockfile --filter "cowork-wiki-workspace..."

# Build the CLI bundle (includes the prebuilt web UI assets).
RUN pnpm --dir products/wiki build:cli

# The bundled CLI must run from the image's Node.
RUN node --no-warnings products/wiki/packages/cli/dist/openwiki.js version --short

# ---------- runtime stage ----------
FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache git openssh-client ca-certificates tini

COPY --from=build /app/products/wiki/packages/cli/dist /opt/openwiki/dist
COPY products/wiki/packaging/entrypoint.sh /usr/local/bin/openwiki-entrypoint

# POSIX wrapper (busybox `env` has no -S; exec node directly).
RUN printf '#!/bin/sh\nexec node --no-warnings /opt/openwiki/dist/openwiki.js "$@"\n' > /usr/local/bin/openwiki \
  && chmod +x /usr/local/bin/openwiki /usr/local/bin/openwiki-entrypoint
ENV OPENWIKI_BIN=/usr/local/bin/openwiki \
    OPENWIKI_ROOT=/data/wiki

VOLUME ["/data/wiki"]
EXPOSE 3030
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/openwiki-entrypoint"]
CMD ["serve"]
