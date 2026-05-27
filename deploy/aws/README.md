# AWS Recipe

Use the same `open-cowork-cloud` image on AWS with these services:

| Role | Recommended service |
| --- | --- |
| `web` | ECS/Fargate service or EKS Deployment |
| `worker` | ECS service or EKS Deployment |
| `scheduler` | ECS service or EKS Deployment |
| Control plane | RDS for PostgreSQL |
| Object store | S3 |
| Secrets | Secrets Manager or SSM Parameter Store |

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

Keep ECS/Fargate task definitions aligned with the same environment variables
used by the Helm chart: `OPEN_COWORK_CLOUD_ROLE`, control-plane URL,
object-store settings, secret key, and checkpoint settings.

When the envelope key is read directly by the app, set
`OPEN_COWORK_CLOUD_SECRET_KEY_REF` to an AWS Secrets Manager URI such as
`aws-sm://open-cowork/cloud-secret-key?region=REGION`.
