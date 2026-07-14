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
  -var cloud_image=ACCOUNT.dkr.ecr.REGION.amazonaws.com/open-cowork-cloud@sha256:REVIEWED_DIGEST \
  -var vpc_id=vpc-xxxx \
  -var 'private_subnet_ids=["subnet-a","subnet-b"]' \
  -var 'public_subnet_ids=["subnet-c","subnet-d"]' \
  -var acm_certificate_arn=arn:aws:acm:REGION:ACCOUNT:certificate/xxxx
```

The first apply intentionally keeps `deploy_runtime_services=false`, so it
creates RDS, ECS, storage, networking, and task definitions without starting
web, worker, or scheduler against an empty database. After RDS exists, create a
short-lived Secrets Manager value containing the migrator connection URL, then
configure the one-shot task:

```hcl
migrator_secret_env = {
  OPEN_COWORK_CLOUD_CONTROL_PLANE_URL = "arn:aws:secretsmanager:REGION:ACCOUNT:secret:open-cowork-migrator-url"
}
migrator_env = {
  OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE      = "open_cowork_runtime"
  OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL = "open_cowork_runtime_login"
}
```

Apply that configuration, run `migrator_task_definition_arn` on
`ecs_cluster_name` in the private subnets with `service_security_group_id`, and
wait for the container's exit code to be `0`:

```bash
TASK_ARN=$(aws ecs run-task \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --task-definition "$(terraform output -raw migrator_task_definition_arn)" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-a,subnet-b],securityGroups=[$(terraform output -raw service_security_group_id)],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$(terraform output -raw ecs_cluster_name)" --tasks "$TASK_ARN"
test "$(aws ecs describe-tasks --cluster "$(terraform output -raw ecs_cluster_name)" --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)" = 0
terraform apply -var deploy_runtime_services=true # include every previously reviewed variable
```

For upgrades, gate services off in the infrastructure plan, run the new
digest's migrator task to a verified zero exit, then enable services again.

Notes:

- **Reference, not a managed product.** Files are syntax-checked in this
  repo; run `terraform validate` + review the plan against your account
  before applying. Account ids, image tags, domains, and secret values
  belong in a private deployment repo.
- **Secrets stay in Secrets Manager.** `secret_env` maps env var names to
  secret ARNs. Its `OPEN_COWORK_CLOUD_CONTROL_PLANE_URL` must use a dedicated,
  least-privilege runtime login; never map the RDS-managed master secret (see
  `database_master_secret_arn`) into a long-running task. Nothing secret enters
  state.
- **Migration is an executable gate.** Runtime services do not exist until
  `deploy_runtime_services=true`. The module provides a separate one-shot task
  and execution identity; only that identity can read `migrator_secret_env`.
  Never place the migrator URL in `secret_env` or attach the migrator task role
  to a service.
- **ALB idle timeout is 3600s** — SSE event streams are long-lived and the
  60s default silently drops quiet streams.
- **Workers are pinned, not autoscaled** — they hold OpenCode sessions.
  Scale `worker_desired_count` deliberately.
- **Container health is role-specific.** The web task maps port `8787` and
  probes dependency readiness at `/readyz`. Worker and scheduler tasks set
  `OPEN_COWORK_CLOUD_LIVENESS_PORT=8788`, map only that heartbeat port, and
  probe `/livez`. ECS therefore replaces a wedged execution loop even though
  those roles intentionally do not run the Cloud HTTP/API server.
- All long-running tasks set `OPEN_COWORK_CLOUD_RUN_MIGRATIONS=false`. The
  module's migrator task runs `cloud:migrate:start` from the exact same pinned
  image with a separate migrator/master connection and provisions the
  dedicated runtime login grants before the service gate may be enabled.
