#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  requiredLaunchEvidenceIds,
  validateLaunchEvidenceManifest,
} from './validate-launch-evidence-manifest.mjs'

const matrixPath = 'deploy/load/launch-evidence-matrix.json'
const publicTemplatePath = 'deploy/private-beta/launch-evidence-record.template.json'

const tierConfigs = {
  'local-self-host-beta': {
    hosted: false,
    matrixTier: 'local-self-host-beta',
    evidenceTargetTier: null,
    evidenceProfile: 'local-self-host-beta',
  },
  'private-hosted-beta': {
    hosted: true,
    matrixTier: 'private-beta',
    evidenceTargetTier: 'private-beta',
    evidenceProfile: 'private-beta',
  },
  'public-beta': {
    hosted: true,
    matrixTier: 'public-beta',
    evidenceTargetTier: 'public-beta',
    evidenceProfile: 'public-beta',
  },
  'general-availability': {
    hosted: true,
    matrixTier: 'general-availability',
    evidenceTargetTier: 'general-availability',
    evidenceProfile: 'enterprise-scale',
  },
  'enterprise-ready': {
    hosted: true,
    matrixTier: 'enterprise-scale',
    evidenceTargetTier: 'enterprise-ready',
    evidenceProfile: 'enterprise-scale',
  },
}

const passStatuses = new Set(['go', 'pass', 'passed', 'private-pass', 'success'])
const forbiddenProfileKeyPattern = /(secret|token|password|private[_-]?key|database[_-]?url|credential|cookie)/i
const forbiddenValuePatterns = [
  /(?:sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bxoxb-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\b(?:price|prod|acct|cus|sub)_[0-9A-Za-z]{8,}\b/,
  /\b\d{12}\b/,
  /postgres(?:ql)?:\/\//i,
  /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|X-Goog-Credential|AWSAccessKeyId|sig|signature)=/i,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
]

function read(path) {
  return readFileSync(path, 'utf8')
}

function readJson(path) {
  return JSON.parse(read(path))
}

function assertFile(path) {
  if (!existsSync(path)) throw new Error(`${path} is required`)
}

function parseArgs(argv) {
  const args = {
    tier: process.env.OPEN_COWORK_RELEASE_CLAIM_TIER || 'local-self-host-beta',
    manifest: process.env.OPEN_COWORK_PROMOTION_EVIDENCE_MANIFEST || '',
    expectedCommitSha: process.env.OPEN_COWORK_EXPECTED_COMMIT_SHA || '',
    cloudImageJson: process.env.OPEN_COWORK_CLOUD_IMAGE_JSON || '',
    gatewayImageJson: process.env.OPEN_COWORK_GATEWAY_IMAGE_JSON || '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      continue
    } else if (arg === '--tier') {
      args.tier = argv[index + 1]
      index += 1
    } else if (arg === '--manifest') {
      args.manifest = argv[index + 1]
      index += 1
    } else if (arg === '--expected-commit-sha') {
      args.expectedCommitSha = argv[index + 1]
      index += 1
    } else if (arg === '--cloud-image-json') {
      args.cloudImageJson = argv[index + 1]
      index += 1
    } else if (arg === '--gateway-image-json') {
      args.gatewayImageJson = argv[index + 1]
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        `Usage: node scripts/validate-release-promotion.mjs --tier ${Object.keys(tierConfigs).join('|')} [--manifest path] [--expected-commit-sha sha] [--cloud-image-json path --gateway-image-json path]\n`,
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!args.tier) throw new Error('--tier is required')
  return args
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`${label} must be a 40-character commit SHA`)
  }
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be sha256:<64 hex>`)
  }
}

function expectedDigestFromImageJson(path, label) {
  if (!path) return null
  assertFile(path)
  const record = readJson(path)
  assertDigest(record.digest, `${label}.digest`)
  return record.digest
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`)
  }
}

function assertPassStatus(value, label) {
  if (typeof value !== 'string' || !passStatuses.has(value)) {
    throw new Error(`${label} must record a passing status`)
  }
}

function assertNoPrivateValues(value, label) {
  if (typeof value === 'string') {
    for (const pattern of forbiddenValuePatterns) {
      if (pattern.test(value)) throw new Error(`${label} contains private-looking value ${pattern}`)
    }
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    const isBooleanIndicator = typeof nested === 'boolean' && /(Provided|Configured|Enabled)$/i.test(key)
    if (forbiddenProfileKeyPattern.test(key) && !isBooleanIndicator) {
      throw new Error(`${label}.${key} must not expose secret-bearing metadata`)
    }
    assertNoPrivateValues(nested, `${label}.${key}`)
  }
}

