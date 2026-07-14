variable "project_id" {
  description = "GCP project id that hosts the Open Cowork Cloud deployment."
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run, Cloud SQL, and the artifact bucket."
  type        = string
  default     = "europe-west1"
}

variable "name_prefix" {
  description = "Resource name prefix (lowercase, hyphenated)."
  type        = string
  default     = "open-cowork"
}

variable "cloud_image" {
  description = "Fully qualified immutable open-cowork-cloud image reference ending in @sha256:<64 lowercase hex characters>."
  type        = string

  validation {
    condition     = can(regex("^[^[:space:]@/]+/[^[:space:]@]+@sha256:[0-9a-f]{64}$", var.cloud_image))
    error_message = "cloud_image must be a fully qualified immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "vpc_self_link" {
  description = "Self link of the VPC with private-service access for Cloud SQL."
  type        = string
}

variable "vpc_subnetwork_self_link" {
  description = "Regional subnet self link used for Cloud Run Direct VPC egress to private Cloud SQL."
  type        = string
}

variable "database_tier" {
  description = "Cloud SQL Enterprise-edition machine tier."
  type        = string
  default     = "db-custom-2-7680"
}

variable "postgres_version" {
  description = "Cloud SQL Postgres version."
  type        = string
  default     = "POSTGRES_17"
}

variable "web_min_instances" {
  description = "Minimum web replicas (SSE clients re-attach on drain)."
  type        = number
  default     = 1
}

variable "web_max_instances" {
  description = "Maximum web replicas."
  type        = number
  default     = 4
}

variable "worker_instances" {
  description = "Fixed worker replica count (workers hold OpenCode sessions; scale deliberately, not per-request)."
  type        = number
  default     = 1
}

variable "web_allow_unauthenticated" {
  description = "Expose the web role publicly (true for OIDC-in-app auth; false behind IAP/LB)."
  type        = bool
  default     = true
}

variable "secret_ids" {
  description = "Secret Manager secret ids the runtime may read (session cookie secret, BYOK KMS creds, OIDC client secret, ...)."
  type        = list(string)
  default     = []
}

variable "secret_env" {
  description = "Environment variable name -> Secret Manager secret id map injected into every role (values stay in Secret Manager, never in state)."
  type        = map(string)
  default     = {}
}
