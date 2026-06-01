#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'

const matrixPath = 'deploy/load/launch-evidence-matrix.json'
const defaultManifestPath = 'deploy/private-beta/launch-evidence-record.template.json'
const publicSummaryPath = 'deploy/private-beta/private-beta-go-no-go.public.md'
const packagePath = 'package.json'

const requiredEvidenceIds = [
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
]

const statusValues = new Set([
  'pending-private-evidence',
  'private-pass',
  'private-fail',
  'not-applicable-with-rationale',
])

const requiredReportFields = [
  'command',
  'commitSha',
  'imageDigests',
  'sanitizedEnvironmentProfile',
  'startedAt',
  'finishedAt',
  'durationMs',
  'status',
]

const requiredPublicAllowedFields = [
  'command name without secret arguments',
  'commit SHA',
  'image digests',
  'sanitized environment profile',
  'dates and duration',
  'pass/fail or go/no-go status',
]

const publicForbiddenMarkers = [
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

function assertIncludes(path, text) {
  if (!read(path).includes(text)) throw new Error(`${path} must include ${text}`)
}

function assertPublicSafe(path) {
  assertPublicSafeText(read(path), path)
}

function assertPublicSafeText(contents, label) {
  for (const marker of publicForbiddenMarkers) {
    if (contents.includes(marker)) throw new Error(`${label} must not include private marker ${marker}`)
  }
  for (const pattern of [
    /(?:sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}/,
    /\b(?:price|prod|acct|cus|sub)_[A-Za-z0-9_]{8,}/,
    /postgres(?:ql)?:\/\//i,
    /https?:\/\/(?!cowork\.example\.com\b|gateway\.example\.com\b|example\.com\b)[^\s)]+/i,
  ]) {
    if (pattern.test(contents)) throw new Error(`${label} must not include private-looking value ${pattern}`)
  }
}

