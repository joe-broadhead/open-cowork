# DigitalOcean Recipe

Use the same `open-cowork-cloud` and `open-cowork-gateway` images on
DigitalOcean with these services:

| Role | Recommended service |
| --- | --- |
| `web` | App Platform for demos or DOKS Deployment for production |
| `worker` | DOKS Deployment |
| `scheduler` | DOKS Deployment |
| Gateway | App Platform component or DOKS Deployment |
| Control plane | Managed PostgreSQL |
| Object store | Spaces |
| Secrets | App Platform or Kubernetes secrets, preferably External Secrets |
| Observability | App Platform logs, Kubernetes logs, and OTLP exporter or collector |
| Backups | Managed PostgreSQL backups plus Spaces versioning/lifecycle |

For scalable deployments, install the provider-neutral Helm chart on DOKS and
connect it to Managed PostgreSQL and Spaces.

Example Helm overrides. Keep real registry names, project IDs, domains, image
tags, image digests, and secret values in a private deployment repo or
DigitalOcean-native config, not in this recipe:

```bash
helm upgrade --install open-cowork-cloud ../../helm/open-cowork-cloud \
  --set image.repository=registry.digitalocean.com/REGISTRY/open-cowork-cloud \
  --set image.tag=IMAGE_TAG \
  --set image.digest=sha256:REPLACE_WITH_CLOUD_DIGEST \
  --set cloud.profile=full \
  --set cloud.runMigrations=false \
  --set cloud.publicUrl=https://cowork.example.com \
  --set cloud.auth.mode=oidc \
  --set cloud.auth.oidcIssuerUrl=https://ISSUER.example.com \
  --set cloud.auth.oidcClientId=CLIENT_ID \
  --set cloud.checkpoints.enabled=true \
  --set cloud.objectStore.kind=digitalocean-spaces \
  --set cloud.objectStore.bucket=OPEN_COWORK_SPACE \
  --set cloud.objectStore.endpoint=https://REGION.digitaloceanspaces.com \
  --set cloud.existingSecret=open-cowork-cloud-secrets
```

Install the gateway as an App Platform component for simple channel bots or as
a DOKS Deployment for production:

```bash
helm upgrade --install open-cowork-gateway ../../helm/open-cowork-gateway \
  --set image.repository=registry.digitalocean.com/REGISTRY/open-cowork-gateway \
  --set image.tag=IMAGE_TAG \
  --set image.digest=sha256:REPLACE_WITH_GATEWAY_DIGEST \
  --set gateway.cloudBaseUrl=https://cowork.example.com \
  --set gateway.publicUrl=https://gateway.example.com \
  --set gateway.existingSecret=open-cowork-gateway-secrets
```

Keep gateway service tokens and channel credentials in App Platform secrets or
External Secrets. Only expose the gateway publicly when a webhook-mode provider
needs inbound callbacks.

App Platform all-in-one is acceptable for demos and focused-agent pilots.
Production worker execution should use DOKS split roles.

## Secret Inventory

Store these values in App Platform secrets, Kubernetes Secrets, External
Secrets, or a private deployment repo. The names below are runtime keys, not
committed values:

| Secret key | Runtime input |
| --- | --- |
| `OPEN_COWORK_CLOUD_CONTROL_PLANE_URL` | Least-privilege runtime Managed PostgreSQL connection string; never the owner/migrator URL |
| `OPEN_COWORK_CLOUD_SECRET_KEY` or `OPEN_COWORK_CLOUD_SECRET_KEY_REF` | BYOK envelope key or external secret reference |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET` | Cookie signing secret |
| `OPEN_COWORK_CLOUD_INTERNAL_TOKEN` | Internal service token |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET` | OIDC client secret |
| Spaces credentials | Access key and secret with limited bucket/prefix scope |
| `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` | Gateway-scoped Cloud API token |
| `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` | Operator token for public metrics/diagnostics endpoints |
| provider webhook signing secrets | Telegram, Slack, email, or webhook credentials |

## Rollout And Smoke

1. Create a dedicated runtime database principal and run
   `cloud:migrate:start` once from the exact pinned image with a separately
   stored owner/migrator URL. Remove that privileged credential after the
   migration and verify all long-running roles set
   `OPEN_COWORK_CLOUD_RUN_MIGRATIONS=false`.
2. Render Helm or App Platform specs and verify `web`, `worker`, `scheduler`,
   and Gateway are separate scalable services for production.
3. Confirm Managed PostgreSQL backups, Spaces versioning/lifecycle, JSON logs,
   and OTLP export or collector wiring are enabled.
4. Route HTTPS through App Platform or DOKS ingress and set
   `OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true` plus
   `OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS` only for trusted forwarding hops.
5. Run the shared gates:

   ```bash
   pnpm deploy:validate

   OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
   OPEN_COWORK_SMOKE_GATEWAY_URL=https://gateway.example.com \
   pnpm deploy:smoke

   OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL=https://cowork.example.com \
   OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN=... \
   pnpm deploy:desktop:smoke

   OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL=https://cowork.example.com \
   OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL=https://gateway.example.com \
   OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN=... \
   OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN=... \
   pnpm deploy:gateway:smoke

   OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://cowork.example.com \
   OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=... \
   OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true \
   pnpm deploy:continuation:smoke

   OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
   OPEN_COWORK_SMOKE_GATEWAY_URL=https://gateway.example.com \
   OPEN_COWORK_SMOKE_ADMIN_TOKEN=... \
   OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN=... \
   pnpm deploy:smoke:strict
   ```

## Production Notes

- Configure `OPEN_COWORK_CLOUD_PUBLIC_URL` and
  `OPEN_COWORK_GATEWAY_PUBLIC_URL` with HTTPS App Platform or DOKS ingress
  origins.
- Store cookie secret, internal token, database URL, BYOK envelope key,
  gateway service token, and provider webhook signing secrets in App Platform
  secrets, Kubernetes secrets, or External Secrets.
- Keep cloud billing disabled/stubbed for OSS self-host. Managed SaaS should
  configure billing through the billing adapter and signed billing webhooks.
- Use Spaces access keys with the smallest bucket/prefix scope available.
- Run `pnpm deploy:smoke` after rollout with the deployed cloud and gateway
  URLs, then run `pnpm deploy:smoke:strict` for production evidence.

DigitalOcean configuration is provider-config only adapter wiring. Do not add
DigitalOcean branches to cloud sessions, gateway rendering, OpenCode runtime
startup, or BYOK core code.
