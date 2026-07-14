# Open Cowork Cloud — GCP reference module (Cloud Run + Cloud SQL + GCS).
#
# Reference IaC for the recipe in deploy/gcp/README.md: split cloud roles on
# Cloud Run (web public, worker/scheduler internal, always-on), Postgres on
# Cloud SQL, artifacts on GCS, secrets in Secret Manager. Keep real project
# ids, image digests, domains, and secret VALUES in a private deployment repo —
# this module only references secret names.
#
# Validate with `terraform init && terraform validate` and review the plan
# before applying to a real project; this module is a starting point, not a
# managed product.

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source = "hashicorp/google"
      # database_roles on google_sql_user was added in 7.18. Keep the module
      # inside the provider major whose schema is validated by this repo.
      version = ">= 7.18, < 8.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  # Cloud SQL PostgreSQL service-account usernames omit the
  # `.gserviceaccount.com` suffix. Runtime and migration identities are
  # deliberately separate: only the one-shot migrator receives DDL authority.
  runtime_database_user  = trimsuffix(google_service_account.runtime.email, ".gserviceaccount.com")
  migrator_database_user = trimsuffix(google_service_account.migrator.email, ".gserviceaccount.com")
  database_service_accounts = {
    runtime  = google_service_account.runtime.email
    migrator = google_service_account.migrator.email
  }

  # Keep the connector immutable and auditable. Automatic IAM database
  # authentication is provided by the v2 Cloud SQL Auth Proxy; a plain Cloud
  # Run socket mount cannot mint the short-lived database login token.
  cloud_sql_proxy_image = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.23.0@sha256:54e23cad9aeeedbf88ab75f993146631b878035f702b31c51885a932e0c7286c"

  # Every injected secret must be readable. Keep secret_ids for additional
  # runtime-fetched secrets, and automatically include all secret_env values
  # so an operator cannot create a revision that references an inaccessible
  # secret by forgetting to duplicate it in a second variable.
  runtime_secret_ids = toset(concat(var.secret_ids, values(var.secret_env)))

  # web serves HTTP + SSE; worker claims managed work; scheduler ticks cron.
  roles = {
    web = {
      role               = "web"
      ingress            = "INGRESS_TRAFFIC_ALL"
      startup_probe_path = "/readyz"
      # Web replicas can scale with traffic; SSE sessions re-attach on drain.
      min_instances = var.web_min_instances
      max_instances = var.web_max_instances
    }
    worker = {
      role               = "worker"
      ingress            = "INGRESS_TRAFFIC_INTERNAL_ONLY"
      startup_probe_path = "/livez"
      # Workers hold OpenCode sessions — keep them warm, scale deliberately.
      min_instances = var.worker_instances
      max_instances = var.worker_instances
    }
    scheduler = {
      role               = "scheduler"
      ingress            = "INGRESS_TRAFFIC_INTERNAL_ONLY"
      startup_probe_path = "/livez"
      min_instances      = 1
      max_instances      = 1
    }
  }

  common_env = {
    OPEN_COWORK_CLOUD_HOST                = "0.0.0.0"
    OPEN_COWORK_CLOUD_PORT                = "8787"
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL   = "postgresql://${urlencode(local.runtime_database_user)}@127.0.0.1:5432/${google_sql_database.cloud.name}?sslmode=disable"
    OPEN_COWORK_CLOUD_RUN_MIGRATIONS      = "false"
    OPEN_COWORK_CLOUD_OBJECT_STORE_KIND   = "gcs"
    OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET = google_storage_bucket.artifacts.name
  }
}

resource "google_service_account" "runtime" {
  account_id   = "${var.name_prefix}-runtime"
  display_name = "Open Cowork Cloud runtime"
}

resource "google_service_account" "migrator" {
  account_id   = "${var.name_prefix}-migrator"
  display_name = "Open Cowork Cloud database migrator"
}

resource "google_project_iam_member" "cloud_sql_client" {
  for_each = local.database_service_accounts
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${each.value}"
}

resource "google_project_iam_member" "cloud_sql_instance_user" {
  for_each = local.database_service_accounts
  project  = var.project_id
  role     = "roles/cloudsql.instanceUser"
  member   = "serviceAccount:${each.value}"
}

resource "google_storage_bucket" "artifacts" {
  name                        = "${var.name_prefix}-artifacts-${var.project_id}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }
}

