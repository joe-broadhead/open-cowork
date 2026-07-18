# OpenWiki on AWS ECS Fargate

This example deploys OpenWiki to ECS Fargate with:

- ECS cluster and service
- Application Load Balancer
- EFS file system mounted at `/data/wiki`
- CloudWatch log group
- Task execution role and security groups

This module implements the `aws-ecs-efs` deployment profile. Production
deployments should pin the OpenWiki image by digest, use HTTPS, and put browser
writes behind ALB OIDC or another trusted auth boundary.

```sh
terraform init
terraform apply \
  -var='vpc_id=vpc-...' \
  -var='subnet_ids=["subnet-...","subnet-..."]' \
  -var='public_origin=https://wiki.example.com' \
  -var='certificate_arn=arn:aws:acm:...' \
  -var='database_url_secret_arn=arn:aws:secretsmanager:...' \
  -var='trusted_auth_headers_secret_arn=arn:aws:secretsmanager:...' \
  -var='runtime_secret_kms_key_arns=["arn:aws:kms:..."]' \
  -var='image=ghcr.io/joe-broadhead/open-wiki@sha256:<digest>'
```

When `certificate_arn` is set, the load balancer serves HTTPS on port `443`
and redirects HTTP traffic to HTTPS. Keep `assign_public_ip=false` unless the
selected subnets and routing model require public task IPs.

Copy `backend.tf.example` to `backend.tf` and fill in your S3/DynamoDB backend
before production use so Terraform state is encrypted, locked, and not stored
only on a workstation.

`production_mode=true` is the default and fails planning unless `certificate_arn`
is set and `image` is digest-pinned. Set it to `false` only for disposable
evaluation.

Store runtime secrets in AWS Secrets Manager or SSM Parameter Store, then expose
them to the ECS task as environment variables or mounted files. Typical secrets
are the Postgres URL, `OPENWIKI_TRUST_AUTH_HEADERS_SECRET`, Git deploy-key
material, and object-storage credentials. This module maps
`database_url_secret_arn` into `DATABASE_URL`, sets
`OPENWIKI_READ_BACKEND=postgres`, `OPENWIKI_SEARCH_BACKEND=postgres`,
`OPENWIKI_QUEUE_BACKEND=postgres`, and
`OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres`, then maps
`trusted_auth_headers_secret_arn` into `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` and
sets `OPENWIKI_TRUST_AUTH_HEADERS=1`. Set `public_origin` to the external
browser HTTPS origin; the module passes it as `OPENWIKI_PUBLIC_ORIGIN`. The
upstream auth boundary must inject `x-openwiki-actor` and
`x-openwiki-proxy-secret`.

The ECS task execution role is scoped to read only `database_url_secret_arn` and
`trusted_auth_headers_secret_arn` through Secrets Manager or SSM Parameter Store.
When either secret uses a customer-managed KMS key, set
`runtime_secret_kms_key_arns` to the exact key ARN list so Fargate can decrypt
the injected task secrets. Leave it empty for AWS-managed secret keys.

Enable EFS backup policies and document the Git remote restore path before
exposing users or agents.
