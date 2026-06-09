import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const evidenceCommitSha = 'abcdef1234567890abcdef1234567890abcdef12'
const cloudImageDigest = `sha256:${'1'.repeat(64)}`
const gatewayImageDigest = `sha256:${'2'.repeat(64)}`
const unsafeEvidenceValue = ['github', 'pat', 'privatevalue1234567890'].join('_')

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  }
}

test('launch readiness harness produces strict load report against cloud and gateway routes', async () => {
  let sessionCounter = 0
  const cloud = await listen(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz' || url.pathname === '/livez') return writeJson(res, 200, { ok: true })
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end('<!doctype html><title>Open Cowork Cloud</title>')
      return
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      })
      res.write('event: ping\ndata: {"ok":true}\n\n')
      setTimeout(() => res.end(), 40)
      return
    }
    if (url.pathname === '/api/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end([
        'open_cowork_cloud_command_queue_depth_estimate 0',
        'open_cowork_cloud_command_oldest_age_ms 0',
        'open_cowork_cloud_projection_lag_events 0',
        'open_cowork_cloud_sse_connections 1',
        'open_cowork_cloud_quota_rejections_total 0',
        'open_cowork_cloud_worker_stale_owner_rejections_total 0',
      ].join('\n'))
      return
    }
    if (url.pathname === '/api/config') return writeJson(res, 200, { role: 'web', features: {} })
    if (url.pathname === '/api/workspace') return writeJson(res, 200, { tenantId: 'tenant-1', userId: 'user-1' })
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      return writeJson(res, 200, { sessions: [{ sessionId: 'session-existing' }] })
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      await readBody(req)
      sessionCounter += 1
      return writeJson(res, 201, { session: { sessionId: `session-${sessionCounter}` }, projection: null })
    }
    const promptMatch = /^\/api\/sessions\/([^/]+)\/prompt$/.exec(url.pathname)
    if (promptMatch && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 202, {
        command: { commandId: `command-${promptMatch[1]}` },
        processed: 1,
        view: { session: { sessionId: promptMatch[1] }, projection: null },
      })
    }
    const artifactCollectionMatch = /^\/api\/sessions\/([^/]+)\/artifacts$/.exec(url.pathname)
    if (artifactCollectionMatch && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 201, { artifact: { id: `artifact-${artifactCollectionMatch[1]}` } })
    }
    if (url.pathname === '/api/artifacts' && req.method === 'GET') {
      return writeJson(res, 200, { artifacts: [], total: 0 })
    }
    const artifactReadMatch = /^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname)
    if (artifactReadMatch && req.method === 'GET') {
      return writeJson(res, 200, { artifact: { id: artifactReadMatch[2], dataBase64: 'b2s=' } })
    }
    if (url.pathname === '/api/workflows' && req.method === 'GET') return writeJson(res, 200, { workflows: [] })
    if (url.pathname === '/api/workflows' && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 201, { workflow: { id: 'workflow-1' } })
    }
    if (url.pathname === '/api/workflows/workflow-1/run' && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 202, { workflow: { id: 'workflow-1' }, run: { id: 'run-1' }, processed: 1 })
    }
    if (url.pathname === '/api/byok') return writeJson(res, 200, { secrets: [] })
    if (url.pathname === '/api/byok/anthropic/validate' && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 200, { secret: { providerId: 'anthropic', status: 'active' }, validated: true })
    }
    if (url.pathname === '/api/threads') return writeJson(res, 200, { threads: [] })
    if (url.pathname === '/api/threads/tags') return writeJson(res, 200, { tags: [] })
    if (url.pathname === '/api/threads/smart-filters') return writeJson(res, 200, { filters: [] })
    if (url.pathname === '/api/usage/summary') return writeJson(res, 200, { events: [] })
    if (url.pathname === '/api/channels/deliveries') return writeJson(res, 200, { deliveries: [] })
    if (url.pathname === '/api/admin/policy') return writeJson(res, 200, { policy: {} })
    if (url.pathname === '/api/workers/heartbeats') return writeJson(res, 200, { heartbeats: [] })
    if (url.pathname === '/api/runtime/status') return writeJson(res, 200, { role: 'web', canExecute: false })
    return writeJson(res, 404, { error: 'not found' })
  })

  const gateway = await listen((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/health') return writeJson(res, 200, { ok: true })
    if (url.pathname === '/ready') return writeJson(res, 200, { ok: true, status: 'ready' })
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end([
        'open_cowork_gateway_providers 1',
        'open_cowork_gateway_delivery_retries_total 0',
        'open_cowork_gateway_delivery_dead_letters_total 0',
        'open_cowork_gateway_stream_reconnects_total 0',
        'open_cowork_gateway_session_streams 1',
      ].join('\n'))
      return
    }
    return writeJson(res, 404, { error: 'not found' })
  })

  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-launch-readiness-'))
  try {
    const { stdout: output } = await execFileAsync(process.execPath, [
      'scripts/launch-readiness.mjs',
      '--mode',
      'load',
      '--profile',
      'private-beta',
      '--duration-ms',
      '1400',
      '--concurrency',
      '4',
      '--request-rate',
      '80',
      '--cloud-url',
      cloud.url,
      '--gateway-url',
      gateway.url,
      '--cloud-token',
      'cloud-token',
      '--gateway-admin-token',
      'gateway-admin-token',
      '--byok-provider',
      'anthropic',
      '--include-mutations',
      '--include-sse',
      '--operator',
      '--strict',
      '--commit-sha',
      evidenceCommitSha,
      '--cloud-image-digest',
      cloudImageDigest,
      '--gateway-image-digest',
      gatewayImageDigest,
      '--output-dir',
      outputDir,
    ], { encoding: 'utf8' })
    const parsed = JSON.parse(output)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result, 'go')
    assert.equal(parsed.failedChecks.length, 0)

    const files = readdirSync(outputDir)
    const jsonReport = files.find((file) => file.endsWith('-private-beta-load-report.json'))
    const markdownReport = files.find((file) => file.endsWith('-private-beta-load-report.md'))
    assert.ok(jsonReport)
    assert.ok(markdownReport)
    const report = JSON.parse(readFileSync(join(outputDir, jsonReport), 'utf8'))
    assert.equal(report.gates.overall, 'go')
    assert.equal(report.evidence.command, 'pnpm deploy:load:strict')
    assert.equal(report.evidence.commitSha, evidenceCommitSha)
    assert.equal(report.evidence.imageDigests.cloud, cloudImageDigest)
    assert.equal(report.evidence.imageDigests.gateway, gatewayImageDigest)
    assert.equal(report.evidence.environmentProfile.profileName, 'private-beta')
    assert.equal(report.evidence.environmentProfile.mode, 'load')
    assert.equal(report.evidence.environmentProfile.cloudTokenProvided, true)
    assert.equal(report.evidence.environmentProfile.gatewayAdminTokenProvided, true)
    assert.equal(report.evidence.startedAt, report.run.startedAt)
    assert.equal(report.evidence.finishedAt, report.run.finishedAt)
    assert.equal(report.evidence.durationMs, report.run.durationMs)
    assert.doesNotMatch(JSON.stringify(report), /cloud-token|gateway-admin-token/)
    assert.equal(report.summary.operations['cloud-session-create'].failures, 0)
    assert.equal(report.summary.operations['cloud-prompt-enqueue'].failures, 0)
    assert.equal(report.summary.operations['cloud-workspace-sse'].failures, 0)
    assert.equal(report.summary.operations['cloud-artifact-upload'].failures, 0)
    assert.equal(report.summary.operations['cloud-artifact-download'].failures, 0)
    assert.equal(report.summary.operations['cloud-workflow-run'].failures, 0)
    assert.equal(report.summary.operations['cloud-byok-provider-validate'].failures, 0)
    assert.equal(report.metrics.delta.open_cowork_gateway_delivery_dead_letters_total, 0)
    assert.equal(report.metrics.delta.open_cowork_gateway_stream_reconnects_total, 0)
    const markdown = readFileSync(join(outputDir, markdownReport), 'utf8')
    assert.match(markdown, /Open Cowork Launch Readiness Report/)
    assert.match(markdown, /Evidence Metadata/)
    assert.match(markdown, new RegExp(evidenceCommitSha))
  } finally {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()))
    await new Promise<void>((resolve) => gateway.server.close(() => resolve()))
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('launch evidence matrix states the current accepted tier and required gates', () => {
  const targets = readJsonFile('deploy/load/launch-readiness-targets.json')
  assert.ok(targets.profiles['local-self-host-beta'])
  assert.ok(targets.profiles['private-beta'])
  assert.ok(targets.profiles['public-beta'])
  assert.ok(targets.profiles['enterprise-scale'])

  const matrix = readJsonFile('deploy/load/launch-evidence-matrix.json')
  assert.equal(matrix.schemaVersion, 1)
  assert.equal(matrix.purpose, 'launch-evidence-tier-matrix')
  assert.equal(matrix.acceptedPublicTier, 'local-self-host-beta')
  assert.equal(matrix.tiers['local-self-host-beta'].claimStatus, 'accepted-public')
  for (const tier of ['private-beta', 'public-beta', 'general-availability', 'enterprise-scale']) {
    assert.notEqual(matrix.tiers[tier].claimStatus, 'accepted-public')
  }
  for (const category of [
    'loadAndSoak',
    'failoverRecovery',
    'backupRestore',
    'securityBoundary',
    'releasePackaging',
    'findingsWorkflow',
  ]) {
    assert.equal(matrix.evidenceCategories[category].requiredForAcceptedTier, true, category)
    assert.ok(matrix.evidenceCategories[category].publicArtifacts.length > 0, category)
    assert.ok(matrix.evidenceCategories[category].requiredCommands.length > 0, category)
    assert.match(matrix.evidenceCategories[category].passCondition, /\w/)
  }
  assert.ok(matrix.evidenceCategories.loadAndSoak.coveredSurfaces.includes('SSE fanout and reconnect'))
  assert.ok(matrix.evidenceCategories.failoverRecovery.coveredSurfaces.includes('Gateway restart with delivery cursor resume'))
  assert.ok(matrix.evidenceCategories.backupRestore.coveredSurfaces.includes('BYOK secret references and reveal denial behavior'))
  assert.ok(matrix.evidenceCategories.securityBoundary.coveredSurfaces.includes('public webhook ingress fails closed'))
  assert.ok(matrix.evidenceCategories.releasePackaging.coveredSurfaces.includes('Desktop packaging smoke'))
  assert.ok(matrix.evidenceCategories.findingsWorkflow.allowedDispositions.includes('narrow-follow-up-issue'))
  assert.equal(matrix.privateBetaEvidenceItems.requiredStatusForGo, 'private-pass')
  for (const item of [
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
    assert.equal(matrix.privateBetaEvidenceItems.items[item].requiredForPrivateBeta, true, item)
    assert.ok(matrix.privateBetaEvidenceItems.items[item].publicArtifacts.length > 0, item)
    assert.ok(matrix.privateBetaEvidenceItems.items[item].requiredCommands.length > 0, item)
  }
})

test('launch evidence manifest validator accepts template and completed private record shape', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/validate-launch-evidence-manifest.mjs',
  ], { encoding: 'utf8' })
  assert.match(stdout, /launch evidence manifest validated/)

  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-launch-evidence-'))
  try {
    const manifest = readJsonFile('deploy/private-beta/launch-evidence-record.template.json')
    assert.deepEqual(manifest.requiredReportFields, [
      'command',
      'evidenceCommands',
      'commitSha',
      'imageDigests',
      'sanitizedEnvironmentProfile',
      'startedAt',
      'finishedAt',
      'durationMs',
      'status',
    ])
    for (const item of manifest.requiredEvidence) {
      item.status = 'private-pass'
      item.privateEvidenceRef = `private://evidence/${item.id}`
      item.publicRedactedSummary = `Redacted private evidence summary for ${item.id}.`
      item.checksum = `sha256:${'a'.repeat(64)}`
      item.owner = 'private-ops-owner'
    }
    const completedPath = join(outputDir, 'completed-launch-evidence.json')
    writeFileSync(completedPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const completed = await execFileAsync(process.execPath, [
      'scripts/validate-launch-evidence-manifest.mjs',
      '--manifest',
      completedPath,
      '--require-private-pass',
    ], { encoding: 'utf8' })
    assert.match(completed.stdout, /launch evidence manifest validated/)

    manifest.requiredEvidence[0].status = 'pending-private-evidence'
    const invalidPath = join(outputDir, 'invalid-launch-evidence.json')
    writeFileSync(invalidPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/validate-launch-evidence-manifest.mjs',
        '--manifest',
        invalidPath,
        '--require-private-pass',
      ], { encoding: 'utf8' }),
      /must be private-pass/,
    )

    manifest.requiredEvidence[0].status = 'private-pass'
    manifest.requiredEvidence[0].publicRedactedSummary = 'This unsafe summary contains sk-privatevalue123.'
    const unsafePath = join(outputDir, 'unsafe-launch-evidence.json')
    writeFileSync(unsafePath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/validate-launch-evidence-manifest.mjs',
        '--manifest',
        unsafePath,
        '--require-private-pass',
      ], { encoding: 'utf8' }),
      /must not include private/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('launch failover drill emits redacted dry-run evidence without executing hooks', async () => {
  const cloud = await listen((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz') return writeJson(res, 200, { ok: true })
    if (url.pathname === '/api/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end('open_cowork_cloud_command_queue_depth_estimate 0\n')
      return
    }
    return writeJson(res, 404, { error: 'not found' })
  })
  const gateway = await listen((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/ready') return writeJson(res, 200, { ok: true, status: 'ready' })
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end('open_cowork_gateway_delivery_dead_letters_total 0\n')
      return
    }
    return writeJson(res, 404, { error: 'not found' })
  })
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-failover-drill-'))
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/launch-failover-drill.mjs',
      '--dry-run',
      '--cloud-url',
      cloud.url,
      '--gateway-url',
      gateway.url,
      '--worker-hook',
      'exit 1',
      '--scheduler-hook',
      'exit 1',
      '--gateway-hook',
      'exit 1',
      '--commit-sha',
      evidenceCommitSha,
      '--cloud-image-digest',
      cloudImageDigest,
      '--gateway-image-digest',
      gatewayImageDigest,
      '--output-dir',
      outputDir,
    ], { encoding: 'utf8' })
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.report.redacted, true)
    assert.equal(parsed.report.result, 'dry-run')
    assert.equal(parsed.report.evidence.command, 'pnpm deploy:failover:drill:dry-run')
    assert.equal(parsed.report.evidence.commitSha, evidenceCommitSha)
    assert.equal(parsed.report.evidence.imageDigests.cloud, cloudImageDigest)
    assert.equal(parsed.report.evidence.imageDigests.gateway, gatewayImageDigest)
    assert.equal(parsed.report.evidence.environmentProfile.cloudTokenProvided, false)
    assert.equal(parsed.report.evidence.environmentProfile.workerHookConfigured, true)
    assert.equal(parsed.report.evidence.startedAt, parsed.report.startedAt)
    assert.equal(parsed.report.evidence.finishedAt, parsed.report.finishedAt)
    assert.equal(parsed.report.evidence.durationMs, parsed.report.durationMs)
    assert.equal(typeof parsed.report.durationMs, 'number')
    assert.equal(parsed.report.targets.cloudUrl, 'http://REDACTED_HOST')
    assert.equal(parsed.report.hooks[0].status, 'dry-run')
    assert.ok(parsed.report.evidenceItems.includes('workerFailover'))
    assert.ok(parsed.report.evidenceItems.includes('schedulerReplicaFailover'))
    assert.ok(parsed.report.evidenceItems.includes('gatewayDeliveryReplayDeadLetter'))
  } finally {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()))
    await new Promise<void>((resolve) => gateway.server.close(() => resolve()))
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('launch failover drill records operator hook evidence without executing shell text', async () => {
  const cloud = await listen((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz') return writeJson(res, 200, { ok: true })
    if (url.pathname === '/api/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end('open_cowork_cloud_command_queue_depth_estimate 0\n')
      return
    }
    return writeJson(res, 404, { error: 'not found' })
  })
  const gateway = await listen((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/ready') return writeJson(res, 200, { ok: true, status: 'ready' })
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end('open_cowork_gateway_delivery_dead_letters_total 0\n')
      return
    }
    return writeJson(res, 404, { error: 'not found' })
  })
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-failover-drill-'))
  try {
    const markerPath = join(outputDir, 'hook-ran')
    const hookText = `${process.execPath} -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')"`
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/launch-failover-drill.mjs',
      '--execute-hooks',
      '--cloud-url',
      cloud.url,
      '--gateway-url',
      gateway.url,
      '--worker-hook',
      hookText,
      '--scheduler-hook',
      hookText,
      '--gateway-hook',
      hookText,
      '--commit-sha',
      evidenceCommitSha,
      '--cloud-image-digest',
      cloudImageDigest,
      '--gateway-image-digest',
      gatewayImageDigest,
      '--output-dir',
      outputDir,
    ], { encoding: 'utf8' })
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.report.result, 'pass')
    assert.deepEqual(parsed.report.hooks.map((hook: { status: string }) => hook.status), ['pass', 'pass', 'pass'])
    assert.equal(parsed.report.hooks[0].reason, 'operator-confirmed-private-hook-evidence')
    assert.match(parsed.report.hooks[0].evidence, /hook-ran/)
    assert.equal(readdirSync(outputDir).includes('hook-ran'), false)
  } finally {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()))
    await new Promise<void>((resolve) => gateway.server.close(() => resolve()))
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('launch readiness plan defaults to the local self-host beta tier', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-launch-plan-'))
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/launch-readiness.mjs',
      '--mode',
      'plan',
      '--commit-sha',
      evidenceCommitSha,
      '--cloud-image-digest',
      cloudImageDigest,
      '--gateway-image-digest',
      unsafeEvidenceValue,
      '--output-dir',
      outputDir,
    ], { encoding: 'utf8' })
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.mode, 'plan')
    assert.equal(parsed.profileName, 'local-self-host-beta')
    assert.ok(parsed.operations.includes('cloud-health'))
    assert.ok(parsed.operations.includes('cloud-liveness'))
    assert.ok(parsed.operations.includes('gateway-health'))
    const plan = readFileSync(parsed.planPath, 'utf8')
    assert.match(plan, /local-self-host-beta/)
    assert.match(plan, /OSS self-host and local reference deployment target/)
    assert.match(plan, /Evidence Metadata/)
    assert.match(plan, new RegExp(evidenceCommitSha))
    assert.match(plan, /redacted-private-value/)
    assert.doesNotMatch(plan, new RegExp(unsafeEvidenceValue))
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
