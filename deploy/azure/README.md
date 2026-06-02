# Azure Recipe

Use the same `open-cowork-cloud` and `open-cowork-gateway` images on Azure
with these services:

| Role | Recommended service |
| --- | --- |
| `web` | Azure Container Apps or AKS Deployment |
| `worker` | Azure Container Apps service/jobs or AKS Deployment |
| `scheduler` | Azure Container Apps service/job or AKS Deployment |
| Gateway | Azure Container Apps service or AKS Deployment |
| Control plane | Azure Database for PostgreSQL |
| Object store | Azure Blob Storage |
| Secrets | Key Vault for cloud keys, gateway tokens, and channel credentials |
| Observability | Azure Monitor/Application Insights plus OTLP exporter or collector |
| Backups | Azure PostgreSQL PITR plus Blob versioning/lifecycle |

For scalable deployments, install the provider-neutral Helm chart on AKS and
connect it to Azure Database for PostgreSQL, Blob Storage, and Key Vault
through workload identity or External Secrets.

Example Helm overrides. Keep real subscription IDs, tenant IDs, registry names,
resource groups, domains, image tags, and secret values in a private deployment
repo or Azure-native config, not in this recipe:

```bash
helm upgrade --install open-cowork-cloud ../../helm/open-cowork-cloud \
  --set image.repository=REGISTRY.azurecr.io/open-cowork-cloud \
  --set image.tag=IMAGE_TAG \
  --set cloud.profile=full \
  --set cloud.publicUrl=https://cowork.example.com \
  --set cloud.auth.mode=oidc \
  --set cloud.auth.oidcIssuerUrl=https://login.microsoftonline.com/TENANT_ID/v2.0 \
  --set cloud.auth.oidcClientId=CLIENT_ID \
  --set cloud.checkpoints.enabled=true \
  --set cloud.objectStore.kind=azure-blob \
  --set cloud.objectStore.bucket=CONTAINER_NAME \
  --set cloud.objectStore.accountName=STORAGE_ACCOUNT \
  --set cloud.existingSecret=open-cowork-cloud-secrets
```

Install the gateway as a separate Container Apps service or AKS Deployment:

```bash
helm upgrade --install open-cowork-gateway ../../helm/open-cowork-gateway \
  --set image.repository=REGISTRY.azurecr.io/open-cowork-gateway \
  --set image.tag=IMAGE_TAG \
  --set gateway.cloudBaseUrl=https://cowork.example.com \
  --set gateway.publicUrl=https://gateway.example.com \
  --set gateway.existingSecret=open-cowork-gateway-secrets
```

Use Key Vault-backed secret injection for
`OPEN_COWORK_GATEWAY_SERVICE_TOKEN`, provider JSON, and channel credentials.
Webhook providers require a public HTTPS gateway URL; polling providers can
remain private with outbound channel API access.

Use Container Apps for focused pilots when that operational model is simpler,
but keep split roles and checkpointing enabled before adding worker replicas.

When the envelope key is read directly by the app, set
`OPEN_COWORK_CLOUD_SECRET_KEY_REF` to a Key Vault URI such as
`azure-kv://VAULT_NAME/secrets/open-cowork-cloud-key/VERSION`.

## Secret Inventory

Store these values in Key Vault, External Secrets, Container Apps secrets, or
AKS secret-store CSI. The names below are runtime keys, not committed values:

| Secret key | Runtime input |
| --- | --- |
| `OPEN_COWORK_CLOUD_CONTROL_PLANE_URL` | Azure Database for PostgreSQL connection string |
| `OPEN_COWORK_CLOUD_SECRET_KEY` or `OPEN_COWORK_CLOUD_SECRET_KEY_REF` | BYOK envelope key or `azure-kv://...` reference |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET` | Cookie signing secret |
| `OPEN_COWORK_CLOUD_INTERNAL_TOKEN` | Internal service token |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET` | Entra ID or external OIDC client secret |
| `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` | Gateway-scoped Cloud API token |
| `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` | Operator token for public metrics/diagnostics endpoints |
| provider webhook signing secrets | Telegram, Slack, email, or webhook credentials |

## Rollout And Smoke

1. Render Helm, AKS, or Container Apps definitions and verify `web`, `worker`,
   `scheduler`, and Gateway are separate scalable services for production.
2. Confirm Azure PostgreSQL PITR, Blob versioning/lifecycle, Azure Monitor JSON
   logs, and OTLP export or collector wiring are enabled.
3. Route HTTPS through Container Apps ingress, Application Gateway, Front Door,
   or AKS ingress and set `OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true` plus
   `OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS` only for trusted Azure forwarding
   hops.
4. Run the shared gates:

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
  `OPEN_COWORK_GATEWAY_PUBLIC_URL` with HTTPS Container Apps ingress,
  Application Gateway, Front Door, or AKS ingress.
- Store cookie secret, internal token, database URL, BYOK envelope key,
  gateway service token, and provider webhook signing secrets in Key Vault.
- Keep cloud billing disabled/stubbed for OSS self-host. Managed SaaS should
  configure billing through the billing adapter and signed billing webhooks.
- Prefer workload identity for Blob and Key Vault access over long-lived static
  keys.
- Run `pnpm deploy:smoke` after rollout with the deployed cloud and gateway
  URLs, then run `pnpm deploy:smoke:strict` for production evidence.

Azure configuration is provider-config only adapter wiring. Do not add Azure
branches to cloud sessions, gateway rendering, OpenCode runtime startup, or
BYOK core code.
