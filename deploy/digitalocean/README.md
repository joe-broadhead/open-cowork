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

For scalable deployments, install the provider-neutral Helm chart on DOKS and
connect it to Managed PostgreSQL and Spaces.

Example Helm overrides:

```bash
helm upgrade --install open-cowork-cloud ../../helm/open-cowork-cloud \
  --set image.repository=registry.digitalocean.com/REGISTRY/open-cowork-cloud \
  --set cloud.profile=full \
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
  --set gateway.cloudBaseUrl=https://cowork.example.com \
  --set gateway.existingSecret=open-cowork-gateway-secrets
```

Keep gateway service tokens and channel credentials in App Platform secrets or
External Secrets. Only expose the gateway publicly when a webhook-mode provider
needs inbound callbacks.

App Platform all-in-one is acceptable for demos and focused-agent pilots.
Production worker execution should use DOKS split roles.
