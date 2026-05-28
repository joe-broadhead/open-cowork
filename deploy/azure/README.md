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

For scalable deployments, install the provider-neutral Helm chart on AKS and
connect it to Azure Database for PostgreSQL, Blob Storage, and Key Vault
through workload identity or External Secrets.

Example Helm overrides:

```bash
helm upgrade --install open-cowork-cloud ../../helm/open-cowork-cloud \
  --set image.repository=REGISTRY.azurecr.io/open-cowork-cloud \
  --set cloud.profile=full \
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
  --set gateway.cloudBaseUrl=https://cowork.example.com \
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