resource "google_storage_bucket_iam_member" "artifacts_rw" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_sql_database_instance" "cloud" {
  name             = "${var.name_prefix}-postgres"
  database_version = var.postgres_version
  region           = var.region

  settings {
    # db-custom-* is an Enterprise-edition machine family. PostgreSQL 16+
    # otherwise defaults to Enterprise Plus, whose machine types differ.
    edition           = "ENTERPRISE"
    tier              = var.database_tier
    availability_type = "REGIONAL"
    # Protect the instance at the Cloud SQL API as well as in Terraform.
    deletion_protection_enabled = true

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    # Sunday 04:00 UTC, after the daily backup window. Stable track provides
    # two weeks of notice before the maintenance update is applied.
    maintenance_window {
      day          = 7
      hour         = 4
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      query_plans_per_minute  = 5
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = false
    }

    ip_configuration {
      # Private-service access only; Cloud Run reaches it via the connector.
      ipv4_enabled    = false
      private_network = var.vpc_self_link
    }
  }

  deletion_protection = true
}

resource "google_sql_database" "cloud" {
  name     = "open_cowork_cloud"
  instance = google_sql_database_instance.cloud.name
}

resource "google_sql_user" "runtime" {
  name     = local.runtime_database_user
  instance = google_sql_database_instance.cloud.name
  password = null # IAM database authentication; no password in state.
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
  # The migration command creates a NOLOGIN group role and grants only runtime
  # CRUD/sequence privileges to this principal. Never assign an admin DB role.
  deletion_policy = "ABANDON"
}

resource "google_sql_user" "migrator" {
  name           = local.migrator_database_user
  instance       = google_sql_database_instance.cloud.name
  password       = null # IAM database authentication; no password in state.
  type           = "CLOUD_IAM_SERVICE_ACCOUNT"
  database_roles = ["cloudsqlsuperuser"]
  # PostgreSQL users with assigned database roles cannot be deleted through
  # the Cloud SQL Admin API. Abandon the principal if this Terraform resource
  # is removed; deleting the protected instance still removes it with the DB.
  deletion_policy = "ABANDON"
}

resource "google_secret_manager_secret_iam_member" "cloud_secrets" {
  for_each  = local.runtime_secret_ids
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "cloud" {
  # First apply with deploy_runtime_services=false, run the one-shot migration
  # and runtime-role grant command as the migrator identity, then enable these
  # long-running least-privilege services in a second reviewed apply.
  for_each = var.deploy_runtime_services ? local.roles : {}

  depends_on = [
    google_project_iam_member.cloud_sql_client,
    google_project_iam_member.cloud_sql_instance_user,
    google_sql_user.runtime,
  ]

  name     = "${var.name_prefix}-${each.key}"
  location = var.region
  ingress  = each.value.ingress

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    # Cloud SQL is private-IP only. Direct VPC egress gives the Auth Proxy a
    # route to the instance without maintaining a Serverless VPC connector.
    vpc_access {
      network_interfaces {
        network    = var.vpc_self_link
        subnetwork = var.vpc_subnetwork_self_link
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      name       = "open-cowork-cloud"
      image      = var.cloud_image
      depends_on = ["cloud-sql-proxy"]

      resources {
        # Execution-only roles must retain CPU between requests. Web remains
        # request-billed and can idle normally.
        cpu_idle          = each.value.role == "web"
        startup_cpu_boost = true
      }

      env {
        name  = "OPEN_COWORK_CLOUD_ROLE"
        value = each.value.role
      }

      # Worker and scheduler intentionally do not expose the Cloud web/API
      # server. Give those roles the dedicated heartbeat listener on the Cloud
      # Run container port so startup/liveness probes have a real endpoint.
      dynamic "env" {
        for_each = each.value.role == "web" ? [] : [1]
        content {
          name  = "OPEN_COWORK_CLOUD_LIVENESS_PORT"
          value = "8787"
        }
      }

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      ports {
        container_port = 8787
      }

      startup_probe {
        http_get {
          path = each.value.startup_probe_path
          port = 8787
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 6
      }

      liveness_probe {
        http_get {
          path = "/livez"
          port = 8787
        }
        period_seconds    = 30
        failure_threshold = 3
      }
    }

    containers {
      name  = "cloud-sql-proxy"
      image = local.cloud_sql_proxy_image
      args = [
        "--address=0.0.0.0",
        "--port=5432",
        "--private-ip",
        "--auto-iam-authn",
        "--lazy-refresh",
        "--run-connection-test",
        google_sql_database_instance.cloud.connection_name,
      ]

      resources {
        cpu_idle          = each.value.role == "web"
        startup_cpu_boost = true
      }

      startup_probe {
        tcp_socket {
          port = 5432
        }
        # Direct VPC establishment can take more than one minute. Give the
        # connection test Cloud Run's full supported startup window.
        period_seconds    = 5
        failure_threshold = 48
      }
    }
  }
}

# Only the web role accepts public traffic.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  count    = var.deploy_runtime_services && var.web_allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.cloud["web"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
