FROM node:26-bookworm-slim@sha256:b16ca7b4dcfb20184e1c70f9ee30c6a75ed1da669cfafd6d2add4761b123d79f AS build

WORKDIR /app

RUN npm install --global corepack@0.35.0 && corepack enable

# .npmrc carries public-hoist-pattern[]=ajv — without it the frozen install leaves
# ajv nested in the .pnpm store and the externalized cloud bundle can't resolve it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY mcps ./mcps
COPY scripts ./scripts
COPY open-cowork.config.json open-cowork.config.schema.json ./
COPY tsconfig.base.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @open-cowork/shared build
RUN pnpm --filter @open-cowork/runtime-host build
RUN pnpm cloud:build
# Prune to the runtime tree: workspace manifests + built dist output only
# (bundle entrypoints, browser renderer, MCP dist, skills, config, licenses).
# No TypeScript source, tests, or scripts ship in the public runtime image.
RUN node scripts/prune-cloud-runtime.mjs /runtime

FROM node:26-bookworm-slim@sha256:b16ca7b4dcfb20184e1c70f9ee30c6a75ed1da669cfafd6d2add4761b123d79f

WORKDIR /app

RUN npm install --global corepack@0.35.0 && corepack enable

# The pruned runtime tree carries the root manifests (.npmrc's public-hoist
# patterns must reach the --prod install or the externalized cloud bundle can't
# resolve ajv/pg), the per-package package.json + dist pairs, config + schema,
# and the MIT license + curated third-party attribution set (LIC-03).
#
# The bundle's workspace externals (@open-cowork/shared, @open-cowork/
# runtime-host) resolve because the ROOT package.json declares them as PROD
# dependencies — the --prod install links them into /app/node_modules, which is
# the only node_modules on the resolution walk up from apps/desktop/dist/cloud.
# (They must never move back to devDependencies: the old full-source COPY only
# booted by accident, via build-stage node_modules symlinks riding along.)
COPY --from=build /runtime ./

RUN pnpm install --frozen-lockfile --prod
RUN mkdir -p /data/open-cowork-cloud && chown -R node:node /data/open-cowork-cloud

ENV NODE_ENV=production
ENV OPEN_COWORK_CLOUD_ROOT=/data/open-cowork-cloud
ENV OPEN_COWORK_CLOUD_HOST=127.0.0.1
ENV OPEN_COWORK_CLOUD_PORT=8787

EXPOSE 8787

USER node

# Probe readiness (/readyz: real DB/object-store/secret round-trip, 200/503), not bare
# liveness (/healthz: unconditional 200) — an unhealthy backing service should mark the
# container unhealthy so traffic is not routed to it. Helm probes already do this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "const role=process.env.OPEN_COWORK_CLOUD_ROLE||'all-in-one'; if(role!=='web'&&role!=='all-in-one') process.exit(0); fetch('http://127.0.0.1:'+(process.env.OPEN_COWORK_CLOUD_PORT||'8787')+'/readyz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "apps/desktop/dist/cloud/open-cowork-cloud.mjs"]
