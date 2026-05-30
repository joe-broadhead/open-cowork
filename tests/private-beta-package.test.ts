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
    'Never attach raw secrets',
  ]) {
    assert.match(support, new RegExp(phrase))
  }
})

test('private beta examples keep hosted and OSS modes separate', () => {
  const hosted = readJson('deploy/private-beta/hosted-byok.config.example.json')
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
