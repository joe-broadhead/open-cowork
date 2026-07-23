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

// Machine-checkable inventory: public package templates + runbooks must exist.
// Hosted go still requires private ops evidence outside this list.
const requiredFiles = [
  'docs/runbooks/private-beta-launch.md',
  'docs/runbooks/private-beta-support.md',
  'docs/runbooks/managed-byok-saas.md',
  'docs/runbooks/managed-byok-saas-boundary.md',
  'docs/runbooks/launch-readiness.md',
  'docs/deployment-readiness.md',
  'docs/security-model.md',
  'docs/privacy.md',
  'docs/release-checklist.md',
  'deploy/private-beta/ops-evidence-package.md',
  'deploy/private-beta/README.md',
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/managed-byok-readiness-contract.template.json',
  'deploy/private-beta/private-beta-plans.json',
  'deploy/private-beta/private-beta-launch-profile.template.json',
  'deploy/private-beta/launch-evidence-record.template.json',
  'deploy/private-beta/design-partner-onboarding.template.md',
  'deploy/private-beta/go-no-go-report.template.md',
  'deploy/private-beta/private-beta-go-no-go.public.md',
  'mkdocs.yml',
  'package.json',
]

// Explicit public-package inventory (templates + public decision summary).
// All of these must remain present for package completeness; none of them
// alone constitutes hosted private-beta go.
const requiredPublicPackageTemplates = [
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/managed-byok-readiness-contract.template.json',
  'deploy/private-beta/private-beta-plans.json',
  'deploy/private-beta/private-beta-launch-profile.template.json',
  'deploy/private-beta/launch-evidence-record.template.json',
  'deploy/private-beta/design-partner-onboarding.template.md',
  'deploy/private-beta/go-no-go-report.template.md',
  'deploy/private-beta/private-beta-go-no-go.public.md',
  'deploy/private-beta/README.md',
  'deploy/private-beta/ops-evidence-package.md',
]

for (const path of requiredFiles) assertFile(path)
for (const path of requiredPublicPackageTemplates) assertFile(path)

// Completeness language: public package COMPLETE, campaign still required, no-go.
for (const phrase of [
  'Public package',
  'COMPLETE',
  'Private campaign items',
  'Still required for go',
  'no-go',
]) {
  assertIncludes('deploy/private-beta/README.md', phrase)
  assertIncludes('deploy/private-beta/ops-evidence-package.md', phrase)
}

// Go/no-go must remain no-go in the public summary until private evidence lands.
// Do not flip to go from this public package alone.
const goNoGoPath = 'deploy/private-beta/private-beta-go-no-go.public.md'
assertIncludes(goNoGoPath, 'no-go')
assertIncludes(goNoGoPath, 'Decision: `no-go`')
// Fail closed if someone promotes to go without private campaign evidence.
assertNotIncludes(goNoGoPath, 'Decision: `go`')

for (const phrase of [
  'Managed BYOK Onboarding Checklist',
  'Hosted BYOK Setup Flow',
  'OSS Self-Host Equivalent',
  'Managed Vs Self-Host Responsibilities',
  'Security Posture',
  'Known Private Beta Constraints',
  'Open Cowork does not resell model tokens',
  'Desktop local workspaces stay local',
  'Cloud Channel Gateway is a channel client and delivery adapter',
  'Public/Private Boundary',
  'managed-byok-readiness-contract.template.json',
  'create or invite org owner',
  'verify membership and role',
  'write-only endpoint',
  'continue the same thread from Desktop',
  'validation commands with timestamps',
  'support owner',
  'cloud.billing.provider=none',
  'pnpm deploy:private-beta:validate',
  'pnpm deploy:continuation:smoke',
  'pnpm deploy:load:strict',
  'pnpm deploy:soak:strict',
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
  'Support Bundle Contract',
  'Onboarding Status And Reason Codes',
  'support.diagnostics_redaction_required',
]) {
  assertIncludes('docs/runbooks/private-beta-support.md', phrase)
}

for (const phrase of [
  'Public/Private Boundary',
  'Onboarding Status Contract',
  'Billing And Entitlement Boundary',
  'BYOK Boundary',
  'Support Bundle Contract',
  'Launch Package Rules',
  'managed-byok-readiness-contract.template.json',
  'billing.subscription_inactive',
  'gateway.signature_required',
  'support.diagnostics_redaction_required',
  'cloud.billing.provider=none',
]) {
  assertIncludes('docs/runbooks/managed-byok-saas-boundary.md', phrase)
}

