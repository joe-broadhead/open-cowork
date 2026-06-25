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
const launchRunbookPath = 'docs/runbooks/launch-readiness.md'
const launchReportPath = 'docs/runbooks/launch-readiness-report.md'
const managedWorkerDocsPath = 'docs/managed-workers.md'
const cloudGatewayRegistrationDocsPath = 'docs/cloud-gateway-registration.md'
const coordinationModelDocsPath = 'docs/coordination-model.md'
const deploymentTopologyDocsPath = 'docs/deployment-topologies.md'
const deploymentTopologyProfilesPath = 'deploy/topologies/topology-profiles.json'
const hybridSecurityDocsPath = 'docs/hybrid-security-gates.md'
const hybridSecurityGatesPath = 'deploy/security/hybrid-security-gates.json'
const setupHealthDocsPath = 'docs/setup-and-health-center.md'
const setupHealthContractPath = 'packages/shared/src/setup-health.ts'
const managedWorkerDeployPath = 'deploy/managed-workers/README.md'
const managedWorkerReleaseTemplatePath = 'deploy/managed-workers/worker-release-evidence.template.md'
const managedWorkerRestoreTemplatePath = 'deploy/managed-workers/worker-restore-drill.template.md'
const managedWorkerSloTemplatePath = 'deploy/observability/managed-worker-slo-template.json'

for (const path of [
  metricCatalogPath,
  alertsPath,
  dashboardPath,
  operationsRunbookPath,
  backupRunbookPath,
  drillReportPath,
  launchRunbookPath,
  launchReportPath,
  managedWorkerDocsPath,
  cloudGatewayRegistrationDocsPath,
  coordinationModelDocsPath,
  deploymentTopologyDocsPath,
  deploymentTopologyProfilesPath,
  hybridSecurityDocsPath,
  hybridSecurityGatesPath,
  setupHealthDocsPath,
  setupHealthContractPath,
  managedWorkerDeployPath,
  managedWorkerReleaseTemplatePath,
  managedWorkerRestoreTemplatePath,
  managedWorkerSloTemplatePath,
]) {
  assertFile(path)
}

const topologyProfiles = parseJson(deploymentTopologyProfilesPath)
for (const profileId of [
  'desktop-only',
  'gateway-only',
  'cloud-only',
  'cloud-channel-gateway',
  'desktop-gateway',
  'cloud-gateway-edge',
  'full-hybrid',
]) {
  if (!(topologyProfiles.profiles || []).some((profile) => profile.id === profileId)) {
    throw new Error(`${deploymentTopologyProfilesPath} is missing ${profileId}`)
  }
  assertIncludes(deploymentTopologyDocsPath, profileId)
}

const hybridSecurityGates = parseJson(hybridSecurityGatesPath)
if (hybridSecurityGates.schemaVersion !== 1 || hybridSecurityGates.purpose !== 'open-cowork-hybrid-security-gates') {
  throw new Error(`${hybridSecurityGatesPath} must declare the hybrid security gate contract`)
}
const requiredHybridGateProfiles = {
  'desktop-local': 'desktop-only',
  'desktop-pairing': 'desktop-gateway',
  'standalone-gateway': 'gateway-only',
  'cloud-worker': 'cloud-only',
  'cloud-channel-gateway': 'cloud-channel-gateway',
  'cloud-gateway-edge': 'cloud-gateway-edge',
  'full-hybrid': 'full-hybrid',
}
for (const [gateId, topologyProfileId] of Object.entries(requiredHybridGateProfiles)) {
  if (!(hybridSecurityGates.gates || []).some((gate) => gate.id === gateId)) {
    throw new Error(`${hybridSecurityGatesPath} is missing ${gateId}`)
  }
  assertIncludes(hybridSecurityDocsPath, gateId)
  assertIncludes(deploymentTopologyDocsPath, topologyProfileId)
}
for (const phrase of [
  'local_confirmation',
  'remote_allowed',
  'requires_local_confirmation',
  'blocked_by_policy',
  'Retry-After',
  'admin token',
  'provider signing',
  'HMAC',
  'backup',
  'restore',
  'redaction',
  'one execution authority',
  'customer_hosted_managed_saas_deferred',
]) {
  assertIncludes(hybridSecurityDocsPath, phrase)
}

