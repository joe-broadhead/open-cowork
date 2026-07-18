# Terraform

Terraform examples live under `deploy/terraform`.

- `aws/`: ECS Fargate, ALB, and EFS for the `aws-ecs-efs` profile.
- `gcp/`: Cloud Run and Cloud Storage volume for the
  `cloud-run-readmostly` preview/demo profile. Do not treat GCS FUSE as
  production Git storage.

Each module includes a backend example. Configure remote state before using the
modules for anything beyond evaluation. Production cloud deployments should pin
the OpenWiki image by digest and map cloud-specific infrastructure back to the
same OpenWiki runtime model described in the deployment profiles guide.
