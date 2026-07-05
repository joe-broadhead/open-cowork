# GCP Terraform reference module

Reference IaC for the [GCP recipe](../README.md): the `open-cowork-cloud`
image split into Cloud Run roles (public `web`, internal always-on `worker`
and `scheduler`), Cloud SQL Postgres with PITR, a versioned GCS artifact
bucket, and Secret Manager wiring — all running as a dedicated service
account with least-privilege grants.

```bash
terraform init
terraform validate
terraform plan \
  -var project_id=PROJECT \
  -var cloud_image=REGION-docker.pkg.dev/PROJECT/REPO/open-cowork-cloud:TAG \
  -var vpc_self_link=projects/PROJECT/global/networks/NETWORK \
  -var database_user=open-cowork-cloud@PROJECT.iam
```

Notes:

- **Reference, not a managed product.** Files are syntax-checked in this
  repo; run `terraform validate` + review the plan against your project
  before applying. Real project ids, image tags, domains, and secret values
  belong in a private deployment repo.
- **Secrets stay in Secret Manager.** `secret_env` maps env var names to
  secret ids (e.g. `OPEN_COWORK_CLOUD_SESSION_SECRET`); values never enter
  Terraform state.
- **Workers are pinned, not autoscaled** — they hold OpenCode sessions.
  Scale `worker_instances` deliberately.
- **SSE**: web revisions drain gracefully; clients re-attach and replay from
  their cursor, so `web_max_instances > 1` is safe.
- Run migrations (`cloud:migrate:start`) as a Cloud Run job or one-off
  execution against the same image before first boot.
