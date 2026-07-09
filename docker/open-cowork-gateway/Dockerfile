FROM node:26-bookworm-slim@sha256:b16ca7b4dcfb20184e1c70f9ee30c6a75ed1da669cfafd6d2add4761b123d79f AS build

WORKDIR /app

RUN npm install --global corepack@0.35.0 && corepack enable

# .npmrc carries the public-hoist-pattern needed for externalized-bundle deps (ajv).
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
RUN pnpm --filter @open-cowork/gateway build
# Prune to the runtime tree: root manifests/config/license material plus the
# Gateway app and runtime package package.json + dist pairs. No source trees,
# tests, MCPs, desktop artifacts, or release scripts ship in the public image.
RUN node scripts/prune-gateway-runtime.mjs /runtime

FROM node:26-bookworm-slim@sha256:b16ca7b4dcfb20184e1c70f9ee30c6a75ed1da669cfafd6d2add4761b123d79f

WORKDIR /app

RUN npm install --global corepack@0.35.0 && corepack enable

# The pruned runtime tree carries the root manifests (.npmrc's public-hoist
# patterns must reach the --prod install), the per-package package.json + dist
# pairs, config + schema, and the MIT license + curated third-party attribution
# set. Source, tests, MCPs, and release scripts stay behind in the build stage.
COPY --from=build /runtime ./

RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
ENV OPEN_COWORK_GATEWAY_HOST=0.0.0.0
ENV OPEN_COWORK_GATEWAY_PORT=8790
ENV OPEN_COWORK_GATEWAY_METRICS_ENABLED=true

EXPOSE 8790

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPEN_COWORK_GATEWAY_PORT||'8790')+'/ready').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/gateway/dist/index.js"]
