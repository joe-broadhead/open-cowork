provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

# This profile intentionally models the disposable Cloud Run topology that was
# proven by live smoke testing. Cloud Storage FUSE remains a read-mostly preview
# workspace mount; use GKE/Helm, a VM, or another POSIX-backed runtime for
# long-lived writable Git workspaces.
data "google_project" "current" {
  project_id = var.project_id
}

locals {
  port = 3030
  public_origin = (
    var.public_origin != ""
    ? trimsuffix(var.public_origin, "/")
    : "https://${var.name}-${data.google_project.current.number}.${var.region}.run.app"
  )
  image = (
    var.image != ""
    ? var.image
    : "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.openwiki.repository_id}/openwiki:latest"
  )

  required_services = toset(concat([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ], var.billing_account_id == null ? [] : ["billingbudgets.googleapis.com"]))

  managed_database_url_secret       = var.database_url_secret_name == null
  managed_trusted_auth_secret       = var.trusted_auth_headers_secret_name == null
  database_url_secret_name          = local.managed_database_url_secret ? google_secret_manager_secret.database_url[0].secret_id : var.database_url_secret_name
  trusted_auth_headers_secret_name  = local.managed_trusted_auth_secret ? google_secret_manager_secret.trusted_auth[0].secret_id : var.trusted_auth_headers_secret_name
  cloud_build_compute_service_agent = "${data.google_project.current.number}-compute@developer.gserviceaccount.com"
  cloud_build_legacy_service_agent  = "${data.google_project.current.number}@cloudbuild.gserviceaccount.com"

  database_url = "postgres://${var.database_user}:${random_password.database.result}@127.0.0.1:5432/${var.database_name}"

  runtime_env = [
    { name = "OPENWIKI_ROOT", value = "/data/wiki" },
    { name = "OPENWIKI_TITLE", value = var.openwiki_title },
    { name = "OPENWIKI_HOST", value = "0.0.0.0" },
    { name = "OPENWIKI_PORT", value = tostring(local.port) },
    { name = "OPENWIKI_RUNTIME_MODE", value = "hosted" },
    { name = "OPENWIKI_PUBLIC_ORIGIN", value = local.public_origin },
    { name = "OPENWIKI_READ_BACKEND", value = "postgres" },
    { name = "OPENWIKI_SEARCH_BACKEND", value = "postgres" },
    { name = "OPENWIKI_QUEUE_BACKEND", value = "postgres" },
    { name = "OPENWIKI_OPERATIONAL_STATE_BACKEND", value = "postgres" },
    { name = "OPENWIKI_WRITE_COORDINATOR_BACKEND", value = "postgres" },
    { name = "OPENWIKI_REQUIRE_AUTH", value = "true" },
    { name = "OPENWIKI_TRUST_AUTH_HEADERS", value = "1" },
  ]

  service_env = concat(local.runtime_env, [
    { name = "OPENWIKI_BOOTSTRAP_MODE", value = var.service_bootstrap_mode },
  ])

  job_env = concat(local.runtime_env, [
    { name = "OPENWIKI_BOOTSTRAP_MODE", value = "skip" },
  ])
}

resource "terraform_data" "preview_guardrails" {
  input = {
    production_mode     = var.production_mode
    auth_boundary_notes = var.auth_boundary_notes
    image               = local.image
  }

  lifecycle {
    precondition {
      condition     = !var.production_mode || !var.allow_unauthenticated
      error_message = "Cloud Run production_mode requires allow_unauthenticated=false."
    }
    precondition {
      condition     = !var.production_mode || can(regex("@sha256:", local.image))
      error_message = "Cloud Run production_mode requires a digest-pinned OpenWiki image."
    }
    precondition {
      condition     = !var.production_mode || !var.force_destroy_bucket
      error_message = "Cloud Run production_mode requires force_destroy_bucket=false."
    }
    precondition {
      condition     = !var.production_mode || var.sql_backup_enabled
      error_message = "Cloud Run production_mode requires sql_backup_enabled=true."
    }
    precondition {
      condition     = !var.production_mode || var.sql_deletion_protection
      error_message = "Cloud Run production_mode requires sql_deletion_protection=true."
    }
  }
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "openwiki" {
  project       = var.project_id
  location      = var.region
  repository_id = var.name
  description   = "Disposable OpenWiki image repository for ${var.name}"
  format        = "DOCKER"

  depends_on = [google_project_service.required["artifactregistry.googleapis.com"]]
}

resource "google_artifact_registry_repository_iam_member" "cloud_build_compute_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.openwiki.location
  repository = google_artifact_registry_repository.openwiki.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${local.cloud_build_compute_service_agent}"
}

resource "google_artifact_registry_repository_iam_member" "cloud_build_legacy_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.openwiki.location
  repository = google_artifact_registry_repository.openwiki.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${local.cloud_build_legacy_service_agent}"
}

resource "google_project_iam_member" "cloud_build_compute_storage_viewer" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${local.cloud_build_compute_service_agent}"
}

