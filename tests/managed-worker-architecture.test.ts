import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const root = process.cwd()
const docPath = join(root, 'docs/managed-workers.md')
const doc = readFileSync(docPath, 'utf8')

const requiredLifecycleStates = [
  'pending',
  'active',
  'draining',
  'paused',
  'retired',
  'revoked',
  'unhealthy',
]

const requiredLeaseFields = [
  'leased_by',
  'lease_expires_at',
  'lease_token',
  'checkpoint_version',
  'status',
  'last_heartbeat_at',
  'claimed_at',
  'completed_at',
  'failed_at',
]

const requiredThreats = [
  'Worker token compromise',
  'Stale worker writes after lease expiry',
  'BYOK plaintext leakage',
  'Object-store prefix escape',
  'Checkpoint corruption',
  'Tenant crossover',
  'Gateway/channel impersonation',
  'Malicious webhook-triggered work',
  'Scheduler double-fire',
  'Operator endpoint exposure',
  'Diagnostic/log leakage',
  'Worker image/version compromise',
  'Customer-hosted worker trust ambiguity',
]

test('managed worker architecture doc covers the phase 0 contract', () => {
  assert.match(doc, /V1 supports \*\*control-plane-owned worker pools\*\*/)
  assert.match(doc, /customer-hosted workers connecting to a separate managed\s+SaaS control plane/)
  assert.match(doc, /OpenCode owns execution/)
  assert.match(doc, /Open Cowork owns the service-plane composition/)
  assert.match(doc, /No database transaction may remain open while OpenCode runs\./)
  assert.match(doc, /provider keys enter OpenCode through runtime config provider options, never\s+ambient `process\.env`/)
  assert.match(doc, /Phase 1 implemented worker identity\/lifecycle/)
  assert.match(doc, /Phase 2 implements claims\/fencing\/recovery/)
  assert.match(doc, /Phase 5 Operations Contract/)
  assert.match(doc, /OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS/)
  assert.match(doc, /Rollback And Emergency Revoke/)
  assert.match(doc, /SLO And Alert Template/)
  assert.match(doc, /deploy\/managed-workers\//)

  for (const state of requiredLifecycleStates) {
    assert.match(doc, new RegExp(`\\\`${state}\\\``), `missing lifecycle state ${state}`)
  }

  for (const field of requiredLeaseFields) {
    assert.match(doc, new RegExp(`\\\`${field}\\\``), `missing lease field ${field}`)
  }

  for (const threat of requiredThreats) {
    assert.match(doc, new RegExp(escapeRegex(threat)), `missing threat row for ${threat}`)
  }
})

test('managed worker docs are linked from core public docs and navigation', () => {
  const mkdocs = readFileSync(join(root, 'mkdocs.yml'), 'utf8')
  const architecture = readFileSync(join(root, 'docs/architecture.md'), 'utf8')
  const cloud = readFileSync(join(root, 'docs/open-cowork-cloud.md'), 'utf8')
  const security = readFileSync(join(root, 'docs/security-model.md'), 'utf8')
  const readiness = readFileSync(join(root, 'docs/deployment-readiness.md'), 'utf8')

  assert.match(mkdocs, /Managed Workers: managed-workers\.md/)
  for (const source of [architecture, cloud, security, readiness]) {
    assert.match(source, /\(managed-workers\.md\)/)
  }
})

test('managed worker public docs avoid private deployment evidence', () => {
  const managedWorkerPaths = [
    'docs/managed-workers.md',
    'docs/runbooks/cloud-managed-operations.md',
    'deploy/managed-workers/README.md',
    'deploy/managed-workers/self-host-worker.env.example',
    'deploy/managed-workers/managed-operator-worker.env.template',
    'deploy/managed-workers/helm-values.worker-pool.yaml.example',
    'deploy/managed-workers/worker-release-evidence.template.md',
    'deploy/managed-workers/worker-restore-drill.template.md',
    'deploy/observability/managed-worker-slo-template.json',
  ]
  const forbiddenPatterns = [
    /\b[a-z][a-z0-9-]{4,}-[0-9]{6,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\b\d{12}\b/,
    /customer\s+(?:name|email|domain)\s*:/i,
    /private\s+domain\s*:/i,
  ]

  for (const templatePath of managedWorkerPaths) {
    const contents = readFileSync(join(root, templatePath), 'utf8')
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${templatePath} must not contain private deployment values`)
    }
  }
})

test('managed worker phase 5 deployment artifacts exist and cover operations', () => {
  const deployReadme = readFileSync(join(root, 'deploy/managed-workers/README.md'), 'utf8')
  const releaseTemplate = readFileSync(join(root, 'deploy/managed-workers/worker-release-evidence.template.md'), 'utf8')
  const restoreTemplate = readFileSync(join(root, 'deploy/managed-workers/worker-restore-drill.template.md'), 'utf8')
  const sloTemplate = readFileSync(join(root, 'deploy/observability/managed-worker-slo-template.json'), 'utf8')
  const operations = readFileSync(join(root, 'docs/runbooks/cloud-managed-operations.md'), 'utf8')
  const releaseChecklist = readFileSync(join(root, 'docs/release-checklist.md'), 'utf8')

  for (const phrase of [
    'Supported Modes',
    '`self_hosted`',
    '`saas_operated`',
    '`customer_hosted`',
    'Bootstrap Sequence',
    'Update And Rollback Policy',
    'Sizing Guidance',
    'Required Validation',
  ]) {
    assert.match(deployReadme, new RegExp(escapeRegex(phrase)))
  }

  for (const phrase of [
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
    assert.match(sloTemplate, new RegExp(escapeRegex(phrase)))
  }

  for (const phrase of [
    'Pre-Deploy Gates',
    'Compatibility Decision',
    'Drain And Rolling Update',
    'Rollback Drill',
    'Emergency Revoke Drill',
    'Go/No-Go',
  ]) {
    assert.match(releaseTemplate, new RegExp(escapeRegex(phrase)))
  }

  for (const phrase of [
    'Postgres control-plane restore',
    'Object-store artifacts/checkpoints',
    'BYOK secret references',
    'Worker recovery',
    'Workflow consistency',
    'Redaction',
  ]) {
    assert.match(restoreTemplate, new RegExp(escapeRegex(phrase)))
  }

  for (const phrase of [
    'Worker Registration',
    'Worker Credential Rotation',
    'Rolling Worker Update',
    'Emergency Revoke',
    'Stuck Queue',
    'Stale Lease Spike',
    'Worker Crash Loop',
    'Tenant Offboarding',
    'Suspected Key Exposure',
  ]) {
    assert.match(operations, new RegExp(escapeRegex(phrase)))
  }

  assert.match(releaseChecklist, /worker-release-evidence\.template\.md/)
  assert.match(releaseChecklist, /worker-restore-drill\.template\.md/)
})

test('managed worker client and route boundaries do not import OpenCode SDK', () => {
  const forbiddenRoots = [
    'apps/desktop/src/renderer',
    'apps/desktop/src/main/cloud/http-routes',
    'apps/desktop/src/main/cloud/control-plane-domains',
    'apps/gateway/src',
    'apps/website/src',
    'packages/cloud-client/src',
  ]
  const sdkImportPattern = /@opencode-ai\/sdk|opencode-ai/

  for (const sourceRoot of forbiddenRoots) {
    for (const filePath of sourceFiles(join(root, sourceRoot))) {
      const source = readFileSync(filePath, 'utf8')
      assert.doesNotMatch(
        source,
        sdkImportPattern,
        `${relative(root, filePath)} must not import OpenCode runtime surfaces`,
      )
    }
  }
})

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['dist', 'node_modules', 'coverage'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile()
      && !entry.name.endsWith('.test.ts')
      && ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(extname(path))) files.push(path)
  }
  return files
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
