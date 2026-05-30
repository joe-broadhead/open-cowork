# Generic Kubernetes Recipe

Use this recipe when the target cluster is not tied to the GCP, AWS, Azure, or
DigitalOcean reference paths. The deployment still uses the same
`open-cowork-cloud` and `open-cowork-gateway` images and the provider-neutral Helm charts.

## Required Cluster Services

| Role | Required backing service |
| --- | --- |
| `web` | Kubernetes Deployment behind HTTPS ingress or a trusted private load balancer |
| `worker` | Kubernetes Deployment with durable Postgres and object-store access |
| `scheduler` | Kubernetes Deployment with the same Postgres control-plane connection |
| Gateway | Separate Kubernetes Deployment or external VPS/local Compose appliance |
| Control plane | Managed or operator-owned Postgres |
| Object store | S3-compatible object store, GCS, Azure Blob, or MinIO-compatible endpoint |
| Secrets | External Secrets, sealed secrets, CSI secret driver, or manually managed Kubernetes Secret |
| Observability | JSON logs, Prometheus/OTLP collector, and the assets in `deploy/observability/` |
| Backups | Postgres PITR or scheduled dumps plus object-store versioning/snapshot restore |

## Helm Overrides

Copy these overrides into a private values file and replace placeholders there.
Keep this recipe provider-config only and free of real cluster, account,
domain, and credential values.

```yaml
image:
  repository: registry.example.com/open-cowork/open-cowork-cloud
  tag: IMAGE_TAG # or set image.digest instead

cloud:
  profile: full
  publicUrl: https://cowork.example.com
  existingSecret: open-cowork-cloud-secrets
  checkpoints:
    enabled: true
  auth:
    mode: oidc
    oidcIssuerUrl: https://issuer.example.com
    oidcClientId: OPEN_COWORK_OIDC_CLIENT_ID
  objectStore:
    kind: s3
    bucket: OPEN_COWORK_BUCKET
    endpoint: https://object-store.example.com
    region: REGION
  observability:
    logFormat: json
    otlpEndpoint: http://otel-collector.monitoring.svc:4318

roles:
  web:
    enabled: true
    replicas: 2
    topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app.kubernetes.io/component: web
    podDisruptionBudget:
      enabled: true
      minAvailable: 1
  worker:
    enabled: true
    replicas: 2
    checkpointsEnabled: true
    topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app.kubernetes.io/component: worker
    podDisruptionBudget:
      enabled: true
      minAvailable: 1
  scheduler:
    enabled: true
    replicas: 1

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: cowork.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: open-cowork-cloud-tls
      hosts:
        - cowork.example.com
```

`IMAGE_TAG` must be an immutable release tag. Prefer `image.digest` when your
release process records OCI digests. The charts reject `image.tag=latest`.

The chart exposes PodDisruptionBudget and topology spread values, but it does
not create HPA or KEDA resources. Add autoscaling manifests in the private
cluster overlay where CPU/memory metrics, queue-depth metrics, and operational
SLOs are owned. Worker autoscaling beyond one replica requires
`cloud.checkpoints.enabled=true`, `roles.worker.checkpointsEnabled=true`, and
a shared object store.

Install Cloud and Gateway as separate releases so Gateway tokens and channel
credentials can be rotated without changing the Cloud control plane:

```bash
helm upgrade --install open-cowork-cloud ./helm/open-cowork-cloud \
  --namespace open-cowork \
  --create-namespace \
  --values deploy/kubernetes/values.private.yaml

helm upgrade --install open-cowork-gateway ./helm/open-cowork-gateway \
  --namespace open-cowork \
  --set image.repository=registry.example.com/open-cowork/open-cowork-gateway \
  --set image.tag=IMAGE_TAG \
  --set gateway.cloudBaseUrl=https://cowork.example.com \
  --set gateway.publicUrl=https://gateway.example.com \
  --set gateway.existingSecret=open-cowork-gateway-secrets
```

## Secret Inventory

Create `open-cowork-cloud-secrets` from your cluster secret manager or private
deployment repo before installing the chart:

| Secret key | Runtime input |
| --- | --- |
| `OPEN_COWORK_CLOUD_CONTROL_PLANE_URL` | Postgres connection string |
| `OPEN_COWORK_CLOUD_SECRET_KEY` or `OPEN_COWORK_CLOUD_SECRET_KEY_REF` | BYOK envelope key or secret-manager URI |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET` | Cookie signing secret |
| `OPEN_COWORK_CLOUD_INTERNAL_TOKEN` | Internal service token |
| `OPEN_COWORK_CLOUD_PUBLIC_URL` | Public HTTPS Cloud origin |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET` | OIDC client secret when required |
| object-store credentials | Access key, client secret, or workload-identity adapter input |

Create `open-cowork-gateway-secrets` separately:

| Secret key | Runtime input |
| --- | --- |
| `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` | Gateway-scoped Cloud API token |
| `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` | Operator token for public metrics/diagnostics endpoints |
| `OPEN_COWORK_GATEWAY_PUBLIC_URL` | Public HTTPS Gateway origin when webhook providers need inbound traffic |
| `OPEN_COWORK_GATEWAY_PROVIDERS` | Provider JSON when using bundled provider config |
| provider webhook signing secrets | Telegram, Slack, email, or webhook adapter credentials |

## Rollout And Smoke

1. Render manifests with `helm template` and inspect ingress, service account,
   secret references, and role replicas.
2. Apply or sync `open-cowork-cloud-secrets` and
   `open-cowork-gateway-secrets`.
3. Install Cloud, wait for `web`, `worker`, and `scheduler` readiness, then
   install Gateway.
4. Route HTTPS traffic and keep `OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true`
   only behind a trusted ingress or reverse proxy.
5. Run the shared deployment gates:

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
   ```

Generic Kubernetes configuration is adapter wiring only. Do not add Kubernetes
branches to cloud sessions, gateway rendering, OpenCode runtime startup, or
BYOK core code.
