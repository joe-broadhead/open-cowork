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
const harnessPath = 'scripts/launch-readiness.mjs'
const readinessDocPath = 'docs/deployment-readiness.md'
const runbookPath = 'docs/runbooks/launch-readiness.md'
const reportPath = 'docs/runbooks/launch-readiness-report.md'
const releaseChecklistPath = 'docs/release-checklist.md'
const packagePath = 'package.json'

for (const path of [
  targetsPath,
  harnessPath,
  readinessDocPath,
  runbookPath,
  reportPath,
  releaseChecklistPath,
  packagePath,
]) {
  assertFile(path)
}

const targets = readJson(targetsPath)
for (const profileName of ['private-beta', 'public-beta', 'enterprise-scale']) {
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

for (const route of [
  '/healthz',
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
  'Known Limits',
  'Cost And Scaling Notes',
  'Final Smoke',
]) {
  assertIncludes(reportPath, phrase)
}

for (const phrase of [
  'pnpm deploy:load:plan',
  'pnpm deploy:load',
  'pnpm deploy:soak',
  'pnpm deploy:launch:validate',
]) {
  assertIncludes(releaseChecklistPath, phrase)
}

const packageJson = readJson(packagePath)
for (const script of [
  'deploy:load:plan',
  'deploy:load',
  'deploy:soak',
  'deploy:launch:validate',
]) {
  if (typeof packageJson.scripts?.[script] !== 'string') {
    throw new Error(`${packagePath} is missing ${script}`)
  }
}

log('launch readiness artifacts validated')
