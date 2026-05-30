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

function assertNotIncludes(path, text) {
  const contents = read(path)
  if (contents.includes(text)) throw new Error(`${path} must not include ${text}`)
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
}

function log(message) {
  process.stdout.write(`[private-beta-validate] ${message}\n`)
}

const requiredFiles = [
  'docs/runbooks/private-beta-launch.md',
  'docs/runbooks/private-beta-support.md',
  'docs/runbooks/managed-byok-saas.md',
  'docs/runbooks/launch-readiness.md',
  'docs/deployment-readiness.md',
  'docs/security-model.md',
  'docs/privacy.md',
  'docs/release-checklist.md',
  'deploy/private-beta/README.md',
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/private-beta-plans.json',
  'mkdocs.yml',
  'package.json',
]

for (const path of requiredFiles) assertFile(path)

for (const phrase of [
  'Managed BYOK Onboarding Checklist',
  'Hosted BYOK Setup Flow',
  'OSS Self-Host Equivalent',
  'Managed Vs Self-Host Responsibilities',
  'Security Posture',
  'Known Private Beta Constraints',
  'Open Cowork does not resell model tokens',
  'Desktop local workspaces stay local',
  'Gateway is a channel client and delivery adapter',
  'cloud.billing.provider=none',
  'pnpm deploy:private-beta:validate',
  'pnpm deploy:continuation:smoke',
  'pnpm deploy:load',
  'pnpm deploy:soak',
]) {
  assertIncludes('docs/runbooks/private-beta-launch.md', phrase)
}

for (const phrase of [
  'Support Intake',
  'Triage Matrix',
  'Diagnostics Workflow',
  'BYOK Issue Handling',
  'Gateway Issue Handling',
  'Desktop Sync Issue Handling',
  'Never attach raw secrets',
]) {
  assertIncludes('docs/runbooks/private-beta-support.md', phrase)
}

for (const phrase of [
  'hosted-byok.config.example.json',
  'self-host-oss.config.example.json',
  'private-beta-plans.json',
  'provider-neutral',
  'cloud.billing.provider=none',
  'pnpm deploy:private-beta:validate',
]) {
  assertIncludes('deploy/private-beta/README.md', phrase)
}

for (const phrase of [
  'Private Beta Launch',
  'Private Beta Support',
]) {
  assertIncludes('mkdocs.yml', phrase)
}

for (const phrase of [
  'pnpm deploy:private-beta:validate',
  'private beta',
  'managed BYOK',
]) {
  assertIncludes('docs/release-checklist.md', phrase)
}

const packageJson = readJson('package.json')
if (packageJson.scripts?.['deploy:private-beta:validate'] !== 'node scripts/validate-private-beta-package.mjs') {
  throw new Error('package.json must expose deploy:private-beta:validate')
}

const hosted = readJson('deploy/private-beta/hosted-byok.config.example.json')
if (hosted.cloud?.auth?.signupMode !== 'invite') throw new Error('hosted private beta config must use invite signup mode')
if (hosted.cloud?.billing?.provider !== 'stub') throw new Error('hosted private beta config must keep billing stubbed')
if (hosted.cloudDesktop?.requireManagedOrg !== true) throw new Error('hosted private beta config must require a managed org')
if (hosted.gateway?.mode !== 'managed') throw new Error('hosted private beta config must declare managed gateway mode')
if (hosted.gateway?.metrics?.enabled !== true) throw new Error('hosted private beta config must expose protected operator metrics')
if (!hosted.gateway?.server?.adminToken) throw new Error('hosted private beta config must require gateway admin token')

const selfHost = readJson('deploy/private-beta/self-host-oss.config.example.json')
if (!['none', 'stub'].includes(selfHost.cloud?.billing?.provider)) {
  throw new Error('self-host config must keep billing none or stub')
}
if (selfHost.cloudDesktop?.allowUserAddedConnections !== true) {
  throw new Error('self-host config must allow user-added cloud connections')
}
if (selfHost.gateway?.mode !== 'self-host') throw new Error('self-host config must declare self-host gateway mode')
if (!selfHost.gateway?.providers?.some((provider) => provider.kind === 'webhook' && provider.credentials?.sharedSecret)) {
  throw new Error('self-host config must demonstrate signed webhook ingress')
}

const plans = readJson('deploy/private-beta/private-beta-plans.json')
if (plans.billingMode !== 'manual-or-stub') throw new Error('private beta plans must be manual-or-stub')
if (!Array.isArray(plans.prices) || plans.prices.length !== 0) {
  throw new Error('private beta plan placeholders must not commit prices')
}
if (!Array.isArray(plans.plans) || plans.plans.length < 2) throw new Error('private beta plans must include hosted and internal placeholders')
for (const plan of plans.plans) {
  if (typeof plan.planKey !== 'string' || !plan.planKey.startsWith('private-beta-')) {
    throw new Error('private beta plan keys must be placeholder private-beta-* keys')
  }
  if (!['manual', 'stub'].includes(plan.billingMode)) {
    throw new Error(`${plan.planKey} must use manual or stub billing mode`)
  }
  assertPositiveInteger(plan.entitlements?.maxConcurrentSessionsPerOrg, `${plan.planKey}.maxConcurrentSessionsPerOrg`)
  assertPositiveInteger(plan.entitlements?.maxActiveWorkersPerOrg, `${plan.planKey}.maxActiveWorkersPerOrg`)
  assertPositiveInteger(plan.entitlements?.maxPromptsPerHour, `${plan.planKey}.maxPromptsPerHour`)
  assertPositiveInteger(plan.entitlements?.maxGatewayDeliveriesPerHour, `${plan.planKey}.maxGatewayDeliveriesPerHour`)
  assertPositiveInteger(plan.entitlements?.maxArtifactBytesPerDay, `${plan.planKey}.maxArtifactBytesPerDay`)
  if (plan.entitlements?.allowWorkers !== true || plan.entitlements?.allowPrompts !== true) {
    throw new Error(`${plan.planKey} must allow private beta execution`)
  }
}

for (const path of [
  'docs/runbooks/private-beta-launch.md',
  'docs/runbooks/private-beta-support.md',
  'deploy/private-beta/README.md',
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/private-beta-plans.json',
]) {
  for (const forbidden of [
    '/Users/joe',
    'OPEN_COWORK_GCP_PROJECT=',
    'joe-broadhead/open-cowork-cloud',
    'sk-',
    'ghp_',
    'xoxb-',
  ]) {
    assertNotIncludes(path, forbidden)
  }
}

log('private beta launch package validated')
