# aws-ecs-efs

Use this profile for AWS ECS/Fargate with EFS-backed `/data/wiki`.

## Quickstart

```sh
cd deploy/terraform/aws
cp backend.tf.example backend.tf
terraform init
terraform apply \
  -var='vpc_id=vpc-...' \
  -var='subnet_ids=["subnet-...","subnet-..."]' \
  -var='certificate_arn=arn:aws:acm:...'
```

## Preflight

```sh
OPENWIKI_RATE_LIMIT_ENABLED=1 \
openwiki --root /data/wiki deploy preflight \
  --deploy-profile aws-ecs-efs \
  --public-origin https://wiki.example.com \
  --image ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

## Security Notes

- HTTPS is the production path. Set `certificate_arn` so ALB serves `443` and
  redirects HTTP.
- Use ALB OIDC or another auth boundary before write access.
- Keep ECS tasks private unless your VPC routing model requires public task IPs.
- Pin the image digest in Terraform variables before production.

## Readiness Checks

```sh
curl --fail https://wiki.example.com/livez
curl --fail https://wiki.example.com/readyz
aws ecs describe-services --cluster <cluster> --services <service>
```

## Backup And Restore

Back up EFS, Terraform remote state, Git remote, and any external Postgres or
object storage. Enable EFS backups and rehearse restore to a staging service
with `openwiki backup rehearse`, then follow the hosted restore order: Git
workspace, object storage, Postgres, derived stores, service secrets, `/readyz`,
and MCP smoke.

## Rollback

Set ECS desired worker count to zero, shift ALB traffic away or disable writes,
restore EFS/Postgres/object-storage backups as needed, deploy the previous task
definition image digest, run readiness checks, and re-enable traffic.

## MCP

Use ALB/OIDC for human browser access and service-account bearer tokens for HTTP
MCP. Internal AWS agents can use trusted proxy identity only when an internal
gateway authenticates the workload and injects OpenWiki headers.
