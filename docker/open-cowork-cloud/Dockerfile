FROM node:22-bookworm-slim

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

ENV NODE_ENV=production
ENV OPEN_COWORK_CLOUD_ROOT=/data/open-cowork-cloud
ENV OPEN_COWORK_CLOUD_HOST=0.0.0.0
ENV OPEN_COWORK_CLOUD_PORT=8787

EXPOSE 8787

CMD ["pnpm", "cloud:dev"]
