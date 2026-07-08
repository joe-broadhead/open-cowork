import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const commitSha = 'abcdef1234567890abcdef1234567890abcdef12'
const cloudDigest = `sha256:${'1'.repeat(64)}`
const gatewayDigest = `sha256:${'2'.repeat(64)}`

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function completedPromotionManifest() {
  const manifest = readJsonFile('deploy/private-beta/launch-evidence-record.template.json')
  const matrix = readJsonFile('deploy/load/launch-evidence-matrix.json')
  manifest.scope = 'private-ops-record'
  for (const item of manifest.requiredEvidence) {
    item.status = 'private-pass'
    item.privateEvidenceRef = `private://evidence/${item.id}`
    item.publicRedactedSummary = item.id === 'releaseRollback'
      ? 'Rollback evidence confirms revoke, drain, and communication owners without exposing private details.'
      : `Redacted private evidence summary for ${item.id}.`
    item.checksum = `sha256:${'a'.repeat(64)}`
    item.owner = 'private-ops-owner'
    item.report = {
      command: item.command,
      evidenceCommands: [
        ...new Set([
          item.command,
          ...(matrix.privateBetaEvidenceItems.items[item.id]?.requiredCommands ?? []),
        ]),
      ],
      commitSha,
      imageDigests: {
        cloud: cloudDigest,
        gateway: gatewayDigest,
      },
      sanitizedEnvironmentProfile: {
        profileName: 'private-beta',
        targetTier: 'private-beta',
        environmentKind: 'production-like',
        cloudTokenProvided: true,
        gatewayAdminTokenProvided: true,
      },
      startedAt: '2026-06-02T00:00:00.000Z',
      finishedAt: '2026-06-02T00:05:00.000Z',
      durationMs: 300_000,
      status: 'go',
      dryRun: false,
    }
    if (item.id === 'releaseRollback') {
      item.report.rollback = {
        revoke: 'redacted artifact revoke plan',
        drain: 'redacted worker drain plan',
        communication: 'redacted customer communication owner',
      }
    }
  }
  return manifest
}

async function writeCompletedManifest(outputDir: string) {
  const path = join(outputDir, 'completed-promotion-evidence.json')
  writeFileSync(path, `${JSON.stringify(completedPromotionManifest(), null, 2)}\n`)
  return path
}

test('release promotion validator accepts the local self-host public tier', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/validate-release-promotion.mjs',
    '--tier',
    'local-self-host-beta',
  ], { encoding: 'utf8' })
  assert.match(stdout, /local-self-host-beta promotion gate validated/)
})

test('release promotion validator rejects hosted promotion without private evidence', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      'scripts/validate-release-promotion.mjs',
      '--tier',
      'private-hosted-beta',
      '--manifest',
      'deploy/private-beta/launch-evidence-record.template.json',
    ], { encoding: 'utf8' }),
    /must not use the committed public launch evidence template/,
  )
})

test('release promotion validator accepts completed private hosted evidence', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-release-promotion-'))
  try {
    const manifestPath = await writeCompletedManifest(outputDir)
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/validate-release-promotion.mjs',
      '--tier',
      'private-hosted-beta',
      '--manifest',
      manifestPath,
    ], { encoding: 'utf8' })
    assert.match(stdout, /private-hosted-beta promotion gate validated/)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('release promotion validator rejects stale commit evidence for hosted releases', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-release-promotion-'))
  try {
    const manifestPath = await writeCompletedManifest(outputDir)
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/validate-release-promotion.mjs',
        '--tier',
        'private-hosted-beta',
        '--manifest',
        manifestPath,
        '--expected-commit-sha',
        '1111111111111111111111111111111111111111',
      ], { encoding: 'utf8' }),
      /must match expected release commit/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('release promotion validator binds hosted evidence to pushed OCI image digests', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-release-promotion-'))
  try {
    const manifestPath = await writeCompletedManifest(outputDir)
    const cloudImageJson = join(outputDir, 'open-cowork-cloud.image.json')
    const gatewayImageJson = join(outputDir, 'open-cowork-gateway.image.json')
    writeFileSync(cloudImageJson, `${JSON.stringify({ digest: cloudDigest }, null, 2)}\n`)
    writeFileSync(gatewayImageJson, `${JSON.stringify({ digest: gatewayDigest }, null, 2)}\n`)

    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/validate-release-promotion.mjs',
      '--tier',
      'private-hosted-beta',
      '--manifest',
      manifestPath,
      '--expected-commit-sha',
      commitSha,
      '--cloud-image-json',
      cloudImageJson,
      '--gateway-image-json',
      gatewayImageJson,
    ], { encoding: 'utf8' })
    assert.match(stdout, /private-hosted-beta promotion gate validated/)

    writeFileSync(gatewayImageJson, `${JSON.stringify({ digest: `sha256:${'3'.repeat(64)}` }, null, 2)}\n`)
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/validate-release-promotion.mjs',
        '--tier',
        'private-hosted-beta',
        '--manifest',
        manifestPath,
        '--cloud-image-json',
        cloudImageJson,
        '--gateway-image-json',
        gatewayImageJson,
      ], { encoding: 'utf8' }),
      /must match pushed gateway image digest/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('release promotion validator fails closed for unclaimed hosted tiers', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-release-promotion-'))
  try {
    const manifestPath = await writeCompletedManifest(outputDir)
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/validate-release-promotion.mjs',
        '--tier',
        'public-beta',
        '--manifest',
        manifestPath,
      ], { encoding: 'utf8' }),
      /public-beta is not claimable/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('release promotion validator rejects mismatched environment profile tiers', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-release-promotion-'))
  try {
    const manifest = completedPromotionManifest()
    manifest.requiredEvidence[0].report.sanitizedEnvironmentProfile.targetTier = 'public-beta'
    const manifestPath = join(outputDir, 'mismatched-promotion-evidence.json')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/validate-release-promotion.mjs',
        '--tier',
        'private-hosted-beta',
        '--manifest',
        manifestPath,
      ], { encoding: 'utf8' }),
      /targetTier must be private-beta/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('release promotion validator rejects private-looking sanitized profile values', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-release-promotion-'))
  try {
    const manifest = completedPromotionManifest()
    manifest.requiredEvidence[0].report.sanitizedEnvironmentProfile.redactedArtifact = [
      'ghp',
      'privatevalue123456789012345',
    ].join('_')
    const manifestPath = join(outputDir, 'unsafe-promotion-evidence.json')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/validate-release-promotion.mjs',
        '--tier',
        'private-hosted-beta',
        '--manifest',
        manifestPath,
      ], { encoding: 'utf8' }),
      /private-looking value/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('release promotion validator requires all matrix evidence commands', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-release-promotion-'))
  try {
    const manifest = completedPromotionManifest()
    const item = manifest.requiredEvidence.find((entry: { id: string }) => entry.id === 'gatewayDeliveryReplayDeadLetter')
    item.report.evidenceCommands = [item.command]
    const manifestPath = join(outputDir, 'partial-command-promotion-evidence.json')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/validate-release-promotion.mjs',
        '--tier',
        'private-hosted-beta',
        '--manifest',
        manifestPath,
      ], { encoding: 'utf8' }),
      /evidenceCommands must include pnpm deploy:gateway:smoke/,
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
