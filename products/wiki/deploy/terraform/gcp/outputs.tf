output "url" {
  description = "OpenWiki Cloud Run provider URI."
  value       = google_cloud_run_v2_service.openwiki.uri
}

output "public_origin" {
  description = "Browser-visible OpenWiki origin configured in OPENWIKI_PUBLIC_ORIGIN."
  value       = local.public_origin
}

output "service_name" {
  description = "Cloud Run service name."
  value       = google_cloud_run_v2_service.openwiki.name
}

output "worker_job_name" {
  description = "Cloud Run worker job name."
  value       = google_cloud_run_v2_job.worker.name
}

output "rebuild_job_name" {
  description = "Cloud Run rebuild/sync job name."
  value       = google_cloud_run_v2_job.rebuild.name
}

output "bucket" {
  description = "Cloud Storage bucket mounted at /data/wiki."
  value       = google_storage_bucket.openwiki.name
}

output "sql_instance_name" {
  description = "Cloud SQL instance name."
  value       = google_sql_database_instance.openwiki.name
}

output "sql_connection_name" {
  description = "Cloud SQL connection name used by the proxy sidecars."
  value       = google_sql_database_instance.openwiki.connection_name
}

output "database_url_secret_name" {
  description = "Secret Manager secret name used for DATABASE_URL."
  value       = local.database_url_secret_name
}

output "trusted_auth_headers_secret_name" {
  description = "Secret Manager secret name used for OPENWIKI_TRUST_AUTH_HEADERS_SECRET."
  value       = local.trusted_auth_headers_secret_name
}

output "artifact_repository" {
  description = "Artifact Registry Docker repository ID."
  value       = google_artifact_registry_repository.openwiki.repository_id
}

output "artifact_image_tag" {
  description = "Default disposable image tag used when var.image is empty."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.openwiki.repository_id}/openwiki:latest"
}

output "service_account_email" {
  description = "Dedicated Cloud Run service account email."
  value       = google_service_account.openwiki.email
}

output "budget_name" {
  description = "Optional disposable budget resource name."
  value       = try(google_billing_budget.openwiki[0].name, null)
}
