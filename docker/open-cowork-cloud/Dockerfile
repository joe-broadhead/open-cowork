FROM node:26-bookworm-slim@sha256:79723b41edbedf595f62e943a9f8b0ba9af5b1e61045c5f8f59c2c02c1212a16 AS build

WORKDIR /app

RUN npm install --global corepack@0.35.0 && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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

FROM node:26-bookworm-slim@sha256:79723b41edbedf595f62e943a9f8b0ba9af5b1e61045c5f8f59c2c02c1212a16

WORKDIR /app

RUN npm install --global corepack@0.35.0 && corepack enable

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/mcps ./mcps
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/open-cowork.config.json /app/open-cowork.config.schema.json ./
COPY --from=build /app/tsconfig.base.json ./
# Carry the MIT license + curated third-party attribution into the redistributed
# image, matching what the desktop app bundles (LIC-03).
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES

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
