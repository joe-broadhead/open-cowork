# AWS Recipe

Use the same `open-cowork-cloud` and `open-cowork-gateway` images on AWS with
these services:

| Role | Recommended service |
| --- | --- |
| `web` | ECS/Fargate service or EKS Deployment |
| `worker` | ECS service or EKS Deployment |
| `scheduler` | ECS service or EKS Deployment |
| Gateway | ECS/Fargate service or EKS Deployment |
| Control plane | RDS for PostgreSQL |
| Object store | S3 |
| Secrets | Secrets Manager or SSM Parameter Store for cloud keys, gateway tokens, and channel credentials |
| Observability | CloudWatch Logs plus OTLP exporter or collector |
| Backups | RDS PITR plus S3 versioning/lifecycle |

For Kubernetes-first deployments, install the provider-neutral Helm chart on
EKS and connect it to RDS, S3, and Secrets Manager through External Secrets or
IRSA.

Example Helm overrides. Keep real AWS account IDs, cluster names, image tags,
domains, and secret values in a private deployment repo or AWS-native config,
not in this recipe:

```bash
helm upgrade --install open-cowork-cloud ../../helm/open-cowork-cloud \
  --set image.repository=ACCOUNT.dkr.ecr.REGION.amazonaws.com/open-cowork-cloud \
  --set image.tag=IMAGE_TAG \
  --set cloud.profile=full \
  --set cloud.publicUrl=https://cowork.example.com \
  --set cloud.auth.mode=oidc \
  --set cloud.auth.oidcIssuerUrl=https://cognito-idp.REGION.amazonaws.com/POOL_ID \
  --set cloud.auth.oidcClientId=CLIENT_ID \
  --set cloud.checkpoints.enabled=true \
  --set cloud.objectStore.kind=s3 \
  --set cloud.objectStore.bucket=OPEN_COWORK_BUCKET \
  --set cloud.objectStore.region=REGION \
  --set cloud.existingSecret=open-cowork-cloud-secrets
```

Install the gateway as a separate ECS service or EKS Deployment:

```bash
helm upgrade --install open-cowork-gateway ../../helm/open-cowork-gateway \
  --set image.repository=ACCOUNT.dkr.ecr.REGION.amazonaws.com/open-cowork-gateway \
  --set image.tag=IMAGE_TAG \
  --set gateway.cloudBaseUrl=https://cowork.example.com \
  --set gateway.publicUrl=https://gateway.example.com \
  --set gateway.existingSecret=open-cowork-gateway-secrets
```

Use Secrets Manager or SSM to inject `OPEN_COWORK_GATEWAY_SERVICE_TOKEN`,
`OPEN_COWORK_GATEWAY_PROVIDERS`, and channel credentials. Expose gateway ingress
only for webhook-mode providers; polling gateways can run without public
inbound traffic.

Keep ECS/Fargate task definitions aligned with the same environment variables
used by the Helm chart: `OPEN_COWORK_CLOUD_ROLE`, control-plane URL,
object-store settings, secret key, and checkpoint settings.

When the envelope key is read directly by the app, set
`OPEN_COWORK_CLOUD_SECRET_KEY_REF` to an AWS Secrets Manager URI such as
`aws-sm://open-cowork/cloud-secret-key?region=REGION`.

## Secret Inventory

Store these values in Secrets Manager, SSM Parameter Store, External Secrets,
or ECS task secrets. The names below are runtime keys, not committed values:

| Secret key | Runtime input |
| --- | --- |
| `OPEN_COWORK_CLOUD_CONTROL_PLANE_URL` | RDS PostgreSQL connection string |
| `OPEN_COWORK_CLOUD_SECRET_KEY` or `OPEN_COWORK_CLOUD_SECRET_KEY_REF` | BYOK envelope key or `aws-sm://...` reference |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET` | Cookie signing secret |
| `OPEN_COWORK_CLOUD_INTERNAL_TOKEN` | Internal service token |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET` | Cognito or external OIDC client secret |
| `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` | Gateway-scoped Cloud API token |
| `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` | Operator token for public metrics/diagnostics endpoints |
| provider webhook signing secrets | Telegram, Slack, email, or webhook credentials |

## Rollout And Smoke

1. Render Helm or ECS task definitions and verify `web`, `worker`,
   `scheduler`, and Gateway are separate scalable services.
2. Confirm RDS PITR, S3 versioning/lifecycle, CloudWatch JSON logs, and OTLP
   export or collector wiring are enabled.
3. Route HTTPS through ALB, CloudFront, or ingress and set
   `OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true` plus
   `OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS` only for trusted AWS forwarding
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
   ```

## Production Notes

- Configure `OPEN_COWORK_CLOUD_PUBLIC_URL` and
  `OPEN_COWORK_GATEWAY_PUBLIC_URL` with HTTPS ALB, CloudFront, or ingress
  origins.
- Store cookie secret, internal token, database URL, BYOK envelope key,
  gateway service token, and provider webhook signing secrets in Secrets
  Manager or SSM.
- Keep cloud billing disabled/stubbed for OSS self-host. Managed SaaS should
  configure billing through the billing adapter and signed billing webhooks.
- Prefer IRSA or task roles for S3 access over long-lived static keys.
- Run `pnpm deploy:smoke` after rollout with the deployed cloud and gateway
  URLs.

AWS configuration is provider-config only adapter wiring. Do not add AWS
branches to cloud sessions, gateway rendering, OpenCode runtime startup, or
BYOK core code.