resource "google_project_iam_member" "cloud_build_compute_logging_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${local.cloud_build_compute_service_agent}"
}

resource "google_storage_bucket" "openwiki" {
  name                        = "${var.project_id}-${var.name}-data"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = var.force_destroy_bucket

  labels = {
    app       = "openwiki"
    component = "workspace"
    prefix    = var.name
  }

  depends_on = [google_project_service.required["storage.googleapis.com"]]
}

resource "google_service_account" "openwiki" {
  account_id   = var.name
  display_name = "OpenWiki Cloud Run ${var.name}"

  depends_on = [google_project_service.required["iam.googleapis.com"]]
}

resource "random_password" "database" {
  length  = 40
  special = false
}

resource "random_password" "trusted_auth" {
  length  = 48
  special = false
}

resource "google_sql_database_instance" "openwiki" {
  name                = var.name
  database_version    = var.sql_database_version
  region              = var.region
  deletion_protection = var.sql_deletion_protection

  settings {
    tier                     = var.sql_tier
    edition                  = var.sql_edition
    availability_type        = var.sql_availability_type
    disk_size                = var.sql_disk_size_gb
    disk_type                = "PD_SSD"
    disk_autoresize          = var.sql_disk_autoresize
    connector_enforcement    = "REQUIRED"
    retain_backups_on_delete = false

    backup_configuration {
      enabled = var.sql_backup_enabled
    }

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    user_labels = {
      app       = "openwiki"
      component = "postgres"
      prefix    = var.name
    }
  }

  depends_on = [google_project_service.required["sqladmin.googleapis.com"]]
}

resource "google_sql_database" "openwiki" {
  name     = var.database_name
  instance = google_sql_database_instance.openwiki.name
}

resource "google_sql_user" "openwiki" {
  name            = var.database_user
  instance        = google_sql_database_instance.openwiki.name
  password        = random_password.database.result
  deletion_policy = "ABANDON"
}

resource "google_secret_manager_secret" "database_url" {
  count = local.managed_database_url_secret ? 1 : 0

  project         = var.project_id
  secret_id       = "${var.name}-database-url"
  deletion_policy = "DELETE"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "database_url" {
  count = local.managed_database_url_secret ? 1 : 0

  secret      = google_secret_manager_secret.database_url[0].id
  secret_data = local.database_url

  depends_on = [
    google_sql_database.openwiki,
    google_sql_user.openwiki,
  ]
}

resource "google_secret_manager_secret" "trusted_auth" {
  count = local.managed_trusted_auth_secret ? 1 : 0

  project         = var.project_id
  secret_id       = "${var.name}-trusted-auth"
  deletion_policy = "DELETE"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "trusted_auth" {
  count = local.managed_trusted_auth_secret ? 1 : 0

  secret      = google_secret_manager_secret.trusted_auth[0].id
  secret_data = random_password.trusted_auth.result
}

resource "google_storage_bucket_iam_member" "openwiki" {
  bucket = google_storage_bucket.openwiki.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.openwiki.email}"
}

resource "google_project_iam_member" "openwiki_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.openwiki.email}"
}

resource "google_secret_manager_secret_iam_member" "database_url_accessor" {
  project   = var.project_id
  secret_id = local.database_url_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.openwiki.email}"

  depends_on = [google_secret_manager_secret_version.database_url]
}

resource "google_secret_manager_secret_iam_member" "trusted_auth_accessor" {
  project   = var.project_id
  secret_id = local.trusted_auth_headers_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.openwiki.email}"

  depends_on = [google_secret_manager_secret_version.trusted_auth]
}

resource "google_cloud_run_v2_service" "openwiki" {
  name                = var.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.openwiki.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "${var.service_timeout_seconds}s"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instance_count
    }

    containers {
      name       = "openwiki"
      image      = local.image
      depends_on = ["cloud-sql-proxy"]

      ports {
        name           = "http1"
        container_port = local.port
      }

      dynamic "env" {
        for_each = local.service_env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = local.database_url_secret_name
            version = "latest"
          }
        }
      }

      env {
        name = "OPENWIKI_TRUST_AUTH_HEADERS_SECRET"
        value_source {
          secret_key_ref {
            secret  = local.trusted_auth_headers_secret_name
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = var.app_cpu
          memory = var.app_memory
        }
        startup_cpu_boost = true
      }

      startup_probe {
        failure_threshold = 24
        period_seconds    = 10
        timeout_seconds   = 5
        tcp_socket {
          port = local.port
        }
      }

      volume_mounts {
        name       = "wiki-data"
        mount_path = "/data/wiki"
      }
    }

    containers {
      name  = "cloud-sql-proxy"
      image = var.cloud_sql_proxy_image
      args  = ["--address=0.0.0.0", "--port=5432", google_sql_database_instance.openwiki.connection_name]

      resources {
        limits = {
          cpu    = var.cloud_sql_proxy_cpu
          memory = var.cloud_sql_proxy_memory
        }
        startup_cpu_boost = true
      }

      startup_probe {
        failure_threshold = 24
        period_seconds    = 10
        timeout_seconds   = 5
        tcp_socket {
          port = 5432
        }
      }
    }

    volumes {
      name = "wiki-data"

      gcs {
        bucket    = google_storage_bucket.openwiki.name
        read_only = false
      }
    }
  }

  depends_on = [
    google_project_service.required["run.googleapis.com"],
    google_project_iam_member.openwiki_cloudsql_client,
    google_secret_manager_secret_iam_member.database_url_accessor,
    google_secret_manager_secret_iam_member.trusted_auth_accessor,
    google_storage_bucket_iam_member.openwiki,
  ]
}

