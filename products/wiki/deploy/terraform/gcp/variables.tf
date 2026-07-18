variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Google Cloud region."
  type        = string
  default     = "europe-west4"
}

variable "name" {
  description = "Name prefix for OpenWiki resources. Keep this unique per disposable test."
  type        = string
  default     = "openwiki"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name)) && !endswith(var.name, "-")
    error_message = "name must be 3-30 lowercase letters, numbers, and dashes; it must start with a letter and not end with a dash."
  }
}

variable "image" {
  description = "OpenWiki container image. Leave empty when the evidence runner should build into the managed Artifact Registry repo; use image@sha256:digest for production-like previews."
  type        = string
  default     = ""
}

variable "openwiki_title" {
  description = "Initial OpenWiki title."
  type        = string
  default     = "OpenWiki"
}

variable "public_origin" {
  description = "Browser-visible HTTPS origin for OpenWiki. Leave empty to use the predictable Cloud Run run.app origin for this service."
  type        = string
  default     = ""
}

variable "allow_unauthenticated" {
  description = "Grant allUsers the Cloud Run invoker role."
  type        = bool
  default     = false
}

variable "production_mode" {
  description = "Require preview guardrails: private invoker, digest-pinned image, and non-force-destroy storage. This does not make Cloud Storage FUSE a production Git backend."
  type        = bool
  default     = false
}

variable "auth_boundary_notes" {
  description = "Operator note for IAP, private ingress, or another trusted auth boundary. Documentation-only; this module does not configure human login."
  type        = string
  default     = "Use IAP, private ingress, or another trusted boundary before enabling browser writes."
}

variable "trusted_auth_headers_secret_name" {
  description = "Optional existing Secret Manager secret name containing the OpenWiki trusted-header shared secret. When unset, Terraform creates a disposable generated secret."
  type        = string
  default     = null
  nullable    = true
}

variable "database_url_secret_name" {
  description = "Optional existing Secret Manager secret name containing DATABASE_URL. When unset, Terraform creates Cloud SQL credentials and a disposable generated secret for the Cloud SQL Auth Proxy sidecar."
  type        = string
  default     = null
  nullable    = true
}

variable "database_name" {
  description = "Cloud SQL database name."
  type        = string
  default     = "openwiki"
}

variable "database_user" {
  description = "Cloud SQL database user."
  type        = string
  default     = "openwiki"
}

variable "sql_database_version" {
  description = "Cloud SQL Postgres version."
  type        = string
  default     = "POSTGRES_16"
}

variable "sql_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-f1-micro"
}

variable "sql_edition" {
  description = "Cloud SQL edition. ENTERPRISE supports the default db-f1-micro disposable tier."
  type        = string
  default     = "ENTERPRISE"
}

variable "sql_availability_type" {
  description = "Cloud SQL availability type. ZONAL keeps disposable tests cheap; REGIONAL is for production-like HA exercises."
  type        = string
  default     = "ZONAL"
}

variable "sql_disk_size_gb" {
  description = "Cloud SQL disk size in GB."
  type        = number
  default     = 10
}

variable "sql_disk_autoresize" {
  description = "Enable Cloud SQL disk autoresize."
  type        = bool
  default     = false
}

variable "sql_backup_enabled" {
  description = "Enable Cloud SQL automated backups. Keep false for disposable evidence; set true for backup/restore exercises."
  type        = bool
  default     = false
}

variable "sql_deletion_protection" {
  description = "Enable Cloud SQL deletion protection."
  type        = bool
  default     = false
}

variable "cloud_sql_proxy_image" {
  description = "Cloud SQL Auth Proxy sidecar image."
  type        = string
  default     = "gcr.io/cloud-sql-connectors/cloud-sql-proxy@sha256:fa4c7308245407157c5e9c4e16f1c0f1113899d6f29dc8f8be3e30efae86467f"
}

variable "force_destroy_bucket" {
  description = "Allow Terraform destroy to remove non-empty disposable workspace buckets."
  type        = bool
  default     = true
}

variable "service_bootstrap_mode" {
  description = "OpenWiki bootstrap mode for the Cloud Run service."
  type        = string
  default     = "inline"

  validation {
    condition     = var.service_bootstrap_mode == "inline" || var.service_bootstrap_mode == "skip"
    error_message = "service_bootstrap_mode must be inline or skip."
  }
}

variable "container_concurrency" {
  description = "Cloud Run service request concurrency."
  type        = number
  default     = 1
}

variable "max_instance_count" {
  description = "Cloud Run service max instance count for disposable tests."
  type        = number
  default     = 1
}

variable "service_timeout_seconds" {
  description = "Cloud Run service request timeout in seconds."
  type        = number
  default     = 300
}

variable "job_timeout_seconds" {
  description = "Cloud Run worker job timeout in seconds."
  type        = number
  default     = 900
}

variable "rebuild_timeout_seconds" {
  description = "Cloud Run rebuild/sync job timeout in seconds."
  type        = number
  default     = 900
}

variable "worker_max_jobs" {
  description = "Maximum queued jobs processed per worker execution."
  type        = number
  default     = 1
}

variable "worker_poll_ms" {
  description = "Worker polling interval in milliseconds."
  type        = number
  default     = 1000
}

variable "app_cpu" {
  description = "CPU limit for OpenWiki containers."
  type        = string
  default     = "1"
}

variable "app_memory" {
  description = "Memory limit for OpenWiki containers."
  type        = string
  default     = "1Gi"
}

variable "cloud_sql_proxy_cpu" {
  description = "CPU limit for Cloud SQL Auth Proxy sidecars."
  type        = string
  default     = "1"
}

variable "cloud_sql_proxy_memory" {
  description = "Memory limit for Cloud SQL Auth Proxy sidecars."
  type        = string
  default     = "256Mi"
}

variable "billing_account_id" {
  description = "Optional billing account ID for a disposable project-scoped budget, for example 000000-000000-000000. Leave null to skip budget creation."
  type        = string
  default     = null
  nullable    = true
}

variable "budget_amount_units" {
  description = "Whole currency units for the optional disposable budget."
  type        = number
  default     = 25
}

variable "budget_currency_code" {
  description = "Currency code for the optional disposable budget. Must match the billing account currency when set."
  type        = string
  default     = "EUR"
}
