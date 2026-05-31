import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readRepoFile(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function readJson(path: string) {
  return JSON.parse(readRepoFile(path))
}

test('private beta launch package documents managed and self-host promises', () => {
  const launch = readRepoFile('docs/runbooks/private-beta-launch.md')
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
    'cloud.billing.provider=none',
    'pnpm deploy:private-beta:validate',
    'pnpm deploy:continuation:smoke',
  ]) {
    assert.match(launch, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  const support = readRepoFile('docs/runbooks/private-beta-support.md')
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
    assert.match(support, new RegExp(phrase))
  }
})

test('private beta launch profile template captures launch decisions and evidence gates', () => {
  const template = readJson('deploy/private-beta/private-beta-launch-profile.template.json')
  assert.equal(template.purpose, 'managed-byok-private-beta-launch-profile-template')
  assert.equal(template.evidenceBoundary.redactionRequiredBeforeSharing, true)
  assert.match(template.evidenceBoundary.privateOpsRecord, /\{private-ops-ticket-or-runbook-url\}/)
  assert.equal(template.profile.launchReadinessTarget, 'private-beta')
  assert.equal(template.profile.billingMode, 'manual-or-stub')
  assert.match(template.profile.targetEnvironment, /\{production-like-environment-name\}/)
  assert.equal(template.profile.allowedProviderPolicy.validation, 'required-before-first-run-or-audited-override')
  assert.equal(template.profile.allowedProviderPolicy.runtimeInjection, 'provider-options-only')
  assert.equal(template.profile.allowedProviderPolicy.plaintextReadbackAllowed, false)
  assert.ok(template.profile.allowedProviderPolicy.providerIds.includes('anthropic'))
  assert.ok(template.profile.allowedProviderPolicy.blockedByDefault.includes('github-copilot'))
  for (const provider of ['telegram', 'slack', 'email', 'webhook']) {
    assert.ok(template.profile.gatewayProviderAvailability.some((entry: { provider: string }) => entry.provider === provider))
  }
  for (const key of [
    'maxSeatsPerOrg',
    'maxConcurrentSessionsPerOrg',
    'maxActiveWorkersPerOrg',
    'maxPromptsPerHour',
    'maxApiRequestsPerMinute',
  ]) {
    assert.equal(typeof template.profile.entitlements[key], 'number')
    assert.ok(template.profile.entitlements[key] > 0)
  }
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
    assert.equal(template.profile.requiredEvidence[evidence], true)
  }
  for (const command of [
    'pnpm deploy:private-beta:validate',
    'pnpm deploy:launch:validate',
    'pnpm ops:validate',
    'pnpm deploy:continuation:smoke',
    'pnpm deploy:load',
    'pnpm deploy:soak',
  ]) {
    assert.ok(template.profile.requiredSmokeCommands.includes(command))
  }
})

test('private beta onboarding and go/no-go templates force complete evidence records', () => {
  const onboarding = readRepoFile('deploy/private-beta/design-partner-onboarding.template.md')
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
    assert.match(onboarding, new RegExp(phrase))
  }

  const report = readRepoFile('deploy/private-beta/go-no-go-report.template.md')
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
    assert.match(report, new RegExp(phrase))
  }
})

test('private beta examples keep hosted and OSS modes separate', () => {
  const hosted = readJson('deploy/private-beta/hosted-byok.config.example.json')
  assert.equal(hosted.contractVersion, 1)
  assert.equal(hosted.cloud.auth.signupMode, 'invite')
  assert.equal(hosted.cloud.auth.allowSelfServiceSignup, false)
  assert.equal(hosted.cloud.billing.provider, 'stub')
  assert.equal(hosted.cloud.billing.defaultPlanKey, 'private-beta-design-partner')
  assert.equal(hosted.cloudDesktop.requireManagedOrg, true)
  assert.equal(hosted.cloudDesktop.allowUserAddedConnections, false)
  assert.equal(hosted.gateway.mode, 'managed')
  assert.equal(hosted.gateway.metrics.enabled, true)
  assert.ok(hosted.gateway.server.adminToken)

  const selfHost = readJson('deploy/private-beta/self-host-oss.config.example.json')
  assert.equal(selfHost.contractVersion, 1)
  assert.equal(selfHost.cloud.billing.provider, 'none')
  assert.equal(selfHost.cloudDesktop.allowUserAddedConnections, true)
  assert.equal(selfHost.cloudDesktop.requireManagedOrg, false)
  assert.equal(selfHost.gateway.mode, 'self-host')
  assert.equal(selfHost.gateway.providers[0].kind, 'webhook')
  assert.ok(selfHost.gateway.providers[0].credentials.sharedSecret)
})

test('private beta plan placeholders do not commit prices or token resale assumptions', () => {
  const plans = readJson('deploy/private-beta/private-beta-plans.json')
  assert.equal(plans.billingMode, 'manual-or-stub')
  assert.deepEqual(plans.prices, [])
  assert.ok(plans.plans.length >= 2)
  for (const plan of plans.plans) {
    assert.match(plan.planKey, /^private-beta-/)
    assert.match(plan.billingMode, /^(manual|stub)$/)
    assert.equal(plan.entitlements.allowNewSessions, true)
    assert.equal(plan.entitlements.allowPrompts, true)
    assert.equal(plan.entitlements.allowWorkers, true)
    assert.equal(typeof plan.entitlements.maxPromptsPerHour, 'number')
    assert.equal(typeof plan.entitlements.maxWorkerMinutesPerHour, 'number')
    assert.equal(typeof plan.entitlements.maxGatewayChannelBindingsPerOrg, 'number')
    if (plan.billingMode === 'manual') {
      assert.match(plan.notes, /No token resale/)
    }
  }
})

test('private beta validator runs from the package script', () => {
  const packageJson = readJson('package.json')
  assert.equal(packageJson.scripts['deploy:private-beta:validate'], 'node scripts/validate-private-beta-package.mjs')
  const output = execFileSync(process.execPath, ['scripts/validate-private-beta-package.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.match(output, /private beta launch package validated/)
})