for (const phrase of [
  'hosted-byok.config.example.json',
  'self-host-oss.config.example.json',
  'managed-byok-readiness-contract.template.json',
  'private-beta-plans.json',
  'private-beta-launch-profile.template.json',
  'launch-evidence-record.template.json',
  'design-partner-onboarding.template.md',
  'go-no-go-report.template.md',
  'private-beta-go-no-go.public.md',
  'ops-evidence-package.md',
  'provider-neutral',
  'cloud.billing.provider=none',
  'pnpm deploy:private-beta:validate',
  'pnpm deploy:launch:evidence:validate',
  'pnpm ops:validate',
]) {
  assertIncludes('deploy/private-beta/README.md', phrase)
}

for (const phrase of [
  'Private Beta Launch',
  'Private Beta Support',
  'Managed BYOK Boundary',
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
if (packageJson.scripts?.['deploy:launch:evidence:validate'] !== 'node scripts/validate-launch-evidence-manifest.mjs') {
  throw new Error('package.json must expose deploy:launch:evidence:validate')
}
if (packageJson.scripts?.['deploy:promotion:validate'] !== 'node scripts/validate-release-promotion.mjs') {
  throw new Error('package.json must expose deploy:promotion:validate')
}
if (packageJson.scripts?.['deploy:failover:drill'] !== 'node scripts/launch-failover-drill.mjs') {
  throw new Error('package.json must expose deploy:failover:drill')
}
if (packageJson.scripts?.['deploy:failover:drill:dry-run'] !== 'node scripts/launch-failover-drill.mjs --dry-run') {
  throw new Error('package.json must expose deploy:failover:drill:dry-run')
}

const hosted = readJson('deploy/private-beta/hosted-byok.config.example.json')
if (hosted.contractVersion !== 1) throw new Error('hosted private beta config must declare contractVersion 1')
if (hosted.cloud?.auth?.signupMode !== 'invite') throw new Error('hosted private beta config must use invite signup mode')
if (hosted.cloud?.billing?.provider !== 'stub') throw new Error('hosted private beta config must keep billing stubbed')
if (hosted.cloudDesktop?.requireManagedOrg !== true) throw new Error('hosted private beta config must require a managed org')
if (hosted.gateway?.productMode !== 'cloud_channel') throw new Error('hosted private beta config must declare cloud_channel gateway product mode')
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
if (selfHost.gateway?.productMode !== 'cloud_channel') throw new Error('self-host config must declare cloud_channel gateway product mode')
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
  'launchEvidenceRecord',
  'schedulerReplicaFailover',
  'secretAdapterResolution',
  'byokRedactionNoPlaintext',
  'quotaRateLimitBehavior',
  'billingEntitlementGating',
  'supportIncidentOwnershipEscalation',
  'costSloNotes',
  'releaseRollback',
]) {
  if (profile?.requiredEvidence?.[evidence] !== true) {
    throw new Error(`launch profile must require ${evidence}`)
  }
}
for (const command of [
  'pnpm deploy:private-beta:validate',
  'pnpm deploy:launch:validate',
  'pnpm deploy:launch:evidence:validate',
  'pnpm deploy:promotion:validate -- --tier private-hosted-beta --manifest <private-record>',
  'pnpm ops:validate',
  'pnpm deploy:continuation:smoke',
  'pnpm deploy:load:strict',
  'pnpm deploy:soak:strict',
  'pnpm deploy:failover:drill',
  'pnpm deploy:gcp:preflight',
  'pnpm deploy:gcp:smoke',
]) {
  assertArrayIncludes(profile?.requiredSmokeCommands, command, 'launchProfile.requiredSmokeCommands')
}

const launchEvidence = readJson('deploy/private-beta/launch-evidence-record.template.json')
if (launchEvidence.schemaVersion !== 1) throw new Error('launch evidence record must declare schemaVersion 1')
if (launchEvidence.purpose !== 'managed-byok-private-beta-launch-evidence-record-template') {
  throw new Error('launch evidence record must declare its purpose')
}
if (launchEvidence.scope !== 'public-template-only') {
  throw new Error('launch evidence record must remain a public-template-only artifact')
}
if (launchEvidence.targetTier !== 'private-beta') throw new Error('launch evidence record must target private-beta')
if (launchEvidence.currentPublicTier !== 'local-self-host-beta') {
  throw new Error('launch evidence record must keep current public tier local-self-host-beta')
}
if (!Array.isArray(launchEvidence.requiredEvidence)) {
  throw new Error('launch evidence record must list requiredEvidence')
}
for (const evidence of [
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
]) {
  const record = launchEvidence.requiredEvidence.find((entry) => entry.id === evidence)
  if (!record) throw new Error(`launch evidence record must require ${evidence}`)
  if (record.blockingForPrivateBeta !== true) throw new Error(`${evidence} must block private beta`)
  if (record.status !== 'pending-private-evidence') throw new Error(`${evidence} must default to pending-private-evidence`)
}

