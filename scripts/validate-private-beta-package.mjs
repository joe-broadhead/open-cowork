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

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function assertArrayIncludes(value, expected, label) {
  if (!Array.isArray(value) || !value.includes(expected)) {
    throw new Error(`${label} must include ${expected}`)
  }
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
  'deploy/private-beta/private-beta-launch-profile.template.json',
  'deploy/private-beta/design-partner-onboarding.template.md',
  'deploy/private-beta/go-no-go-report.template.md',
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
  'create or invite org owner',
  'verify membership and role',
  'write-only endpoint',
  'continue the same thread from Desktop',
  'validation commands with timestamps',
  'support owner',
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
  'Incident Checklists',
  'Suspected Key Exposure',
  'Token Compromise',
  'Channel Identity Misbinding',
  'Customer Offboarding',
  'Never attach raw secrets',
]) {
  assertIncludes('docs/runbooks/private-beta-support.md', phrase)
}

for (const phrase of [
  'hosted-byok.config.example.json',
  'self-host-oss.config.example.json',
  'private-beta-plans.json',
  'private-beta-launch-profile.template.json',
  'design-partner-onboarding.template.md',
  'go-no-go-report.template.md',
  'provider-neutral',
  'cloud.billing.provider=none',
  'pnpm deploy:private-beta:validate',
  'pnpm ops:validate',
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
if (hosted.contractVersion !== 1) throw new Error('hosted private beta config must declare contractVersion 1')
if (hosted.cloud?.auth?.signupMode !== 'invite') throw new Error('hosted private beta config must use invite signup mode')
if (hosted.cloud?.billing?.provider !== 'stub') throw new Error('hosted private beta config must keep billing stubbed')
if (hosted.cloudDesktop?.requireManagedOrg !== true) throw new Error('hosted private beta config must require a managed org')
if (hosted.gateway?.mode !== 'managed') throw new Error('hosted private beta config must declare managed gateway mode')
if (hosted.gateway?.metrics?.enabled !== true) throw new Error('hosted private beta config must expose protected operator metrics')
if (!hosted.gateway?.server?.adminToken) throw new Error('hosted private beta config must require gateway admin token')

const selfHost = readJson('deploy/private-beta/self-host-oss.config.example.json')
if (selfHost.contractVersion !== 1) throw new Error('self-host config must declare contractVersion 1')
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
  assertPositiveInteger(plan.entitlements?.maxWorkerMinutesPerHour, `${plan.planKey}.maxWorkerMinutesPerHour`)
  assertPositiveInteger(plan.entitlements?.maxGatewayDeliveriesPerHour, `${plan.planKey}.maxGatewayDeliveriesPerHour`)
  assertPositiveInteger(plan.entitlements?.maxGatewayChannelBindingsPerOrg, `${plan.planKey}.maxGatewayChannelBindingsPerOrg`)
  assertPositiveInteger(plan.entitlements?.maxArtifactBytesPerDay, `${plan.planKey}.maxArtifactBytesPerDay`)
  if (plan.entitlements?.allowWorkers !== true || plan.entitlements?.allowPrompts !== true) {
    throw new Error(`${plan.planKey} must allow private beta execution`)
  }
}

const launchProfile = readJson('deploy/private-beta/private-beta-launch-profile.template.json')
if (launchProfile.purpose !== 'managed-byok-private-beta-launch-profile-template') {
  throw new Error('private beta launch profile template must declare its purpose')
}
assertIncludes('deploy/private-beta/private-beta-launch-profile.template.json', '{private-ops-ticket-or-runbook-url}')
assertIncludes('deploy/private-beta/private-beta-launch-profile.template.json', '{production-like-environment-name}')
if (launchProfile.evidenceBoundary?.redactionRequiredBeforeSharing !== true) {
  throw new Error('launch profile must require redaction before sharing evidence')
}
const profile = launchProfile.profile
if (profile?.launchReadinessTarget !== 'private-beta') {
  throw new Error('launch profile must target private-beta')
}
if (profile?.billingMode !== 'manual-or-stub') {
  throw new Error('launch profile must keep private beta billing manual or stubbed')
}
assertNonEmptyString(profile?.support?.primaryOwner, 'launchProfile.support.primaryOwner')
assertNonEmptyString(profile?.support?.escalationChannel, 'launchProfile.support.escalationChannel')
assertPositiveInteger(profile?.support?.responseTargets?.sev1Minutes, 'launchProfile.support.responseTargets.sev1Minutes')
assertPositiveInteger(profile?.entitlements?.maxSeatsPerOrg, 'launchProfile.entitlements.maxSeatsPerOrg')
assertPositiveInteger(profile?.entitlements?.maxConcurrentSessionsPerOrg, 'launchProfile.entitlements.maxConcurrentSessionsPerOrg')
assertPositiveInteger(profile?.entitlements?.maxActiveWorkersPerOrg, 'launchProfile.entitlements.maxActiveWorkersPerOrg')
assertPositiveInteger(profile?.entitlements?.maxPromptsPerHour, 'launchProfile.entitlements.maxPromptsPerHour')
assertPositiveInteger(profile?.entitlements?.maxApiRequestsPerMinute, 'launchProfile.entitlements.maxApiRequestsPerMinute')
if (profile?.allowedProviderPolicy?.validation !== 'required-before-first-run-or-audited-override') {
  throw new Error('launch profile must require provider validation or an audited override')
}
if (profile?.allowedProviderPolicy?.runtimeInjection !== 'provider-options-only') {
  throw new Error('launch profile must require provider-options-only runtime injection')
}
if (profile?.allowedProviderPolicy?.plaintextReadbackAllowed !== false) {
  throw new Error('launch profile must forbid BYOK plaintext readback')
}
assertArrayIncludes(profile?.allowedProviderPolicy?.providerIds, 'anthropic', 'launchProfile.allowedProviderPolicy.providerIds')
assertArrayIncludes(profile?.allowedProviderPolicy?.blockedByDefault, 'github-copilot', 'launchProfile.allowedProviderPolicy.blockedByDefault')
for (const provider of ['telegram', 'slack', 'email', 'webhook']) {
  if (!profile?.gatewayProviderAvailability?.some((entry) => entry.provider === provider)) {
    throw new Error(`launch profile must document ${provider} gateway availability`)
  }
}
assertPositiveInteger(profile?.rpoRto?.postgresRpoMinutes, 'launchProfile.rpoRto.postgresRpoMinutes')
assertPositiveInteger(profile?.rpoRto?.objectStoreRpoMinutes, 'launchProfile.rpoRto.objectStoreRpoMinutes')
assertPositiveInteger(profile?.rpoRto?.targetRtoMinutes, 'launchProfile.rpoRto.targetRtoMinutes')
for (const evidence of [
  'launchReadinessDryRun',
  'workerFailoverWithPendingCommands',
  'gatewayRestartWithPendingDeliveries',
  'backupRestoreDrill',
  'objectStoreArtifactAfterRestore',
  'byokProviderCallAfterWorkerRestart',
  'desktopWebGatewayContinuation',
  'tokenRevocationProof',
  'diagnosticsRedactionProof',
]) {
  if (profile?.requiredEvidence?.[evidence] !== true) {
    throw new Error(`launch profile must require ${evidence}`)
  }
}
for (const command of [
  'pnpm deploy:private-beta:validate',
  'pnpm deploy:launch:validate',
  'pnpm ops:validate',
  'pnpm deploy:continuation:smoke',
  'pnpm deploy:load',
  'pnpm deploy:soak',
]) {
  assertArrayIncludes(profile?.requiredSmokeCommands, command, 'launchProfile.requiredSmokeCommands')
}

for (const phrase of [
  'Required Ten-Step Flow',
  'Create or invite org owner',
  'Verify org membership and role',
  'Configure BYOK provider key through write-only endpoint',
  'Run provider validation or audited override',
  'Issue Desktop token or managed Desktop connection config',
  'Issue Gateway service token and channel binding',
  'Confirm Cloud Web workbench bootstrap and admin surface',
  'Run first synced cloud thread from Web',
  'Continue same thread from Desktop',
  'Continue or notify through Gateway',
  'Token Lifecycle Proof',
  'Secret Redaction Proof',
  'Blocking Behavior Proof',
]) {
  assertIncludes('deploy/private-beta/design-partner-onboarding.template.md', phrase)
}

for (const phrase of [
  'Launch Profile And Environment',
  'Exact Commit And Release Artifact',
  'Validation Commands With Timestamps',
  'Load And Soak Summary',
  'Failover And Restore Summary',
  'Security Boundary Checklist',
  'Known Risks And Mitigations',
  'Decision',
  'BYOK plaintext absent',
  'Gateway is a channel client and delivery adapter',
]) {
  assertIncludes('deploy/private-beta/go-no-go-report.template.md', phrase)
}

for (const path of [
  'docs/runbooks/private-beta-launch.md',
  'docs/runbooks/private-beta-support.md',
  'deploy/private-beta/README.md',
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/private-beta-plans.json',
  'deploy/private-beta/private-beta-launch-profile.template.json',
  'deploy/private-beta/design-partner-onboarding.template.md',
  'deploy/private-beta/go-no-go-report.template.md',
]) {
  for (const forbidden of [
    '/Users/joe',
    'OPEN_COWORK_GCP_PROJECT=',
    'joe-broadhead/open-cowork-cloud',
    'sk-',
    'ghp_',
    'xoxb-',
    'AIza',
  ]) {
    assertNotIncludes(path, forbidden)
  }
}

log('private beta launch package validated')
