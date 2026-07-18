FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN npm rebuild esbuild --ignore-scripts=false

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY bin/ ./bin/
RUN npm run build
RUN mkdir -p /tmp/nonroot-home/.config/opencode-gateway && chown -R 65532:65532 /tmp/nonroot-home

FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:720eb55ab149a51b5f70d8070901156a9152be30684aa265b558dcea66a169c3

WORKDIR /app

COPY --chown=65532:65532 --from=build /tmp/nonroot-home/ /home/nonroot/
COPY --chown=65532:65532 package.json package-lock.json ./
COPY --chown=65532:65532 --from=prod-deps /app/node_modules/ ./node_modules/
COPY --chown=65532:65532 --from=build /app/dist/ ./dist/
COPY --chown=65532:65532 bin/ ./bin/

ENV NODE_ENV=production
ENV HOME=/home/nonroot
ENV GATEWAY_HTTP_PORT=4097
ENV OPENCODE_GATEWAY_URL=http://127.0.0.1:4096

EXPOSE 4097

USER 65532:65532

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/nodejs/bin/node", "-e", "const fs=require('node:fs'); const port=process.env.OPENCODE_GATEWAY_HTTP_PORT||process.env.GATEWAY_HTTP_PORT||4097; const tokenFile=process.env.OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE; const token=tokenFile?fs.readFileSync(tokenFile,'utf8').trim():(process.env.OPENCODE_GATEWAY_HTTP_READ_TOKEN||process.env.OPENCODE_GATEWAY_HTTP_TOKEN||''); fetch('http://127.0.0.1:'+port+'/health',{headers:token?{authorization:'Bearer '+token}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["dist/daemon.js"]