const readinessContract = readJson('deploy/private-beta/managed-byok-readiness-contract.template.json')
if (readinessContract.contractVersion !== 1) throw new Error('managed BYOK readiness contract must declare contractVersion 1')
if (readinessContract.purpose !== 'managed-byok-saas-readiness-contract') {
  throw new Error('managed BYOK readiness contract must declare its purpose')
}
if (readinessContract.scope !== 'public-template-only') throw new Error('managed BYOK readiness contract must stay public-template-only')
for (const entry of [
  'provider-neutral billing adapter interfaces',
  'stub billing adapter and local validators',
  'BYOK status APIs, secret-store interfaces, and worker-role runtime injection code',
  'self-host documentation and billing-free deployment paths',
  'support and diagnostics redaction contracts',
]) {
  assertArrayIncludes(readinessContract.publicPrivateBoundary?.publicRepoAllowed, entry, 'readiness.publicRepoAllowed')
}
for (const entry of [
  'real cloud project ids, account ids, subscription ids, and regions tied to a managed service',
  'customer names, emails, org slugs, channel identifiers, support tickets, onboarding records, or launch evidence',
  'production support rosters, on-call schedules, incident channels, and escalation phone numbers',
  'raw diagnostics bundles, logs, database exports, object-store listings, or audit exports from managed customers',
]) {
  assertArrayIncludes(readinessContract.publicPrivateBoundary?.privateOpsOnly, entry, 'readiness.privateOpsOnly')
}
for (const pattern of [
  'provider API keys',
  'OAuth refresh or access tokens',
  'Desktop or Gateway API tokens',
  'database URLs',
  'real Stripe price, product, account, customer, or subscription ids',
]) {
  assertArrayIncludes(readinessContract.publicPrivateBoundary?.forbiddenPublicPatterns, pattern, 'readiness.forbiddenPublicPatterns')
}
for (const status of [
  'not_started',
  'invite_sent',
  'auth_required',
  'org_ready',
  'byok_pending_validation',
  'byok_active',
  'desktop_ready',
  'gateway_ready',
  'billing_blocked',
  'quota_blocked',
  'support_review',
  'ready',
  'blocked',
  'offboarded',
]) {
  assertArrayIncludes(readinessContract.onboardingContract?.statuses, status, 'readiness.onboarding.statuses')
}
for (const code of [
  'auth.invite_required',
  'auth.membership_missing',
  'auth.token_expired',
  'auth.token_revoked',
  'byok.key_missing',
  'byok.validation_failed',
  'billing.subscription_required',
  'billing.subscription_inactive',
  'quota.worker_limit_exceeded',
  'gateway.identity_not_allowed',
  'gateway.signature_required',
  'desktop.managed_org_required',
  'support.diagnostics_redaction_required',
]) {
  assertArrayIncludes(readinessContract.onboardingContract?.reasonCodes, code, 'readiness.onboarding.reasonCodes')
}
for (const step of [
  'create_or_invite_org_owner',
  'verify_membership_and_role',
  'configure_byok_write_only',
  'validate_provider_or_audited_override',
  'issue_desktop_connection',
  'issue_gateway_service_token_and_binding',
  'verify_cloud_web_admin_surface',
  'run_first_thread_from_web',
  'continue_same_thread_from_desktop',
  'continue_or_notify_through_gateway',
]) {
  assertArrayIncludes(readinessContract.onboardingContract?.requiredFlow, step, 'readiness.onboarding.requiredFlow')
}
for (const provider of ['none', 'stub']) {
  assertArrayIncludes(readinessContract.billingEntitlementContract?.selfHostAllowedProviders, provider, 'readiness.selfHostAllowedProviders')
}
for (const gate of [
  'subscription state overlays runtime policy',
  'past_due, canceled, disabled, and inactive states block new paid execution',
  'expensive managed work is blocked before worker spawn or lease claim where possible',
  'billing webhook ingress requires provider signature verification and replay protection',
  'self-host mode must not require Stripe or any commercial billing adapter',
]) {
  assertArrayIncludes(readinessContract.billingEntitlementContract?.requiredGates, gate, 'readiness.billing.requiredGates')
}
if (readinessContract.byokSecurityContract?.plaintextReadbackAllowed !== false) {
  throw new Error('readiness BYOK contract must forbid plaintext readback')
}
if (readinessContract.byokSecurityContract?.workerRevealOnly !== true) {
  throw new Error('readiness BYOK contract must require worker-only reveal')
}
if (readinessContract.byokSecurityContract?.runtimeInjection !== 'provider-options-only') {
  throw new Error('readiness BYOK contract must require provider-options-only runtime injection')
}
for (const surface of [
  'HTTP read payloads',
  'diagnostics bundles',
  'renderer state',
  'Desktop cloud cache',
  'Gateway logs',
  'SSE events',
]) {
  assertArrayIncludes(readinessContract.byokSecurityContract?.requiredRedactionSurfaces, surface, 'readiness.byok.requiredRedactionSurfaces')
}
for (const field of [
  'raw BYOK keys',
  'OAuth refresh or access tokens',
  'Desktop, Gateway, API, cookie, internal, or operator tokens',
  'database URLs',
  'signed object-store URLs',
  'customer names, emails, phone numbers, or channel handles in public evidence',
]) {
  assertArrayIncludes(readinessContract.supportBundleContract?.forbiddenFields, field, 'readiness.support.forbiddenFields')
}
for (const artifact of [
  'docs/runbooks/managed-byok-saas.md',
  'docs/runbooks/managed-byok-saas-boundary.md',
  'docs/runbooks/private-beta-launch.md',
  'docs/runbooks/private-beta-support.md',
  'deploy/private-beta/managed-byok-readiness-contract.template.json',
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/private-beta-plans.json',
  'deploy/private-beta/private-beta-launch-profile.template.json',
  'deploy/private-beta/launch-evidence-record.template.json',
  'deploy/private-beta/design-partner-onboarding.template.md',
  'deploy/private-beta/go-no-go-report.template.md',
  'deploy/private-beta/private-beta-go-no-go.public.md',
]) {
  assertArrayIncludes(readinessContract.launchPackageContract?.requiredPublicArtifacts, artifact, 'readiness.launch.requiredPublicArtifacts')
}
for (const command of [
  'pnpm deploy:private-beta:validate',
  'pnpm deploy:validate -- --require-tools',
  'pnpm deploy:launch:validate',
  'pnpm deploy:launch:evidence:validate',
  'pnpm deploy:promotion:validate -- --tier private-hosted-beta --manifest <private-record>',
  'pnpm ops:validate',
  'pnpm test',
  'pnpm typecheck',
  'pnpm lint',
  'pnpm docs:build',
  'git diff --check',
]) {
  assertArrayIncludes(readinessContract.launchPackageContract?.requiredValidationCommands, command, 'readiness.launch.requiredValidationCommands')
}

