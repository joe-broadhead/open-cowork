#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'

function read(path) {
  return readFileSync(path, 'utf8')
}

function parseJson(path) {
  return JSON.parse(read(path))
}

function assertFile(path) {
  if (!existsSync(path)) throw new Error(`${path} is required`)
}

function assertIncludes(path, text) {
  const contents = read(path)
  if (!contents.includes(text)) throw new Error(`${path} must include ${text}`)
}

function log(message) {
  process.stdout.write(`[ops-validate] ${message}\n`)
}

const metricCatalogPath = 'deploy/observability/metrics-catalog.json'
const alertsPath = 'deploy/observability/prometheus-alerts.yaml'
const dashboardPath = 'deploy/observability/grafana-open-cowork-overview.json'
const operationsRunbookPath = 'docs/runbooks/cloud-managed-operations.md'
const backupRunbookPath = 'docs/runbooks/backup-restore.md'
const drillReportPath = 'docs/runbooks/restore-drill-report.md'

for (const path of [
  metricCatalogPath,
  alertsPath,
  dashboardPath,
  operationsRunbookPath,
  backupRunbookPath,
  drillReportPath,
]) {
  assertFile(path)
}

const requiredMetrics = [
  'open_cowork_cloud_http_requests_total',
  'open_cowork_cloud_http_request_duration_ms',
  'open_cowork_cloud_session_create_duration_ms',
  'open_cowork_cloud_prompt_enqueue_duration_ms',
  'open_cowork_cloud_command_queue_depth',
  'open_cowork_cloud_command_oldest_age_ms',
  'open_cowork_cloud_worker_lease_claims_total',
  'open_cowork_cloud_worker_lease_renewals_total',
  'open_cowork_cloud_worker_stale_owner_rejections_total',
  'open_cowork_cloud_scheduler_claims_total',
  'open_cowork_cloud_projection_lag_events',
  'open_cowork_cloud_sse_connections',
  'open_cowork_cloud_quota_rejections_total',
  'open_cowork_cloud_auth_failures_total',
  'open_cowork_cloud_byok_reveal_failures_total',
  'open_cowork_object_store_errors_total',
  'pg_up',
  'pg_stat_activity_count',
  'pg_settings_max_connections',
  'open_cowork_gateway_incoming_messages_total',
  'open_cowork_gateway_deliveries_received_total',
  'open_cowork_gateway_deliveries_sent_total',
  'open_cowork_gateway_delivery_retries_total',
  'open_cowork_gateway_delivery_dead_letters_total',
  'open_cowork_gateway_session_streams',
  'open_cowork_gateway_stream_reconnects_total',
]

const requiredAlertMetrics = [
  'open_cowork_cloud_http_requests_total',
  'open_cowork_cloud_command_queue_depth',
  'open_cowork_cloud_command_oldest_age_ms',
  'open_cowork_cloud_scheduler_claims_total',
  'open_cowork_cloud_projection_lag_events',
  'open_cowork_cloud_quota_rejections_total',
  'open_cowork_cloud_auth_failures_total',
  'open_cowork_cloud_byok_reveal_failures_total',
  'open_cowork_object_store_errors_total',
  'pg_up',
  'pg_stat_activity_count',
  'pg_settings_max_connections',
  'open_cowork_gateway_delivery_retries_total',
  'open_cowork_gateway_delivery_dead_letters_total',
  'open_cowork_gateway_stream_reconnects_total',
]

const catalog = parseJson(metricCatalogPath)
const catalogNames = new Set((catalog.metrics || []).map((metric) => metric.name))
for (const metric of requiredMetrics) {
  if (!catalogNames.has(metric)) throw new Error(`${metricCatalogPath} is missing ${metric}`)
  assertIncludes(dashboardPath, metric)
}
for (const metric of requiredAlertMetrics) {
  assertIncludes(alertsPath, metric)
}

const dashboard = parseJson(dashboardPath)
if (!Array.isArray(dashboard.panels) || dashboard.panels.length < 8) {
  throw new Error(`${dashboardPath} must define a useful operations dashboard`)
}

for (const phrase of [
  'Web Unavailable Or Erroring',
  'Worker Backlog',
  'Scheduler Stalled',
  'Postgres Connection Exhaustion',
  'Object-Store Errors',
  'KMS Or Secret Adapter Errors',
  'OIDC Outage',
  'Gateway Provider Outage',
  'Webhook Abuse',
  'BYOK Provider Key Failure',
  'Diagnostics',
  'Restore Check',
]) {
  assertIncludes(operationsRunbookPath, phrase)
}

for (const phrase of [
  'pg_dump',
  'pg_restore',
  'gcloud storage rsync',
  'aws s3 sync',
  'az storage blob sync',
  'Postgres control plane',
  'Object storage',
  'Secret manager/KMS',
  'Restore Drill Report Requirements',
]) {
  assertIncludes(backupRunbookPath, phrase)
}

for (const phrase of [
  'Postgres restore',
  'Object-store restore',
  'Secret/KMS references',
  'Web-only boot',
  'Session projection parity',
  'Worker recovery',
  'Scheduler recovery',
  'Gateway recovery',
  'Redaction',
]) {
  assertIncludes(drillReportPath, phrase)
}

log('operations readiness artifacts validated')
