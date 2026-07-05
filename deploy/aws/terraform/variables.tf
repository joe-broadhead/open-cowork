variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-1"
}

variable "name_prefix" {
  description = "Resource name prefix (lowercase, hyphenated)."
  type        = string
  default     = "open-cowork"
}

variable "cloud_image" {
  description = "Fully-qualified open-cowork-cloud image (e.g. ACCOUNT.dkr.ecr.REGION.amazonaws.com/open-cowork-cloud:TAG)."
  type        = string
}

variable "vpc_id" {
  description = "VPC hosting the deployment (bring your own landing zone)."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for Fargate tasks and RDS."
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnets for the web ALB."
  type        = list(string)
}

variable "acm_certificate_arn" {
  description = "ACM certificate for the web HTTPS listener."
  type        = string
}

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "database_allocated_storage_gb" {
  description = "RDS allocated storage (GiB)."
  type        = number
  default     = 50
}

variable "postgres_engine_version" {
  description = "RDS Postgres engine version."
  type        = string
  default     = "16.4"
}

variable "database_user" {
  description = "Master database user (password is RDS-managed in Secrets Manager, never in state)."
  type        = string
  default     = "open_cowork"
}

variable "task_cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)."
  type        = string
  default     = "1024"
}

variable "task_memory_mb" {
  description = "Fargate task memory (MiB)."
  type        = string
  default     = "2048"
}

variable "web_desired_count" {
  description = "Web role replicas (SSE clients re-attach on drain)."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Worker role replicas (workers hold OpenCode sessions; scale deliberately)."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "secret_arns" {
  description = "Secrets Manager secret ARNs the task execution role may read."
  type        = list(string)
  default     = []
}

variable "secret_env" {
  description = "Environment variable name -> Secrets Manager secret ARN map injected into every role (values stay in Secrets Manager, never in state)."
  type        = map(string)
  default     = {}
}
