# NOTE: this image runs the CLI directly from TypeScript source via tsx (see the root
# `openwiki` script and deploy/docker/entrypoint.sh), NOT the esbuild bundle that `pnpm pack:cli`
# publishes to npm. The two distribution paths are intentional but distinct; changes affecting
# startup should be validated against both the container and the packed bundle.
FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS base

WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/home/node/.cache/node/corepack
ENV PATH=/pnpm:$PATH
ENV OPENWIKI_ROOT=/data/wiki
ENV OPENWIKI_HOST=0.0.0.0
ENV OPENWIKI_PORT=3030

# Keep package installation reproducible against the pinned base digest; CI scans
# the final image before release tags are promoted.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git gosu openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p "$PNPM_HOME" "$COREPACK_HOME" \
  && chown -R node:node "$PNPM_HOME" /home/node/.cache \
  && corepack enable \
  && corepack prepare pnpm@11.9.0 --activate \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY schemas ./schemas
COPY templates ./templates
COPY integrations ./integrations
COPY deploy/docker ./deploy/docker
RUN pnpm install --frozen-lockfile --prod=false \
  && pnpm build:web \
  && CI=true pnpm install --frozen-lockfile --prod

FROM base AS runtime

COPY --from=deps --chown=node:node /app /app
RUN mkdir -p /data/wiki \
  && chown -R node:node /data /app "$PNPM_HOME" /home/node/.cache

USER node

EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPENWIKI_PORT||3030)+'/readyz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "/app/deploy/docker/entrypoint.sh"]
CMD ["serve"]
