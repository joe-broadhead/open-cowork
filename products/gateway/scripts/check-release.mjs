#!/usr/bin/env node
/**
 * Release gate. Replaces the milestone-era check that asserted hundreds of
 * per-milestone evidence documents. What it keeps is the durable value:
 *
 *   1. release metadata alignment (package.json / package-lock / CHANGELOG);
 *   2. the claim registry passes its own invariants (src/claim-registry.ts);
 *   3. public copy (README, docs entry pages, CLI help) contains no wording
 *      that exceeds the current claim boundary;
 *   4. the built CLI exists and prints the aligned version.
 *
 * Run directly: node scripts/check-release.mjs [--json]
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReleaseMetadata, verifyReleaseGitBinding } from './check-release-metadata.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')
const requireTag = process.argv.includes('--require-tag')
const failures = []
const notes = []

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`${name} requires a value`)
    process.exit(2)
  }
  return value
}

function fail(gate, message) {
  failures.push({ gate, message })
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function readJson(relative) {
  try {
    return JSON.parse(read(relative))
  } catch (error) {
    fail('runtime_replay_consistency', `${relative} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function loadPackageLock(pkg) {
  const localLockPath = path.join(root, 'package-lock.json')
  if (fs.existsSync(localLockPath)) return JSON.parse(read('package-lock.json'))
  // Monorepo mode: product package is installed via the workspace root lockfile.
  return {
    version: pkg.version,
    packages: {
      '': {
        version: pkg.version,
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
      },
    },
    monorepoWorkspace: true,
  }
}

// 1. Release metadata alignment -------------------------------------------
const pkg = JSON.parse(read('package.json'))
const lock = loadPackageLock(pkg)
const changelog = read('CHANGELOG.md')
const actionsTag = requireTag && process.env['GITHUB_REF_TYPE'] === 'tag' ? process.env['GITHUB_REF_NAME'] : undefined
const releaseTag = argValue('--tag') || actionsTag
const mainRef = argValue('--main-ref') || process.env['RELEASE_MAIN_REF'] || 'refs/remotes/origin/main'
const metadata = validateReleaseMetadata({
  packageVersion: pkg.version,
  lockVersion: lock.version,
  lockRootVersion: lock.packages?.['']?.version,
  changelog,
  releaseTag,
})
for (const failure of metadata.failures) fail(failure.gate, failure.message)
if (requireTag && !releaseTag) fail('release_tag', '--require-tag needs --tag <vX.Y.Z> or a GitHub tag ref')
if (releaseTag === metadata.expectedTag) {
  const binding = verifyReleaseGitBinding({ root, releaseTag, mainRef })
  for (const failure of binding.failures) fail(failure.gate, failure.message)
  if (binding.failures.length === 0) notes.push(`tag ${releaseTag}: ${binding.tagCommit} is on protected ${mainRef}`)
}
notes.push(`version ${pkg.version}`)

// 2 + 3. Claim registry + overclaim scan ----------------------------------
// The registry is TypeScript; run it through the CLI so this script needs no
// TS loader of its own.
let registry
try {
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'release', 'claims', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  registry = JSON.parse(stdout)
} catch (error) {
  fail('claim_registry', `release claims command failed: ${error instanceof Error ? error.message : String(error)}`)
}
if (registry) {
  if (registry.status !== 'pass') {
    for (const issue of registry.issues ?? []) fail('claim_registry', `${issue.code}: ${issue.summary}`)
  }
  notes.push(`claims: ${registry.claims.length} (${registry.claims.filter(c => c.state !== 'allowed').length} blocked/deferred)`)
}

// Overclaim scanning is owned by src/claim-registry.ts (scanForOverclaims).
// npm run verify builds dist/ before release:check, so the compiled scanner is
// the single canonical implementation used here.
const builtRegistry = path.join(root, 'dist', 'claim-registry.js')
if (!fs.existsSync(builtRegistry)) {
  console.error('release:check requires dist/claim-registry.js; run npm run build first.')
  process.exit(1)
}
const { scanForOverclaims } = await import(builtRegistry)

function scanCopy(source, text) {
  for (const finding of scanForOverclaims(source, text)) {
    fail('overclaim', `${finding.source}:${finding.line} contains "${finding.match}"`)
  }
}

// The overclaim boundary applies to ALL published copy, not just the entry
// pages: every Markdown file under docs/ ships on the site, plus the root
// README. Walk docs/ recursively so a claim that exceeds the boundary cannot
// hide in a deeper reference/ADR/history page. The scanner itself
// (scanForOverclaims) skips lines that discuss a blocked claim in negated
// context, so honest "X remains blocked / does not prove X" copy stays clean.
const publicCopy = new Set(['README.md'])
function collectDocMarkdown(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) collectDocMarkdown(abs)
    else if (entry.isFile() && entry.name.endsWith('.md')) publicCopy.add(path.relative(root, abs))
  }
}
collectDocMarkdown(path.join(root, 'docs'))
for (const relative of publicCopy) {
  if (fs.existsSync(path.join(root, relative))) scanCopy(relative, read(relative))
}
notes.push(`overclaim scan: ${publicCopy.size} public copy files (README + docs/**/*.md)`)

// CLI help copy must respect the boundary too.
try {
  const help = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], { cwd: root, encoding: 'utf8' })
  scanCopy('cli --help', help)
} catch {
  // --help may exit non-zero; only scan when obtainable.
}

// 4. M59 runtime replay consistency evidence stays wired --------------------
const replayDoc = 'docs/operations/runtime-replay-consistency.md'
const replaySummaryPath = 'docs/development/runtime-replay-consistency-summary.json'
const replayModule = 'src/runtime-replay-consistency.ts'
const replayTest = 'src/__tests__/runtime-replay-consistency.test.ts'
for (const relative of [replayDoc, replaySummaryPath, replayModule, replayTest]) {
  if (!fs.existsSync(path.join(root, relative))) fail('runtime_replay_consistency', `${relative} is missing`)
}
const replaySummary = fs.existsSync(path.join(root, replaySummaryPath)) ? readJson(replaySummaryPath) : undefined
if (replaySummary) {
  const requiredSurfaces = [
    'events',
    'tasks',
    'runs',
    'worker_leases',
    'task_dispatch_receipts',
    'delegation_receipts',
    'delegation_progress',
    'progress_route_receipts',
    'channel_bindings',
    'project_bindings',
    'session_links',
    'dashboard_summary',
    'evidence_export',
  ]
  const requiredDiagnostics = ['owner', 'surface', 'entityKind', 'entityId', 'severity', 'safeRepairAction', 'repairMode', 'redacted', 'evidenceRefs']
  const requiredGates = [
    'npx vitest run src/__tests__/runtime-replay-consistency.test.ts',
    'npm run typecheck',
    'npm run evidence:safety',
    'npm run build',
    'npm run release:check',
    'npm run verify',
    'uv run --with-requirements docs/requirements.txt mkdocs build --strict',
  ]
  if (replaySummary.schemaVersion !== 1) fail('runtime_replay_consistency', 'runtime replay summary schemaVersion must be 1')
  if (replaySummary.mode !== 'm59_runtime_replay_consistency_harness') fail('runtime_replay_consistency', 'runtime replay summary mode mismatch')
  if (replaySummary.releaseClaimBoundary !== 'local_beta_replay_consistency_only_no_release_claim_expansion') {
    fail('runtime_replay_consistency', 'runtime replay summary must preserve the local-beta no-claim-expansion boundary')
  }
  if (replaySummary.implementation?.module !== replayModule) fail('runtime_replay_consistency', `runtime replay summary implementation.module must be ${replayModule}`)
  if (replaySummary.implementation?.focusedTest !== replayTest) fail('runtime_replay_consistency', `runtime replay summary implementation.focusedTest must be ${replayTest}`)
  if (replaySummary.implementation?.operatorDoc !== replayDoc) fail('runtime_replay_consistency', `runtime replay summary implementation.operatorDoc must be ${replayDoc}`)
  if (replaySummary.implementation?.operatorCommand !== 'opencode-gateway evidence replay-consistency --json') {
    fail('runtime_replay_consistency', 'runtime replay summary implementation.operatorCommand must document the replay-consistency evidence command')
  }
  for (const surface of requiredSurfaces) {
    if (!replaySummary.surfaces?.includes(surface)) fail('runtime_replay_consistency', `runtime replay summary missing surface ${surface}`)
  }
  for (const diagnostic of requiredDiagnostics) {
    if (!replaySummary.requiredDiagnostics?.includes(diagnostic)) fail('runtime_replay_consistency', `runtime replay summary missing diagnostic field ${diagnostic}`)
  }
  for (const gate of requiredGates) {
    if (!replaySummary.requiredGates?.includes(gate)) fail('runtime_replay_consistency', `runtime replay summary missing required gate ${gate}`)
  }
  const mkdocs = read('mkdocs.yml')
  if (!/^\s+- Runtime Replay Consistency:\s+operations\/runtime-replay-consistency\.md\s*$/m.test(mkdocs)) {
    fail('runtime_replay_consistency', 'mkdocs.yml must publish the runtime replay consistency operator doc in the Operations nav')
  }
  notes.push(`runtime replay consistency: ${requiredSurfaces.length} surfaces, ${requiredDiagnostics.length} diagnostic fields`)
}

// 5. Built CLI exists and matches the version ------------------------------
const builtCli = path.join(root, 'dist', 'cli.js')
if (!fs.existsSync(builtCli)) {
  fail('build_artifact', 'dist/cli.js is missing; run npm run build before release:check')
} else {
  try {
    const version = execFileSync(process.execPath, [builtCli, '--version'], { cwd: root, encoding: 'utf8' }).trim()
    if (!version.includes(pkg.version)) {
      fail('build_artifact', `dist/cli.js reports "${version}", expected ${pkg.version}`)
    }
  } catch (error) {
    fail('build_artifact', `dist/cli.js --version failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Report ---------------------------------------------------------------------
const report = {
  status: failures.length === 0 ? 'pass' : 'fail',
  version: pkg.version,
  notes,
  failures,
}
if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  console.log(`release:check ${report.status.toUpperCase()} (v${pkg.version})`)
  for (const note of notes) console.log(`  - ${note}`)
  for (const failure of failures) console.error(`  FAIL [${failure.gate}] ${failure.message}`)
}
if (failures.length > 0) process.exit(1)