function assertEnvironmentProfile(profile, config, itemId) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`${itemId}.report.sanitizedEnvironmentProfile must be an object`)
  }
  assertNoPrivateValues(profile, `${itemId}.report.sanitizedEnvironmentProfile`)
  const profileName = profile.profileName ?? profile.targetProfile ?? profile.launchProfile
  const targetTier = profile.targetTier ?? profile.claimTier ?? profile.promotionTier
  if (profileName !== config.evidenceProfile) {
    throw new Error(`${itemId}.report.sanitizedEnvironmentProfile.profileName must be ${config.evidenceProfile}`)
  }
  if (targetTier !== config.evidenceTargetTier) {
    throw new Error(`${itemId}.report.sanitizedEnvironmentProfile.targetTier must be ${config.evidenceTargetTier}`)
  }
}

function assertNoDryRunEvidence(item, report) {
  const values = [item.command, report.command, report.mode]
  if (Array.isArray(report.flags)) values.push(...report.flags)
  if (values.some((value) => typeof value === 'string' && /\bdry[-_ ]?run\b/i.test(value)) || report.dryRun === true) {
    throw new Error(`${item.id} must use executed evidence, not dry-run evidence`)
  }
}

function assertStrictCommandEvidence(item, report) {
  const command = `${item.command} ${report.command}`
  if ((item.id === 'deployedLoadTest' || item.id === 'quotaRateLimitBehavior') && !command.includes('deploy:load:strict')) {
    throw new Error(`${item.id} must use deploy:load:strict evidence`)
  }
  if ((item.id === 'deployedSoakTest' || item.id === 'costSloNotes') && !command.includes('deploy:soak:strict')) {
    throw new Error(`${item.id} must use deploy:soak:strict evidence`)
  }
}

function assertRollbackEvidence(item, report) {
  if (item.id !== 'releaseRollback') return
  const text = `${item.publicRedactedSummary} ${JSON.stringify(report)}`
  for (const phrase of ['rollback', 'revoke', 'drain', 'communication']) {
    if (!new RegExp(phrase, 'i').test(text)) {
      throw new Error(`releaseRollback evidence must mention ${phrase}`)
    }
  }
}

function assertReportFieldSet(manifest, report, itemId) {
  for (const field of manifest.requiredReportFields) {
    if (!(field in report)) throw new Error(`${itemId}.report.${field} is required`)
  }
}

function assertEvidenceCommands(matrix, item, report) {
  if (!Array.isArray(report.evidenceCommands) || report.evidenceCommands.length === 0) {
    throw new Error(`${item.id}.report.evidenceCommands must list executed evidence commands`)
  }
  for (const command of report.evidenceCommands) {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error(`${item.id}.report.evidenceCommands must contain non-empty strings`)
    }
  }
  const requiredCommands = matrix.privateBetaEvidenceItems?.items?.[item.id]?.requiredCommands ?? []
  for (const command of requiredCommands) {
    if (!report.evidenceCommands.includes(command)) {
      throw new Error(`${item.id}.report.evidenceCommands must include ${command}`)
    }
  }
  if (!report.evidenceCommands.includes(item.command)) {
    throw new Error(`${item.id}.report.evidenceCommands must include primary command ${item.command}`)
  }
}