resource "google_cloud_run_v2_job" "worker" {
  name                = "${var.name}-worker"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account       = google_service_account.openwiki.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      timeout               = "${var.job_timeout_seconds}s"
      max_retries           = 0

      containers {
        name       = "openwiki"
        image      = local.image
        args       = ["worker", "--once", "--max-jobs", tostring(var.worker_max_jobs), "--poll-ms", tostring(var.worker_poll_ms), "--json"]
        depends_on = ["cloud-sql-proxy"]

        dynamic "env" {
          for_each = local.job_env
          content {
            name  = env.value.name
            value = env.value.value
          }
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = local.database_url_secret_name
              version = "latest"
            }
          }
        }

        env {
          name = "OPENWIKI_TRUST_AUTH_HEADERS_SECRET"
          value_source {
            secret_key_ref {
              secret  = local.trusted_auth_headers_secret_name
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = var.app_cpu
            memory = var.app_memory
          }
        }

        volume_mounts {
          name       = "wiki-data"
          mount_path = "/data/wiki"
        }
      }

      containers {
        name  = "cloud-sql-proxy"
        image = var.cloud_sql_proxy_image
        args  = ["--address=0.0.0.0", "--port=5432", google_sql_database_instance.openwiki.connection_name]

        resources {
          limits = {
            cpu    = var.cloud_sql_proxy_cpu
            memory = var.cloud_sql_proxy_memory
          }
        }

        startup_probe {
          failure_threshold = 24
          period_seconds    = 10
          timeout_seconds   = 5
          tcp_socket {
            port = 5432
          }
        }
      }

      volumes {
        name = "wiki-data"

        gcs {
          bucket    = google_storage_bucket.openwiki.name
          read_only = false
        }
      }
    }
  }

  depends_on = [google_cloud_run_v2_service.openwiki]
}

resource "google_cloud_run_v2_job" "rebuild" {
  name                = "${var.name}-rebuild"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account       = google_service_account.openwiki.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      timeout               = "${var.rebuild_timeout_seconds}s"
      max_retries           = 0

      containers {
        name       = "openwiki"
        image      = local.image
        command    = ["sh"]
        args       = ["-c", "pnpm openwiki -- --root /data/wiki db migrate && pnpm openwiki -- --root /data/wiki index && pnpm openwiki -- --root /data/wiki db rebuild && pnpm openwiki -- --root /data/wiki db sync-postgres --full"]
        depends_on = ["cloud-sql-proxy"]

        dynamic "env" {
          for_each = local.job_env
          content {
            name  = env.value.name
            value = env.value.value
          }
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = local.database_url_secret_name
              version = "latest"
            }
          }
        }

        env {
          name = "OPENWIKI_TRUST_AUTH_HEADERS_SECRET"
          value_source {
            secret_key_ref {
              secret  = local.trusted_auth_headers_secret_name
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = var.app_cpu
            memory = var.app_memory
          }
        }

        volume_mounts {
          name       = "wiki-data"
          mount_path = "/data/wiki"
        }
      }

      containers {
        name  = "cloud-sql-proxy"
        image = var.cloud_sql_proxy_image
        args  = ["--address=0.0.0.0", "--port=5432", google_sql_database_instance.openwiki.connection_name]

        resources {
          limits = {
            cpu    = var.cloud_sql_proxy_cpu
            memory = var.cloud_sql_proxy_memory
          }
        }

        startup_probe {
          failure_threshold = 24
          period_seconds    = 10
          timeout_seconds   = 5
          tcp_socket {
            port = 5432
          }
        }
      }

      volumes {
        name = "wiki-data"

        gcs {
          bucket    = google_storage_bucket.openwiki.name
          read_only = false
        }
      }
    }
  }

  depends_on = [google_cloud_run_v2_service.openwiki]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count = var.allow_unauthenticated ? 1 : 0

  name     = google_cloud_run_v2_service.openwiki.name
  location = google_cloud_run_v2_service.openwiki.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_billing_budget" "openwiki" {
  count = var.billing_account_id == null ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "${var.name} disposable OpenWiki test"

  amount {
    specified_amount {
      currency_code = var.budget_currency_code
      units         = tostring(var.budget_amount_units)
    }
  }

  budget_filter {
    calendar_period = "MONTH"
    projects        = ["projects/${data.google_project.current.number}"]
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 0.8
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  depends_on = [google_project_service.required["billingbudgets.googleapis.com"]]
}
