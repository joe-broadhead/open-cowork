# GCP Recipe

Use the same `open-cowork-cloud` and `open-cowork-gateway` images on GCP with
these services:

| Role | Recommended service |
| --- | --- |
| `web` | Cloud Run or GKE Deployment |
| `worker` | GKE Deployment for production; Cloud Run all-in-one only for demos |
| `scheduler` | GKE Deployment or a small Cloud Run service if polling is acceptable |
| Gateway | Cloud Run for webhook/polling gateways or a GKE Deployment |
| Control plane | Cloud SQL for PostgreSQL |
| Object store | Cloud Storage |
| Secrets | Secret Manager for cloud keys, gateway tokens, and channel credentials |

For scalable deployments, install the provider-neutral Helm chart on GKE and
wire it to Cloud SQL, Cloud Storage, and Secret Manager through External
Secrets or workload identity.

Example Helm overrides:

```bash
helm upgrade --install open-cowork-cloud ../../helm/open-cowork-cloud \
  --set image.repository=REGION-docker.pkg.dev/PROJECT/open-cowork/open-cowork-cloud \
  --set cloud.profile=full \
  --set cloud.auth.mode=oidc \
  --set cloud.auth.oidcIssuerUrl=https://accounts.google.com \
  --set cloud.auth.oidcClientId=CLIENT_ID \
  --set cloud.checkpoints.enabled=true \
  --set cloud.objectStore.kind=gcs \
  --set cloud.objectStore.bucket=OPEN_COWORK_BUCKET \
  --set cloud.existingSecret=open-cowork-cloud-secrets
```

Install the gateway as a separate Cloud Run service or GKE Deployment. For
Helm-based GKE:

```bash
helm upgrade --install open-cowork-gateway ../../helm/open-cowork-gateway \
  --set image.repository=REGION-docker.pkg.dev/PROJECT/open-cowork/open-cowork-gateway \
  --set gateway.cloudBaseUrl=https://cowork.example.com \
  --set gateway.existingSecret=open-cowork-gateway-secrets
```

The gateway secret should provide `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` plus
provider credentials such as `OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN`.
Webhook-mode providers need a public HTTPS gateway URL and ingress or Cloud Run
service URL; polling providers can stay private with egress to the channel API.

When not using External Secrets to inject `OPEN_COWORK_CLOUD_SECRET_KEY`
directly, set `OPEN_COWORK_CLOUD_SECRET_KEY_REF` to a Secret Manager URI such
as `gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-key/versions/latest`.

Cloud Run all-in-one is useful for demos and focused-agent pilots, but
production worker execution should run on GKE so OpenCode processes have stable
CPU and lifetime.
