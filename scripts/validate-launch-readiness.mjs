#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'

function read(path) {
  return readFileSync(path, 'utf8')
}

function readJson(path) {
  return JSON.parse(read(path))
}

function assertFile(path) {
  if (!existsSync(path)) throw new Error(`${path} is required`)
}

function assertIncludes(path, text) {
  const contents = read(path)
  if (!contents.includes(text)) throw new Error(`${path} must include ${text}`)
}

function assertPositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
}

function assertNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`)
  }
}

function log(message) {
  process.stdout.write(`[launch-validate] ${message}\n`)
}

const targetsPath = 'deploy/load/launch-readiness-targets.json'
const evidenceMatrixPath = 'deploy/load/launch-evidence-matrix.json'
const harnessPath = 'scripts/launch-readiness.mjs'
const readinessDocPath = 'docs/deployment-readiness.md'
const runbookPath = 'docs/runbooks/launch-readiness.md'
const reportPath = 'docs/runbooks/launch-readiness-report.md'
const releaseChecklistPath = 'docs/release-checklist.md'
const evidenceRecordPath = 'deploy/private-beta/launch-evidence-record.template.json'
const publicGoNoGoPath = 'deploy/private-beta/private-beta-go-no-go.public.md'
const evidenceValidatorPath = 'scripts/validate-launch-evidence-manifest.mjs'
const failoverDrillPath = 'scripts/launch-failover-drill.mjs'
const packagePath = 'package.json'

for (const path of [
  targetsPath,
  evidenceMatrixPath,
  harnessPath,
  readinessDocPath,
  runbookPath,
  reportPath,
  releaseChecklistPath,
  evidenceRecordPath,
  publicGoNoGoPath,
  evidenceValidatorPath,
  failoverDrillPath,
  packagePath,
]) {
  assertFile(path)
}

const packageJson = readJson(packagePath)

function assertPackageScriptForCommand(command, label) {
  const match = /^pnpm\s+([^\s]+)(?:\s|$)/.exec(command)
  if (!match) return
  const script = match[1]
  if (typeof packageJson.scripts?.[script] !== 'string') {
    throw new Error(`${label} references missing package script ${script}`)
  }
}

const targets = readJson(targetsPath)
for (const profileName of ['local-self-host-beta', 'private-beta', 'public-beta', 'enterprise-scale']) {
  const profile = targets.profiles?.[profileName]
  if (!profile) throw new Error(`${targetsPath} is missing ${profileName}`)
  assertPositiveNumber(profile.durationMs, `${profileName}.durationMs`)
  assertPositiveNumber(profile.soakDurationMs, `${profileName}.soakDurationMs`)
  assertPositiveNumber(profile.concurrency, `${profileName}.concurrency`)
  assertPositiveNumber(profile.requestRatePerSecond, `${profileName}.requestRatePerSecond`)
  for (const key of [
    'concurrentCloudUsers',
    'concurrentDesktopClients',
    'concurrentGatewayChannels',
    'concurrentSseStreams',
    'storedCloudThreads',
    'sessionCreatesPerMinute',
    'promptCommandsPerMinute',
    'activeWorkerSessions',
    'workflowRunsPerMinute',
    'gatewayInboundMessagesPerMinute',
    'gatewayOutboundDeliveriesPerMinute',
    'artifactUploadsPerMinute',
    'adminDashboardReadsPerMinute',
  ]) {
    assertPositiveNumber(profile.capacityTargets?.[key], `${profileName}.capacityTargets.${key}`)
  }
  for (const key of [
    'maxOverallErrorRate',
    'maxOperationErrorRate',
    'p95ReadLatencyMs',
    'p95MutationLatencyMs',
    'p95GatewayLatencyMs',
    'maxProjectionLagEvents',
    'maxCommandOldestAgeMs',
    'maxSseReconnectsPerMinute',
  ]) {
    assertPositiveNumber(profile.thresholds?.[key], `${profileName}.thresholds.${key}`)
  }
  assertNonNegativeNumber(
    profile.thresholds?.maxUnexpectedQuotaRejections,
    `${profileName}.thresholds.maxUnexpectedQuotaRejections`,
  )
  assertNonNegativeNumber(
    profile.thresholds?.maxGatewayDeadLetters,
    `${profileName}.thresholds.maxGatewayDeadLetters`,
  )
}

const evidenceMatrix = readJson(evidenceMatrixPath)
if (evidenceMatrix.schemaVersion !== 1) throw new Error(`${evidenceMatrixPath} must declare schemaVersion 1`)
if (evidenceMatrix.purpose !== 'launch-evidence-tier-matrix') {
  throw new Error(`${evidenceMatrixPath} must declare purpose launch-evidence-tier-matrix`)
}
if (evidenceMatrix.acceptedPublicTier !== 'local-self-host-beta') {
  throw new Error(`${evidenceMatrixPath} must accept only local-self-host-beta as the current public tier`)
}
assertIncludes(evidenceMatrixPath, 'does not claim managed public SaaS, GA, or enterprise-scale readiness')
assertIncludes(evidenceMatrixPath, 'private operations repositories')

for (const tier of [
  'local-self-host-beta',
  'private-beta',
  'public-beta',
  'general-availability',
  'enterprise-scale',
]) {
  const record = evidenceMatrix.tiers?.[tier]
  if (!record) throw new Error(`${evidenceMatrixPath} is missing tier ${tier}`)
  if (tier === 'local-self-host-beta') {
    if (record.claimStatus !== 'accepted-public') throw new Error(`${tier} must be the only accepted public tier`)
  } else if (!['requires-private-ops-evidence', 'not-claimed'].includes(record.claimStatus)) {
    throw new Error(`${tier} must not be accepted in public launch evidence`)
  }
}

for (const category of [
  'loadAndSoak',
  'failoverRecovery',
  'backupRestore',
  'securityBoundary',
  'releasePackaging',
  'findingsWorkflow',
]) {
  const record = evidenceMatrix.evidenceCategories?.[category]
  if (!record) throw new Error(`${evidenceMatrixPath} is missing evidence category ${category}`)
  if (record.requiredForAcceptedTier !== true) throw new Error(`${category} must be required for the accepted tier`)
  if (!Array.isArray(record.publicArtifacts) || record.publicArtifacts.length === 0) {
    throw new Error(`${category} must list public evidence artifacts`)
  }
  if (!Array.isArray(record.requiredCommands) || record.requiredCommands.length === 0) {
    throw new Error(`${category} must list required commands`)
  }
  if (typeof record.passCondition !== 'string' || record.passCondition.length < 20) {
    throw new Error(`${category} must describe a concrete pass condition`)
  }
  for (const artifact of record.publicArtifacts) assertFile(artifact)
  for (const command of record.requiredCommands) assertPackageScriptForCommand(command, category)
}

const requiredPrivateBetaEvidenceIds = [
  'deployedDesktopWebGatewayContinuation',
  'deployedLoadTest',
  'deployedSoakTest',
  'workerFailover',
  'schedulerReplicaFailover',
  'postgresBackupRestore',
  'objectStoreArtifactRoundTrip',
  'secretAdapterResolution',
  'byokRedactionNoPlaintext',
  'gatewayDeliveryReplayDeadLetter',
  'quotaRateLimitBehavior',
  'billingEntitlementGating',
  'supportIncidentOwnershipEscalation',
  'costSloNotes',
  'releaseRollback',
]
if (evidenceMatrix.privateBetaEvidenceItems?.requiredStatusForGo !== 'private-pass') {
  throw new Error(`${evidenceMatrixPath} must require private-pass before a private-beta go decision`)
}
if (typeof evidenceMatrix.privateBetaEvidenceItems?.storageRule !== 'string') {
  throw new Error(`${evidenceMatrixPath} must document private beta evidence storage rules`)
}
const privateBetaItems = evidenceMatrix.privateBetaEvidenceItems?.items ?? {}
for (const id of requiredPrivateBetaEvidenceIds) {
  const record = privateBetaItems[id]
  if (!record) throw new Error(`${evidenceMatrixPath} is missing private beta evidence item ${id}`)
  if (record.requiredForPrivateBeta !== true) throw new Error(`${id} must be required for private beta`)
  if (!Array.isArray(record.publicArtifacts) || record.publicArtifacts.length === 0) {
    throw new Error(`${id} must list public evidence artifacts`)
  }
  for (const artifact of record.publicArtifacts) assertFile(artifact)
  if (!Array.isArray(record.requiredCommands) || record.requiredCommands.length === 0) {
    throw new Error(`${id} must list required evidence commands`)
  }
  for (const command of record.requiredCommands) assertPackageScriptForCommand(command, id)
  if (typeof record.passCondition !== 'string' || record.passCondition.length < 30) {
    throw new Error(`${id} must define a concrete pass condition`)
  }
}
for (const id of Object.keys(privateBetaItems)) {
  if (!requiredPrivateBetaEvidenceIds.includes(id)) {
    throw new Error(`${evidenceMatrixPath} has unexpected private beta evidence item ${id}`)
  }
}

for (const command of [
  'pnpm deploy:load:plan',
  'pnpm deploy:load',
  'pnpm deploy:load:strict',
  'pnpm deploy:soak',
  'pnpm deploy:soak:strict',
  'pnpm deploy:continuation:smoke',
  'pnpm deploy:gateway:smoke',
  'pnpm deploy:gcp:preflight',
  'pnpm deploy:gcp:smoke',
  'pnpm deploy:failover:drill',
  'pnpm test',
  'pnpm docs:build',
  'pnpm deploy:private-beta:validate',
  'pnpm deploy:launch:validate',
  'pnpm deploy:launch:evidence:validate',
  'pnpm deploy:promotion:validate -- --tier local-self-host-beta',
  'pnpm ops:validate',
  'git diff --check',
]) {
  assertIncludes(evidenceMatrixPath, command)
}

for (const phrase of [
  'cloud session create/list/prompt/event replay',
  'SSE fanout and reconnect',
  'worker claim/retry/reaper paths',
  'workflow due-run claims',
  'Gateway delivery feed and render backpressure',
  'artifact metadata/list/download paths',
  'admin summary pagination',
  'quota and entitlement denial paths',
  'BYOK reveal failure and denial paths',
  'worker crash during pending command',
  'lease expiry and stale-owner write rejection',
  'scheduler restart with due workflow runs',
  'Gateway restart with delivery cursor resume',
  'Cloud Web/API restart with SSE reconnect',
  'object-store transient failure',
  'Postgres control-plane records',
  'Gateway channel bindings and deliveries',
  'BYOK secret references and reveal denial behavior',
  'no raw secrets in payloads/cache/logs/renderer/gateway/diagnostics/metrics',
  'operator endpoints separate from tenant user APIs',
  'public webhook ingress fails closed',
  'public templates contain no private values',
  'Desktop packaging smoke',
  'Cloud Web build and browser smoke',
  'Gateway image/package smoke',
  'MCP package smoke',
  'script-contract tests',
  'narrow-follow-up-issue',
  'tier-scoped-out-of-scope',
  'deployedDesktopWebGatewayContinuation',
  'gatewayDeliveryReplayDeadLetter',
  'supportIncidentOwnershipEscalation',
  'costSloNotes',
  'releaseRollback',
]) {
  assertIncludes(evidenceMatrixPath, phrase)
}

for (const forbidden of [
  '/Users/joe',
  'OPEN_COWORK_GCP_PROJECT=',
  'joe-broadhead/open-cowork-cloud',
  'sk-',
  'ghp_',
  'xoxb-',
  'AIza',
  'price_',
  'prod_',
  'acct_',
  'cus_',
  'sub_',
  'OPEN_COWORK_CLOUD_DATABASE_URL=postgres://',
  'OPEN_COWORK_GATEWAY_SERVICE_TOKEN=',
]) {
  if (read(evidenceMatrixPath).includes(forbidden)) {
    throw new Error(`${evidenceMatrixPath} must not include private value marker ${forbidden}`)
  }
}

for (const route of [
  '/livez',
  '/readyz',
  '/api/config',
  '/api/workspace',
  '/api/sessions',
  '/api/threads',
  '/api/workflows',
  '/api/byok',
  '/validate',
  '/api/usage/summary',
  '/api/channels/deliveries',
  '/api/events',
  '/api/metrics',
  '/health',
  '/ready',
  '/metrics',
]) {
  assertIncludes(harnessPath, route)
}

for (const phrase of [
  'OPEN_COWORK_LOAD_CLOUD_URL',
  'OPEN_COWORK_LOAD_GATEWAY_URL',
  'OPEN_COWORK_LOAD_INCLUDE_MUTATIONS',
  'OPEN_COWORK_LOAD_INCLUDE_SSE',
  'OPEN_COWORK_LOAD_OPERATOR_CHECKS',
  'OPEN_COWORK_LOAD_BYOK_PROVIDER',
  'OPEN_COWORK_LOAD_EXPECT_QUOTA_REJECTIONS',
  'OPEN_COWORK_LOAD_STRICT',
  'OPEN_COWORK_EVIDENCE_COMMIT_SHA',
  'OPEN_COWORK_EVIDENCE_CLOUD_IMAGE_DIGEST',
  'OPEN_COWORK_EVIDENCE_GATEWAY_IMAGE_DIGEST',
  'local-self-host-beta',
  'private-beta',
  'public-beta',
]) {
  assertIncludes(runbookPath, phrase)
  assertIncludes(readinessDocPath, phrase)
}

for (const phrase of [
  'Load Test Report',
  'Soak Test Report',
  'Go/No-Go',
  'Accepted Launch Tier',
  'Known Limits',
  'Cost And Scaling Notes',
  'Final Smoke',
  'Findings Workflow',
  'Launch Evidence Register',
  'deploy/private-beta/launch-evidence-record.template.json',
  'pnpm deploy:failover:drill',
  'Commit SHA',
  'Cloud image digest',
  'Gateway image digest',
  'Sanitized environment profile',
]) {
  assertIncludes(reportPath, phrase)
}

for (const phrase of [
  'createEvidenceMetadata',
  'OPEN_COWORK_EVIDENCE_COMMIT_SHA',
  'OPEN_COWORK_EVIDENCE_CLOUD_IMAGE_DIGEST',
  'OPEN_COWORK_EVIDENCE_GATEWAY_IMAGE_DIGEST',
]) {
  assertIncludes(harnessPath, phrase)
}

for (const phrase of [
  'OPEN_COWORK_EVIDENCE_COMMIT_SHA',
  'OPEN_COWORK_EVIDENCE_CLOUD_IMAGE_DIGEST',
  'OPEN_COWORK_EVIDENCE_GATEWAY_IMAGE_DIGEST',
  'durationMs',
  'environmentProfile',
]) {
  assertIncludes(failoverDrillPath, phrase)
}

for (const phrase of [
  'requiredReportFields',
  'commitSha',
  'evidenceCommands',
  'imageDigests',
  'sanitizedEnvironmentProfile',
  'dates and duration',
  'durationMs',
]) {
  assertIncludes(evidenceRecordPath, phrase)
}

for (const phrase of [
  'Decision: `no-go`',
  'Current public tier: `local-self-host-beta`',
  'pending-private-evidence',
  'deploy/private-beta/launch-evidence-record.template.json',
  'deployedDesktopWebGatewayContinuation',
  'gatewayDeliveryReplayDeadLetter',
  'supportIncidentOwnershipEscalation',
  'costSloNotes',
  'releaseRollback',
  'pnpm deploy:launch:evidence:validate -- --manifest <private-record> --require-private-pass',
  'pnpm deploy:promotion:validate -- --tier private-hosted-beta --manifest <private-record>',
]) {
  assertIncludes(publicGoNoGoPath, phrase)
}

for (const phrase of [
  'local-self-host-beta',
  'acceptedPublicTier',
  'launch-evidence-matrix.json',
  'pnpm deploy:load:plan',
  'pnpm deploy:load',
  'pnpm deploy:load:strict',
  'pnpm deploy:soak',
  'pnpm deploy:soak:strict',
  'pnpm deploy:failover:drill',
  'pnpm deploy:launch:validate',
  'pnpm deploy:launch:evidence:validate',
  'pnpm deploy:promotion:validate',
]) {
  assertIncludes(releaseChecklistPath, phrase)
}

for (const script of [
  'deploy:load:plan',
  'deploy:load',
  'deploy:load:strict',
  'deploy:soak',
  'deploy:soak:strict',
  'deploy:failover:drill',
  'deploy:launch:validate',
  'deploy:launch:evidence:validate',
  'deploy:promotion:validate',
]) {
  if (typeof packageJson.scripts?.[script] !== 'string') {
    throw new Error(`${packagePath} is missing ${script}`)
  }
}
if (!packageJson.scripts?.['deploy:load:strict']?.includes('--strict')) {
  throw new Error(`${packagePath} deploy:load:strict must run launch readiness with --strict`)
}
if (!packageJson.scripts?.['deploy:soak:strict']?.includes('--strict')) {
  throw new Error(`${packagePath} deploy:soak:strict must run launch readiness with --strict`)
}

log('launch readiness artifacts validated')
