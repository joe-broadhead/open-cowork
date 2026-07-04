# Open Cowork Cloud — GCP reference module (Cloud Run + Cloud SQL + GCS).
#
# Reference IaC for the recipe in deploy/gcp/README.md: split cloud roles on
# Cloud Run (web public, worker/scheduler internal, always-on), Postgres on
# Cloud SQL, artifacts on GCS, secrets in Secret Manager. Keep real project
# ids, image tags, domains, and secret VALUES in a private deployment repo —
# this module only references secret names.
#
# Validate with `terraform init && terraform validate` and review the plan
# before applying to a real project; this module is a starting point, not a
# managed product.

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  # web serves HTTP + SSE; worker claims managed work; scheduler ticks cron.
  roles = {
    web = {
      role    = "web"
      ingress = "INGRESS_TRAFFIC_ALL"
      # Web replicas can scale with traffic; SSE sessions re-attach on drain.
      min_instances = var.web_min_instances
      max_instances = var.web_max_instances
    }
    worker = {
      role    = "worker"
      ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"
      # Workers hold OpenCode sessions — keep them warm, scale deliberately.
      min_instances = var.worker_instances
      max_instances = var.worker_instances
    }
    scheduler = {
      role          = "scheduler"
      ingress       = "INGRESS_TRAFFIC_INTERNAL_ONLY"
      min_instances = 1
      max_instances = 1
    }
  }

  common_env = {
    OPEN_COWORK_CLOUD_HOST                = "0.0.0.0"
    OPEN_COWORK_CLOUD_PORT                = "8787"
    OPEN_COWORK_CLOUD_CONTROL_PLANE_URL   = "postgresql://${var.database_user}@/${google_sql_database.cloud.name}?host=/cloudsql/${google_sql_database_instance.cloud.connection_name}"
    OPEN_COWORK_CLOUD_OBJECT_STORE_KIND   = "gcs"
    OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET = google_storage_bucket.artifacts.name
  }
}

resource "google_service_account" "cloud" {
  account_id   = "${var.name_prefix}-cloud"
  display_name = "Open Cowork Cloud runtime"
}

resource "google_storage_bucket" "artifacts" {
  name                        = "${var.name_prefix}-artifacts-${var.project_id}"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false

  versioning {
    enabled = true
  }
}

resource "google_storage_bucket_iam_member" "artifacts_rw" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.cloud.email}"
}

resource "google_sql_database_instance" "cloud" {
  name             = "${var.name_prefix}-postgres"
  database_version = var.postgres_version
  region           = var.region

  settings {
    tier = var.database_tier

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    ip_configuration {
      # Private-service access only; Cloud Run reaches it via the connector.
      ipv4_enabled = false
      private_network = var.vpc_self_link
    }
  }

  deletion_protection = true
}

resource "google_sql_database" "cloud" {
  name     = "open_cowork_cloud"
  instance = google_sql_database_instance.cloud.name
}

resource "google_sql_user" "cloud" {
  name     = var.database_user
  instance = google_sql_database_instance.cloud.name
  password = null # IAM database authentication; no password in state.
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

resource "google_secret_manager_secret_iam_member" "cloud_secrets" {
  for_each  = toset(var.secret_ids)
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud.email}"
}

resource "google_cloud_run_v2_service" "cloud" {
  for_each = local.roles

  name     = "${var.name_prefix}-${each.key}"
  location = var.region
  ingress  = each.value.ingress

  template {
    service_account = google_service_account.cloud.email

    scaling {
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.cloud.connection_name]
      }
    }

    containers {
      image = var.cloud_image

      env {
        name  = "OPEN_COWORK_CLOUD_ROLE"
        value = each.value.role
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
          path = "/healthz"
          port = 8787
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 6
      }

      liveness_probe {
        http_get {
          path = "/readyz"
          port = 8787
        }
        period_seconds    = 30
        failure_threshold = 3
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }
  }
}

# Only the web role accepts public traffic.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  count    = var.web_allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.cloud["web"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