for (const phrase of [
  'Required Ten-Step Flow',
  'Onboarding State',
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
  'Support Bundle Proof',
  'billing_blocked',
  'support_review',
]) {
  assertIncludes('deploy/private-beta/design-partner-onboarding.template.md', phrase)
}

for (const phrase of [
  'Launch Profile And Environment',
  'Exact Commit And Release Artifact',
  'Validation Commands With Timestamps',
  'Evidence Register',
  'Load And Soak Summary',
  'Failover And Restore Summary',
  'Security Boundary Checklist',
  'Public/Private Boundary Evidence',
  'Known Risks And Mitigations',
  'Decision',
  'BYOK plaintext absent',
  'Cloud Channel Gateway is a channel client and delivery adapter',
  'managed-byok-readiness-contract.template.json',
  'launch-evidence-record.template.json',
  'pnpm deploy:promotion:validate -- --tier private-hosted-beta --manifest <private-record>',
  'releaseRollback',
  'Onboarding failures preserve machine-readable status and reason codes',
]) {
  assertIncludes('deploy/private-beta/go-no-go-report.template.md', phrase)
}

for (const phrase of [
  'Decision: `no-go`',
  'Current public tier: `local-self-host-beta`',
  'pending-private-evidence',
  'deployedDesktopWebGatewayContinuation',
  'gatewayDeliveryReplayDeadLetter',
  'supportIncidentOwnershipEscalation',
  'costSloNotes',
  'releaseRollback',
  'pnpm deploy:launch:evidence:validate -- --manifest <private-record> --require-private-pass',
  'pnpm deploy:promotion:validate -- --tier private-hosted-beta --manifest <private-record>',
]) {
  assertIncludes('deploy/private-beta/private-beta-go-no-go.public.md', phrase)
}

for (const path of [
  'docs/runbooks/private-beta-launch.md',
  'docs/runbooks/private-beta-support.md',
  'deploy/private-beta/README.md',
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/managed-byok-readiness-contract.template.json',
  'deploy/private-beta/private-beta-plans.json',
  'deploy/private-beta/private-beta-launch-profile.template.json',
  'deploy/private-beta/launch-evidence-record.template.json',
  'deploy/private-beta/design-partner-onboarding.template.md',
  'deploy/private-beta/go-no-go-report.template.md',
  'deploy/private-beta/private-beta-go-no-go.public.md',
]) {
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
    'OPEN_COWORK_CLOUD_COOKIE_SECRET=',
    'OPEN_COWORK_GATEWAY_SERVICE_TOKEN=',
  ]) {
    assertNotIncludes(path, forbidden)
  }
}

log('private beta launch package validated')
