FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY mcps ./mcps
COPY scripts ./scripts
COPY open-cowork.config.json open-cowork.config.schema.json ./
COPY tsconfig.base.json ./

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @open-cowork/shared build
RUN pnpm --filter @open-cowork/gateway build

FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732

WORKDIR /app

RUN corepack enable

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/mcps ./mcps
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/open-cowork.config.json /app/open-cowork.config.schema.json ./
COPY --from=build /app/tsconfig.base.json ./

RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
ENV OPEN_COWORK_GATEWAY_HOST=0.0.0.0
ENV OPEN_COWORK_GATEWAY_PORT=8790
ENV OPEN_COWORK_GATEWAY_METRICS_ENABLED=true

EXPOSE 8790

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPEN_COWORK_GATEWAY_PORT||'8790')+'/ready').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--dir", "apps/gateway", "start"]