function validateHostedManifest(args, config) {
  if (!args.manifest) {
    throw new Error(`${args.tier} promotion requires --manifest or OPEN_COWORK_PROMOTION_EVIDENCE_MANIFEST`)
  }
  assertFile(args.manifest)
  if (resolve(args.manifest) === resolve(publicTemplatePath)) {
    throw new Error(`${args.tier} promotion must not use the committed public launch evidence template`)
  }

  const { manifest, matrix } = validateLaunchEvidenceManifest({
    manifest: args.manifest,
    requirePrivatePass: true,
    expectedTargetTier: config.evidenceTargetTier,
  })
  if (manifest.scope === 'public-template-only') {
    throw new Error(`${args.tier} promotion must use a private operations evidence record, not a public template`)
  }

  let commitSha = null
  let cloudDigest = null
  let gatewayDigest = null
  const expectedCloudDigest = expectedDigestFromImageJson(args.cloudImageJson, 'cloud image evidence')
  const expectedGatewayDigest = expectedDigestFromImageJson(args.gatewayImageJson, 'gateway image evidence')
  if (args.expectedCommitSha) assertSha(args.expectedCommitSha, '--expected-commit-sha')
  for (const item of manifest.requiredEvidence) {
    if (!requiredLaunchEvidenceIds.includes(item.id)) {
      throw new Error(`${args.manifest} has unexpected promotion evidence item ${item.id}`)
    }
    const report = item.report
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw new Error(`${item.id}.report must attach strict environment evidence metadata`)
    }
    assertReportFieldSet(manifest, report, item.id)
    assertNoPrivateValues(report, `${item.id}.report`)
    if (report.command !== item.command) throw new Error(`${item.id}.report.command must match ${item.command}`)
    assertEvidenceCommands(matrix, item, report)
    assertSha(report.commitSha, `${item.id}.report.commitSha`)
    assertDigest(report.imageDigests?.cloud, `${item.id}.report.imageDigests.cloud`)
    assertDigest(report.imageDigests?.gateway, `${item.id}.report.imageDigests.gateway`)
    assertEnvironmentProfile(report.sanitizedEnvironmentProfile, config, item.id)
    assertIsoTimestamp(report.startedAt, `${item.id}.report.startedAt`)
    assertIsoTimestamp(report.finishedAt, `${item.id}.report.finishedAt`)
    if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) {
      throw new Error(`${item.id}.report.finishedAt must be after startedAt`)
    }
    if (typeof report.durationMs !== 'number' || !Number.isFinite(report.durationMs) || report.durationMs <= 0) {
      throw new Error(`${item.id}.report.durationMs must be a positive number`)
    }
    assertPassStatus(report.status, `${item.id}.report.status`)
    assertNoDryRunEvidence(item, report)
    assertStrictCommandEvidence(item, report)
    assertRollbackEvidence(item, report)

    commitSha ??= report.commitSha
    cloudDigest ??= report.imageDigests.cloud
    gatewayDigest ??= report.imageDigests.gateway
    if (report.commitSha !== commitSha) throw new Error(`${item.id}.report.commitSha must match all promotion evidence`)
    if (args.expectedCommitSha && report.commitSha !== args.expectedCommitSha) {
      throw new Error(`${item.id}.report.commitSha must match expected release commit ${args.expectedCommitSha}`)
    }
    if (report.imageDigests.cloud !== cloudDigest) {
      throw new Error(`${item.id}.report.imageDigests.cloud must match all promotion evidence`)
    }
    if (report.imageDigests.gateway !== gatewayDigest) {
      throw new Error(`${item.id}.report.imageDigests.gateway must match all promotion evidence`)
    }
    if (expectedCloudDigest && report.imageDigests.cloud !== expectedCloudDigest) {
      throw new Error(`${item.id}.report.imageDigests.cloud must match pushed cloud image digest ${expectedCloudDigest}`)
    }
    if (expectedGatewayDigest && report.imageDigests.gateway !== expectedGatewayDigest) {
      throw new Error(`${item.id}.report.imageDigests.gateway must match pushed gateway image digest ${expectedGatewayDigest}`)
    }
  }
}

function validateLocalTier(matrix) {
  if (matrix.acceptedPublicTier !== 'local-self-host-beta') {
    throw new Error(`${matrixPath} must keep acceptedPublicTier local-self-host-beta for the public release gate`)
  }
  for (const [tier, record] of Object.entries(matrix.tiers ?? {})) {
    if (tier === 'local-self-host-beta') {
      if (record.claimStatus !== 'accepted-public') throw new Error(`${tier} must remain accepted-public`)
    } else if (record.claimStatus === 'accepted-public') {
      throw new Error(`${tier} must not be accepted-public without hosted promotion evidence`)
    }
  }
}

export function validateReleasePromotion(options = {}) {
  assertFile(matrixPath)
  const args = {
    ...parseArgs([]),
    ...options,
  }
  const config = tierConfigs[args.tier]
  if (!config) throw new Error(`Unknown promotion tier ${args.tier}`)
  const matrix = readJson(matrixPath)
  validateLocalTier(matrix)
  if (!config.hosted) return { tier: args.tier, hosted: false }

  const matrixTier = matrix.tiers?.[config.matrixTier]
  if (!matrixTier) throw new Error(`${matrixPath} is missing ${config.matrixTier}`)
  if (matrixTier.claimStatus === 'not-claimed') {
    throw new Error(`${args.tier} is not claimable until ${matrixPath} records explicit private-ops promotion requirements`)
  }
  if (matrixTier.claimStatus !== 'requires-private-ops-evidence') {
    throw new Error(`${args.tier} must require private operations evidence before promotion`)
  }
  validateHostedManifest(args, config)
  return { tier: args.tier, hosted: true }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  validateReleasePromotion(args)
  process.stdout.write(`[release-promotion-validate] ${args.tier} promotion gate validated\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
