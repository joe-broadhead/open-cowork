#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'docs', 'development', 'validation-gates.json')
const map = JSON.parse(fs.readFileSync(file, 'utf-8'))

const allowedPullRequestStatus = new Set(['required', 'skipped_on_pull_request', 'manual_or_local'])
const allowedClaimEffects = new Set([
  'blocks_merge_for_applicable_changes',
  'blocks_release_claim_for_applicable_changes',
  'evidence_only_no_release_claim',
  'cannot_advance_release_claim_alone',
])
const requiredFields = [
  'id',
  'title',
  'category',
  'ownerCommand',
  'expectedRuntime',
  'requiredEnvironment',
  'failureClass',
  'claimEffect',
  'requiredFor',
  'evidenceKind',
  'ci',
]
const requiredProductionAgentSurfaces = [
  'channel',
  'scheduler',
  'storage',
  'mission_control',
  'release_evidence',
  'security',
  'operations',
  'agent_factory',
  'docs',
]
const requiredFailureDiagnostics = [
  'slow_tests',
  'flaky_gate',
  'failed_release_check',
  'evidence_safety_failure',
  'missing_review_gate_proof',
  'docs_strict_failure',
  'module_boundary_budget_failure',
]
const requiredEvidenceTemplates = [
  'production_agent_brief',
  'completion_linear_comment',
  'evidence_summary_json',
  'review_gate_prompt',
  'release_note_state',
]
const requiredGlobalGates = [
  'npm run typecheck',
  'npm run release:check',
  'npm run evidence:safety',
  'local-only read-only autoreview/review-gate PASS',
]
const requiredForbiddenReviewCapabilities = [
  'file edits',
  'git state changes',
  'web search',
  'WebFetch',
  'Browser tools',
  'remote GitHub context',
  'remote Linear context',
  'out-of-repo reads',
  'private notes',
  'secrets',
]

const failures = []
function fail(message) {
  failures.push(message)
}

if (!map || typeof map !== 'object' || Array.isArray(map)) fail('map must be a JSON object')
if (map.version !== 1) fail('version must be 1')
if (typeof map.claimBoundary !== 'string' || !/no release-claim expansion/i.test(map.claimBoundary)) {
  fail('claimBoundary must state no release-claim expansion')
}
if (!Array.isArray(map.gates) || map.gates.length < 10) fail('gates must contain at least 10 gate entries')

const ids = new Set()
for (const [index, gate] of (Array.isArray(map.gates) ? map.gates : []).entries()) {
  const prefix = `gates[${index}]`
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    fail(`${prefix} must be an object`)
    continue
  }
  for (const field of requiredFields) {
    if (!(field in gate)) fail(`${prefix}.${field} is required`)
  }
  if (typeof gate.id === 'string') {
    if (ids.has(gate.id)) fail(`duplicate gate id: ${gate.id}`)
    ids.add(gate.id)
  }
  if (!Array.isArray(gate.requiredFor) || gate.requiredFor.length === 0) fail(`${prefix}.requiredFor must be a non-empty array`)
  if (!allowedClaimEffects.has(gate.claimEffect)) fail(`${prefix}.claimEffect has unsupported value ${String(gate.claimEffect)}`)
  if (!gate.ci || typeof gate.ci !== 'object' || Array.isArray(gate.ci)) {
    fail(`${prefix}.ci must be an object`)
  } else if (!allowedPullRequestStatus.has(gate.ci.pullRequest)) {
    fail(`${prefix}.ci.pullRequest has unsupported value ${String(gate.ci.pullRequest)}`)
  }
  if (gate.ci?.pullRequest === 'skipped_on_pull_request' && typeof gate.ci.skipSemantics !== 'string') {
    fail(`${prefix}.ci.skipSemantics is required when pullRequest is skipped_on_pull_request`)
  }
}

for (const id of ['typecheck', 'unit-full', 'build', 'release-contract', 'docs-strict', 'workflow-lint', 'docker-pr-smoke', 'docker-image', 'github-release', 'local-readonly-review-gate', 'elapsed-soak']) {
  if (!ids.has(id)) fail(`missing required gate id: ${id}`)
}

const dockerPrSmoke = map.gates?.find(gate => gate.id === 'docker-pr-smoke')
if (dockerPrSmoke?.ci?.pullRequest !== 'required') fail('docker-pr-smoke must be marked required on pull requests')
const docker = map.gates?.find(gate => gate.id === 'docker-image')
if (docker?.ci?.pullRequest !== 'skipped_on_pull_request') fail('docker-image must be marked skipped_on_pull_request')
const release = map.gates?.find(gate => gate.id === 'github-release')
if (!/tag/i.test(String(release?.ci?.skipSemantics || ''))) fail('github-release skipSemantics must mention tag-only behavior')

validateProductionAgentSurfaces(map.productionAgentSurfaces)
validateFailureDiagnostics(map.failureDiagnostics)
validateEvidenceTemplates(map.evidenceTemplates)
validateReviewGatePolicy(map.reviewGatePolicy)
validateReferencedPaths(map)

if (failures.length > 0) {
  for (const failure of failures) console.error(`validation gate check failed: ${failure}`)
  process.exit(1)
}

console.log(`validation gate check passed for ${map.gates.length} gates, ${map.productionAgentSurfaces.length} production-agent surfaces`)

