output "web_url" {
  description = "Public URL of the web role, or null until deploy_runtime_services is enabled after database bootstrap."
  value       = try(google_cloud_run_v2_service.cloud["web"].uri, null)
}

output "artifact_bucket" {
  description = "GCS bucket holding cloud artifacts."
  value       = google_storage_bucket.artifacts.name
}

output "sql_connection_name" {
  description = "Cloud SQL connection name for operators and migrations."
  value       = google_sql_database_instance.cloud.connection_name
}

output "runtime_service_account" {
  description = "Least-privilege runtime service account email."
  value       = google_service_account.runtime.email
}

output "runtime_database_principal" {
  description = "PostgreSQL IAM principal passed to cloud:migrate:start for runtime-role membership."
  value       = local.runtime_database_user
}

output "runtime_database_role" {
  description = "Least-privilege NOLOGIN PostgreSQL role provisioned by cloud:migrate:start."
  value       = var.runtime_database_role
}

output "migrator_service_account" {
  description = "Privileged service account used only for the reviewed one-shot migration command."
  value       = google_service_account.migrator.email
}

output "migrator_database_principal" {
  description = "PostgreSQL IAM principal used only by the migration command."
  value       = local.migrator_database_user
}