function parseArgs(argv) {
  const args = {
    manifest: defaultManifestPath,
    requirePrivatePass: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      continue
    } else if (arg === '--manifest') {
      args.manifest = argv[index + 1]
      index += 1
    } else if (arg === '--require-private-pass') {
      args.requirePrivatePass = true
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/validate-launch-evidence-manifest.mjs [--manifest path] [--require-private-pass]\n`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!args.manifest) throw new Error('--manifest requires a path')
  return args
}

function commandScript(command) {
  const match = /^pnpm\s+([^\s]+)(?:\s|$)/.exec(command)
  return match?.[1] ?? null
}

function isPlaceholder(value) {
  return typeof value !== 'string' || value.trim().length === 0 || /^\{[^}]+\}$/.test(value.trim())
}

function assertCompletedValue(record, key, itemId) {
  if (isPlaceholder(record[key])) throw new Error(`${itemId}.${key} must be populated for private-pass evidence`)
}

function assertChecksum(value, itemId) {
  if (typeof value !== 'string') throw new Error(`${itemId}.checksum must be a string`)
  if (/^sha256:[a-f0-9]{64}$/i.test(value)) return
  if (/^artifact:[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$/.test(value)) return
  throw new Error(`${itemId}.checksum must be sha256:<64 hex> or artifact:<immutable id>`)
}

function assertArrayContainsAll(values, required, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  for (const value of required) {
    if (!values.includes(value)) throw new Error(`${label} must include ${value}`)
  }
}

const args = parseArgs(process.argv.slice(2))
for (const path of [matrixPath, defaultManifestPath, publicSummaryPath, packagePath, args.manifest]) assertFile(path)

const packageJson = readJson(packagePath)
const matrix = readJson(matrixPath)
if (matrix.schemaVersion !== 1) throw new Error(`${matrixPath} must declare schemaVersion 1`)
if (matrix.acceptedPublicTier !== 'local-self-host-beta') {
  throw new Error(`${matrixPath} must keep local-self-host-beta as the public tier until private evidence is complete`)
}
if (matrix.privateBetaEvidenceItems?.requiredStatusForGo !== 'private-pass') {
  throw new Error(`${matrixPath} must require private-pass for go decisions`)
}
if (matrix.privateBetaEvidenceItems?.storageRule?.includes('tokens') !== true) {
  throw new Error(`${matrixPath} must document private evidence storage and token redaction`)
}

const matrixItems = matrix.privateBetaEvidenceItems?.items ?? {}
const matrixIds = Object.keys(matrixItems)
for (const id of requiredEvidenceIds) {
  const item = matrixItems[id]
  if (!item) throw new Error(`${matrixPath} is missing private beta evidence item ${id}`)
  if (item.requiredForPrivateBeta !== true) throw new Error(`${id} must be required for private beta`)
  if (typeof item.passCondition !== 'string' || item.passCondition.length < 30) {
    throw new Error(`${id} must define a concrete pass condition`)
  }
  if (!Array.isArray(item.publicArtifacts) || item.publicArtifacts.length === 0) {
    throw new Error(`${id} must list public artifacts`)
  }
  for (const artifact of item.publicArtifacts) assertFile(artifact)
  if (!Array.isArray(item.requiredCommands) || item.requiredCommands.length === 0) {
    throw new Error(`${id} must list required commands`)
  }
  for (const command of item.requiredCommands) {
    const script = commandScript(command)
    if (script && typeof packageJson.scripts?.[script] !== 'string') {
      throw new Error(`${id} references missing package script ${script}`)
    }
  }
}
for (const id of matrixIds) {
  if (!requiredEvidenceIds.includes(id)) throw new Error(`${matrixPath} has unexpected private beta evidence item ${id}`)
}

const manifest = readJson(args.manifest)
if (manifest.schemaVersion !== 1) throw new Error(`${args.manifest} must declare schemaVersion 1`)
if (manifest.purpose !== 'managed-byok-private-beta-launch-evidence-record-template') {
  throw new Error(`${args.manifest} must declare purpose managed-byok-private-beta-launch-evidence-record-template`)
}
if (manifest.targetTier !== 'private-beta') throw new Error(`${args.manifest} must target private-beta`)
if (manifest.currentPublicTier !== 'local-self-host-beta') {
  throw new Error(`${args.manifest} must keep currentPublicTier local-self-host-beta`)
}
if (manifest.publicPrivateBoundary?.publicSummaryStorage !== publicSummaryPath) {
  throw new Error(`${args.manifest} must point to ${publicSummaryPath}`)
}
assertArrayContainsAll(
  manifest.publicPrivateBoundary?.allowedPublicFields,
  requiredPublicAllowedFields,
  `${args.manifest}.publicPrivateBoundary.allowedPublicFields`,
)
assertArrayContainsAll(manifest.requiredReportFields, requiredReportFields, `${args.manifest}.requiredReportFields`)

const manifestItems = manifest.requiredEvidence
if (!Array.isArray(manifestItems)) throw new Error(`${args.manifest} must list requiredEvidence`)
const seen = new Set()
for (const item of manifestItems) {
  if (!requiredEvidenceIds.includes(item.id)) throw new Error(`${args.manifest} has unexpected evidence id ${item.id}`)
  if (seen.has(item.id)) throw new Error(`${args.manifest} has duplicate evidence id ${item.id}`)
  seen.add(item.id)
  if (item.blockingForPrivateBeta !== true) throw new Error(`${item.id} must block private beta`)
  if (!statusValues.has(item.status)) throw new Error(`${item.id} has invalid status ${item.status}`)
  if (typeof item.command !== 'string' || item.command.length === 0) throw new Error(`${item.id} must record command`)
  const script = commandScript(item.command)
  if (script && typeof packageJson.scripts?.[script] !== 'string') {
    throw new Error(`${item.id} references missing package script ${script}`)
  }
  if (args.requirePrivatePass) {
    if (item.status !== 'private-pass') throw new Error(`${item.id} must be private-pass for private-beta go`)
    assertCompletedValue(item, 'privateEvidenceRef', item.id)
    assertCompletedValue(item, 'publicRedactedSummary', item.id)
    assertCompletedValue(item, 'checksum', item.id)
    assertCompletedValue(item, 'owner', item.id)
    assertPublicSafeText(item.publicRedactedSummary, `${item.id}.publicRedactedSummary`)
    assertChecksum(item.checksum, item.id)
  }
}
for (const id of requiredEvidenceIds) {
  if (!seen.has(id)) throw new Error(`${args.manifest} is missing required evidence ${id}`)
}

for (const path of [matrixPath, defaultManifestPath, publicSummaryPath]) {
  assertPublicSafe(path)
}

for (const id of requiredEvidenceIds) {
  assertIncludes(publicSummaryPath, id)
}
assertIncludes(publicSummaryPath, 'Decision: `no-go`')
assertIncludes(publicSummaryPath, 'Current public tier: `local-self-host-beta`')
assertIncludes(publicSummaryPath, 'pending-private-evidence')
assertIncludes(publicSummaryPath, 'no-go')

process.stdout.write('[launch-evidence-validate] launch evidence manifest validated\n')
