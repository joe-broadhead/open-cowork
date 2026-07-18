variable "name" {
  description = "Name prefix for OpenWiki resources."
  type        = string
  default     = "openwiki"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "image" {
  description = "OpenWiki container image. Use image@sha256:digest for production."
  type        = string
  default     = "ghcr.io/joe-broadhead/open-wiki:0.0.0"
}

variable "openwiki_title" {
  description = "Initial OpenWiki title."
  type        = string
  default     = "OpenWiki"
}

variable "public_origin" {
  description = "Browser-visible HTTPS origin for OpenWiki, for example https://wiki.example.com. Must match the authenticating proxy origin."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where OpenWiki should run."
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for the load balancer, ECS tasks, and EFS mount targets."
  type        = list(string)
}

variable "desired_count" {
  description = "Desired ECS task count. Keep this at 1 until Git write serialization is backed by hosted services."
  type        = number
  default     = 1
}

variable "worker_desired_count" {
  description = "Desired ECS worker task count for the Postgres queue backend."
  type        = number
  default     = 1
}

variable "certificate_arn" {
  description = "Optional ACM certificate ARN. When set, the ALB serves HTTPS on 443 and redirects HTTP to HTTPS."
  type        = string
  default     = ""
}

variable "production_mode" {
  description = "Require production guardrails: TLS certificate and digest-pinned image. Set false only for disposable evaluation."
  type        = bool
  default     = true
}

variable "auth_boundary_notes" {
  description = "Operator note for the upstream auth boundary, for example ALB OIDC, Cloudflare Access, or a private network. Documentation-only; this module does not configure login."
  type        = string
  default     = "Configure ALB OIDC or another trusted auth boundary before enabling write access."
}

variable "trusted_auth_headers_secret_arn" {
  description = "Secrets Manager or SSM parameter ARN containing the OpenWiki trusted-header shared secret. The upstream auth proxy must send this value as x-openwiki-proxy-secret."
  type        = string
}

variable "database_url_secret_arn" {
  description = "Secrets Manager or SSM parameter ARN containing DATABASE_URL for the Postgres runtime/read/search/queue backends required by hosted mode."
  type        = string
}

variable "runtime_secret_kms_key_arns" {
  description = "Optional customer-managed KMS key ARNs used to encrypt database_url_secret_arn or trusted_auth_headers_secret_arn. Leave empty when the secrets use AWS-managed keys."
  type        = list(string)
  default     = []
}

variable "assign_public_ip" {
  description = "Whether ECS tasks should receive public IP addresses."
  type        = bool
  default     = false
}
