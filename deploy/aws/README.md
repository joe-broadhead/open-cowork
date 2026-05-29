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

Example Helm overrides:

```bash
helm upgrade --install open-cowork-cloud ../../helm/open-cowork-cloud \
  --set image.repository=ACCOUNT.dkr.ecr.REGION.amazonaws.com/open-cowork-cloud \
  --set cloud.profile=full \
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
  --set gateway.cloudBaseUrl=https://cowork.example.com \
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

AWS configuration is adapter wiring only. Do not add AWS branches to cloud
sessions, gateway rendering, OpenCode runtime startup, or BYOK core code.
