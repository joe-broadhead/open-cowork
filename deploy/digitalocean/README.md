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
  URLs.

DigitalOcean configuration is adapter wiring only. Do not add DigitalOcean
branches to cloud sessions, gateway rendering, OpenCode runtime startup, or
BYOK core code.
