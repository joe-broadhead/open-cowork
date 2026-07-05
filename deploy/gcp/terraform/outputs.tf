output "web_url" {
  description = "Public URL of the web role."
  value       = google_cloud_run_v2_service.cloud["web"].uri
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
  description = "Runtime service account email (grant additional IAM here, not to default SAs)."
  value       = google_service_account.cloud.email
}
