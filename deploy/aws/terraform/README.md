# AWS Terraform reference module

Reference IaC for the [AWS recipe](../README.md): the `open-cowork-cloud`
image split into ECS Fargate roles (`web` behind an HTTPS ALB, internal
`worker` and `scheduler`), RDS Postgres with an RDS-managed master password,
a versioned private S3 artifact bucket, CloudWatch logs, and Secrets Manager
wiring. Networking is bring-your-own: pass an existing VPC plus
public/private subnets.

```bash
terraform init
terraform validate
terraform plan \
  -var cloud_image=ACCOUNT.dkr.ecr.REGION.amazonaws.com/open-cowork-cloud:TAG \
  -var vpc_id=vpc-xxxx \
  -var 'private_subnet_ids=["subnet-a","subnet-b"]' \
  -var 'public_subnet_ids=["subnet-c","subnet-d"]' \
  -var acm_certificate_arn=arn:aws:acm:REGION:ACCOUNT:certificate/xxxx
```

Notes:

- **Reference, not a managed product.** Files are syntax-checked in this
  repo; run `terraform validate` + review the plan against your account
  before applying. Account ids, image tags, domains, and secret values
  belong in a private deployment repo.
- **Secrets stay in Secrets Manager.** `secret_env` maps env var names to
  secret ARNs; the RDS master password is RDS-managed (see the
  `database_master_secret_arn` output). Nothing secret enters state.
- **ALB idle timeout is 3600s** — SSE event streams are long-lived and the
  60s default silently drops quiet streams.
- **Workers are pinned, not autoscaled** — they hold OpenCode sessions.
  Scale `worker_desired_count` deliberately.
- Run migrations (`cloud:migrate:start`) as a one-off ECS task against the
  same image before first boot.
