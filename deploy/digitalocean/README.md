# DigitalOcean Recipe

Use the same `open-cowork-cloud` image on DigitalOcean with these services:

| Role | Recommended service |
| --- | --- |
| `web` | App Platform for demos or DOKS Deployment for production |
| `worker` | DOKS Deployment |
| `scheduler` | DOKS Deployment |
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
  --set cloud.checkpoints.enabled=true \
  --set cloud.objectStore.kind=digitalocean-spaces \
  --set cloud.objectStore.bucket=OPEN_COWORK_SPACE \
  --set cloud.objectStore.endpoint=https://REGION.digitaloceanspaces.com \
  --set cloud.existingSecret=open-cowork-cloud-secrets
```

App Platform all-in-one is acceptable for demos and focused-agent pilots.
Production worker execution should use DOKS split roles.