for (const phrase of [
  'desktop-local',
  'gateway-only',
  'cloud-connect',
  'desktop-pairing',
  'full-hybrid',
  'authority-aware',
  'doctor',
  'smoke',
  'pnpm standalone-gateway:setup',
  'pnpm gateway:setup',
  'pnpm deploy:validate',
  'pnpm ops:validate',
]) {
  assertIncludes(setupHealthDocsPath, phrase)
}
for (const phrase of [
  'SETUP_INTENTS',
  'SETUP_HEALTH_CHECKS',
  'gateway.private_opencode.reachable',
  'cloud.object_store.configured',
  'pairing.remote_policy.scoped',
]) {
  assertIncludes(setupHealthContractPath, phrase)
}

const requiredMetrics = [
  'open_cowork_cloud_http_requests_total',
  'open_cowork_cloud_http_request_duration_ms',
  'open_cowork_cloud_session_create_duration_ms',
  'open_cowork_cloud_prompt_enqueue_duration_ms',
  'open_cowork_cloud_command_queue_depth_estimate',
  'open_cowork_cloud_command_oldest_age_ms',
  'open_cowork_cloud_worker_lease_claims_total',
  'open_cowork_cloud_worker_lease_renewals_total',
  'open_cowork_cloud_worker_expired_leases_reaped_total',
  'open_cowork_cloud_worker_expired_lease_reaper_drain_cap_hits_total',
  'open_cowork_cloud_worker_stale_owner_rejections_total',
  'open_cowork_cloud_scheduler_claims_total',
  'open_cowork_cloud_scheduler_expired_claims_reaped_total',
  'open_cowork_cloud_scheduler_expired_claim_reaper_drain_cap_hits_total',
  'open_cowork_cloud_projection_lag_events',
  'open_cowork_cloud_sse_connections',
  'open_cowork_cloud_quota_rejections_total',
  'open_cowork_cloud_auth_failures_total',
  'open_cowork_cloud_byok_reveal_failures_total',
  'open_cowork_cloud_object_store_operations_total',
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
  'open_cowork_gateway_provider_state',
  'open_cowork_gateway_provider_inbound_failures_total',
  'open_cowork_gateway_provider_delivery_retries_total',
  'open_cowork_gateway_provider_delivery_dead_letters_total',
  'open_cowork_gateway_provider_webhook_requests_total',
]

const requiredAlertMetrics = [
  'open_cowork_cloud_http_requests_total',
  'open_cowork_cloud_command_queue_depth_estimate',
  'open_cowork_cloud_command_oldest_age_ms',
  'open_cowork_cloud_worker_expired_leases_reaped_total',
  'open_cowork_cloud_worker_expired_lease_reaper_drain_cap_hits_total',
  'open_cowork_cloud_scheduler_claims_total',
  'open_cowork_cloud_scheduler_expired_claims_reaped_total',
  'open_cowork_cloud_scheduler_expired_claim_reaper_drain_cap_hits_total',
  'open_cowork_cloud_projection_lag_events',
  'open_cowork_cloud_quota_rejections_total',
  'open_cowork_cloud_auth_failures_total',
  'open_cowork_cloud_byok_reveal_failures_total',
  'open_cowork_cloud_object_store_operations_total',
  'pg_up',
  'pg_stat_activity_count',
  'pg_settings_max_connections',
  'open_cowork_gateway_delivery_retries_total',
  'open_cowork_gateway_delivery_dead_letters_total',
  'open_cowork_gateway_provider_state',
  'open_cowork_gateway_provider_inbound_failures_total',
  'open_cowork_gateway_provider_delivery_retries_total',
  'open_cowork_gateway_provider_delivery_dead_letters_total',
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
  'Worker Registration',
  'Worker Credential Rotation',
  'Pause, Drain, Resume, And Retire',
  'Rolling Worker Update',
  'Emergency Revoke',
  'Stuck Queue',
  'Stale Lease Spike',
  'Worker Crash Loop',
  'Tenant Offboarding',
  'Suspected Key Exposure',
  'Webhook Abuse',
  'BYOK Provider Key Failure',
  'Diagnostics',
  'Restore Check',
]) {
  assertIncludes(operationsRunbookPath, phrase)
}