function validateProductionAgentSurfaces(surfaces) {
  if (!Array.isArray(surfaces)) {
    fail('productionAgentSurfaces must be an array')
    return
  }
  const ids = new Set()
  for (const [index, surface] of surfaces.entries()) {
    const prefix = `productionAgentSurfaces[${index}]`
    if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
      fail(`${prefix} must be an object`)
      continue
    }
    if (typeof surface.id === 'string') ids.add(surface.id)
    for (const field of ['id', 'owner', 'safeNextAction']) {
      if (typeof surface[field] !== 'string' || surface[field].length === 0) fail(`${prefix}.${field} must be a non-empty string`)
    }
    for (const field of ['changedWhen', 'focusedGates', 'requiredGlobalGates', 'evidenceOutputs']) {
      if (!Array.isArray(surface[field]) || surface[field].length === 0) fail(`${prefix}.${field} must be a non-empty array`)
    }
    for (const gate of requiredGlobalGates) {
      if (!surface.requiredGlobalGates?.includes(gate)) fail(`${prefix}.requiredGlobalGates missing ${gate}`)
    }
    if (surface.reviewGateRequired !== true) fail(`${prefix}.reviewGateRequired must be true`)
    if (typeof surface.redactionRequired !== 'boolean') fail(`${prefix}.redactionRequired must be boolean`)
  }
  for (const id of requiredProductionAgentSurfaces) {
    if (!ids.has(id)) fail(`missing production agent surface: ${id}`)
  }
}

function validateFailureDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) {
    fail('failureDiagnostics must be an array')
    return
  }
  const ids = new Set()
  for (const [index, diagnostic] of diagnostics.entries()) {
    const prefix = `failureDiagnostics[${index}]`
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
      fail(`${prefix} must be an object`)
      continue
    }
    if (typeof diagnostic.id === 'string') ids.add(diagnostic.id)
    for (const field of ['id', 'failureClass', 'severity', 'detection', 'safeNextAction', 'forbiddenShortcut']) {
      if (typeof diagnostic[field] !== 'string' || diagnostic[field].length === 0) fail(`${prefix}.${field} must be a non-empty string`)
    }
    if (!['warning', 'critical'].includes(diagnostic.severity)) fail(`${prefix}.severity must be warning or critical`)
    if (!Array.isArray(diagnostic.evidenceRefs) || diagnostic.evidenceRefs.length === 0) fail(`${prefix}.evidenceRefs must be a non-empty array`)
    if (diagnostic.id === 'missing_review_gate_proof') {
      if (diagnostic.severity !== 'critical') fail('missing_review_gate_proof must be critical')
      if (!/Stop PR review or merge/i.test(diagnostic.safeNextAction)) fail('missing_review_gate_proof safeNextAction must stop PR review or merge')
    }
  }
  for (const id of requiredFailureDiagnostics) {
    if (!ids.has(id)) fail(`missing failure diagnostic: ${id}`)
  }
}

function validateEvidenceTemplates(templates) {
  if (!Array.isArray(templates)) {
    fail('evidenceTemplates must be an array')
    return
  }
  const ids = new Set()
  for (const [index, template] of templates.entries()) {
    const prefix = `evidenceTemplates[${index}]`
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      fail(`${prefix} must be an object`)
      continue
    }
    if (typeof template.id === 'string') ids.add(template.id)
    for (const field of ['id', 'safeNextAction', 'exampleRef']) {
      if (typeof template[field] !== 'string' || template[field].length === 0) fail(`${prefix}.${field} must be a non-empty string`)
    }
    for (const field of ['requiredFields', 'blockedFields']) {
      if (!Array.isArray(template[field]) || template[field].length === 0) fail(`${prefix}.${field} must be a non-empty array`)
    }
  }
  for (const id of requiredEvidenceTemplates) {
    if (!ids.has(id)) fail(`missing evidence template: ${id}`)
  }
}

function validateReviewGatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('reviewGatePolicy must be an object')
    return
  }
  if (policy.finalDiffRequirement !== 'final_committed_diff_from_latest_main') fail('reviewGatePolicy.finalDiffRequirement must be final_committed_diff_from_latest_main')
  if (policy.requiredBefore !== 'pr_review_or_merge') fail('reviewGatePolicy.requiredBefore must be pr_review_or_merge')
  if (policy.mode !== 'local_only_read_only') fail('reviewGatePolicy.mode must be local_only_read_only')
  if (policy.requiredResult !== 'PASS') fail('reviewGatePolicy.requiredResult must be PASS')
  for (const field of ['forbiddenCapabilities', 'allowedEvidenceCommands', 'requiredEvidenceFields']) {
    if (!Array.isArray(policy[field]) || policy[field].length === 0) fail(`reviewGatePolicy.${field} must be a non-empty array`)
  }
  for (const capability of requiredForbiddenReviewCapabilities) {
    if (!policy.forbiddenCapabilities?.includes(capability)) fail(`reviewGatePolicy.forbiddenCapabilities missing ${capability}`)
  }
  if (!/blocker/i.test(String(policy.unavailableAction || ''))) fail('reviewGatePolicy.unavailableAction must mention blocker')
}

function validateReferencedPaths(value) {
  const refs = new Set()
  collectPathReferences(value, refs)
  for (const ref of refs) {
    if (!fs.existsSync(path.join(root, ref))) fail(`referenced path is missing: ${ref}`)
  }
}

function collectPathReferences(value, refs) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\b(?:src|scripts|docs)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|json|md|txt|yml|yaml)\b/g)) {
      refs.add(match[0])
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathReferences(item, refs)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPathReferences(item, refs)
  }
}