for (const phrase of [
  'Phase 5 Operations Contract',
  'deploy/managed-workers/',
  'OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS',
  'Cloud Gateway Registration',
  'external_workspace',
  'edge_worker',
  'customer_hosted_managed_saas_deferred',
  'Rolling Updates',
  'Rollback And Emergency Revoke',
  'SLO And Alert Template',
  'Backup And Restore',
]) {
  assertIncludes(managedWorkerDocsPath, phrase)
}

for (const phrase of [
  'Cloud Gateway registration',
  'external_workspace',
  'edge_worker',
  'external_workspace_edge_worker',
  'gateway.registration.heartbeat',
  'gateway.edge.write_fenced_output',
  'raw_gateway_database',
  'raw_opencode_runtime_home',
  'raw_local_paths',
  'raw_provider_keys',
  'raw_mcp_secrets',
  'raw_channel_secrets',
  'gateway_private_files',
  'cloud_byok_plaintext',
  'unfenced_event_writes',
  'customer_hosted_managed_saas_deferred',
  'Drain behavior is controlled and non-destructive',
  'No database transaction may remain open while Gateway-run OpenCode work',
  'This document defines the production contract for issue #582.',
]) {
  assertIncludes(cloudGatewayRegistrationDocsPath, phrase)
}

for (const phrase of [
  'Coordination Model',
  '`CoordinationTask` is durable product work',
  'It is not `TaskRun`',
  '`CoordinationProject` is a product planning container',
  'manager teams',
  'cron jobs',
  'background jobs',
  'native delegation hints',
  '`/watch`',
]) {
  assertIncludes(coordinationModelDocsPath, phrase)
}

for (const phrase of [
  'Supported Modes',
  'Bootstrap Sequence',
  'Update And Rollback Policy',
  'Emergency revoke',
  'Sizing Guidance',
  'Required Validation',
]) {
  assertIncludes(managedWorkerDeployPath, phrase)
}

for (const phrase of [
  'Image provenance',
  'Compatibility Decision',
  'Drain And Rolling Update',
  'Rollback Drill',
  'Emergency Revoke Drill',
  'Go/No-Go',
]) {
  assertIncludes(managedWorkerReleaseTemplatePath, phrase)
}

for (const phrase of [
  'Postgres control-plane restore',
  'Object-store artifacts/checkpoints',
  'BYOK secret references',
  'Worker recovery',
  'Workflow consistency',
  'Redaction',
]) {
  assertIncludes(managedWorkerRestoreTemplatePath, phrase)
}

const managedWorkerSlo = parseJson(managedWorkerSloTemplatePath)
const managedWorkerSloIds = new Set((managedWorkerSlo.slos || []).map((slo) => slo.id))
for (const id of [
  'worker-heartbeat-freshness',
  'command-queue-age',
  'claim-latency',
  'command-latency',
  'workflow-latency',
  'projection-lag',
  'checkpoint-failures',
  'byok-reveal-failures',
  'stale-lease-reclaims',
  'gateway-worker-lag',
]) {
  if (!managedWorkerSloIds.has(id)) throw new Error(`${managedWorkerSloTemplatePath} is missing ${id}`)
}
assertIncludes(managedWorkerSloTemplatePath, 'redactionRules')

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

for (const phrase of [
  'OPEN_COWORK_LOAD_CLOUD_URL',
  'OPEN_COWORK_LOAD_INCLUDE_MUTATIONS',
  'OPEN_COWORK_LOAD_INCLUDE_SSE',
  'OPEN_COWORK_LOAD_OPERATOR_CHECKS',
  'OPEN_COWORK_LOAD_BYOK_PROVIDER',
  'OPEN_COWORK_LOAD_EXPECT_QUOTA_REJECTIONS',
  'OPEN_COWORK_LOAD_STRICT',
  'private-beta',
  'public-beta',
  'pnpm deploy:load:strict',
  'pnpm deploy:soak:strict',
]) {
  assertIncludes(launchRunbookPath, phrase)
}

for (const phrase of [
  'Load Test Report',
  'Soak Test Report',
  'Go/No-Go',
  'Cost And Scaling Notes',
  'Known Limits',
  'Final Smoke',
  'Quota And Abuse Evidence',
  'Restore And Backup Evidence',
  'Public Repo Evidence Boundary',
]) {
  assertIncludes(launchReportPath, phrase)
}

log('operations readiness artifacts validated')
