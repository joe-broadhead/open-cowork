import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Doc-coverage gate (audit Tranche E): every OPERATOR-facing OPEN_COWORK_* env var
// the cloud control plane (`packages/cloud-server/src`) and the Cloud Channel
// Gateway (`apps/gateway/src`) read from the environment must be documented in
// `docs/open-cowork-cloud.md`. This stops new operator knobs from shipping
// read-but-undocumented (the exact class of gap this tranche closed: CORS origin,
// SSRF/runtime allowlist, the discord/whatsapp/signal bridge family, and the
// SSE/connection-cap vars).
//
// Scope is deliberately the two surfaces `docs/open-cowork-cloud.md` is the
// document-of-record for. The standalone gateway (`apps/standalone-gateway`) has
// its own doc, and `packages/runtime-host` carries desktop/runtime-injection vars
// that are not operator deployment knobs, so neither is scanned here.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docPath = join(repoRoot, 'docs', 'open-cowork-cloud.md')

const scannedSourceDirs = [
  join(repoRoot, 'packages', 'cloud-server', 'src'),
  join(repoRoot, 'apps', 'gateway', 'src'),
]

const scannedExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])

// Directories/files that never carry operator-facing env reads.
function isSkippedPath(path: string): boolean {
  return /(?:^|[/\\])(?:dist|node_modules|__tests__|__snapshots__)(?:[/\\]|$)/.test(path)
    || /\.test\.[cm]?[jt]sx?$/.test(path)
    || /\.d\.ts$/.test(path)
}

// Documented exclusion allowlist: vars that are read in the scanned source but are
// NOT operator deployment knobs — they are internal runtime-injection values the
// cloud worker SETS for spawned children / in-session MCPs. Each entry has a reason
// so the allowlist stays small and meaningful rather than a silent escape hatch.
const internalInjectionExclusions = new Set<string>([
  // Injected into the spawned OpenCode runtime so the in-session knowledge MCP can
  // call back to cloud — not set by an operator.
  'OPEN_COWORK_KNOWLEDGE_TOOL_URL',
  'OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN',
  // Resolved path to the bundled knowledge MCP script (cloud build wiring); has a
  // working default and is internal packaging, not a deployment knob.
  'OPEN_COWORK_CLOUD_KNOWLEDGE_MCP_PATH',
  // git credential-helper file paths the worker writes and sets for a child git
  // process during project-source restore — internal injection, not operator config.
  'OPEN_COWORK_GIT_USERNAME_FILE',
  'OPEN_COWORK_GIT_PASSWORD_FILE',
])

// Pattern exclusions for test-only / e2e-only vars (read under NODE_ENV=test or by
// e2e harnesses), so the gate covers real operator knobs without false positives.
function isExcludedByPattern(name: string): boolean {
  return name.includes('_TEST_') || name.includes('_E2E')
}

function walk(dir: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (isSkippedPath(full)) continue
    if (entry.isDirectory()) {
      walk(full, out)
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    const ext = dot >= 0 ? entry.name.slice(dot) : ''
    if (!scannedExtensions.has(ext)) continue
    out.push(full)
  }
}

function collectOperatorEnvVars(): Set<string> {
  const vars = new Set<string>()
  const files: string[] = []
  for (const dir of scannedSourceDirs) walk(dir, files)
  assert.ok(files.length > 0, 'expected to scan at least one cloud-server/gateway source file')
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/OPEN_COWORK_[A-Z0-9_]+/g)) {
      const name = match[0]
      // Drop dynamic-prefix artifacts like `OPEN_COWORK_GATEWAY_` from
      // `env[`${prefix}_DELIVERY_URL`]` — a trailing underscore is never a full var.
      if (name.endsWith('_')) continue
      if (internalInjectionExclusions.has(name)) continue
      if (isExcludedByPattern(name)) continue
      vars.add(name)
    }
  }
  return vars
}

test('every operator-facing cloud/gateway OPEN_COWORK_* env var is documented in docs/open-cowork-cloud.md', () => {
  // Read directly and handle the error instead of stat()-then-read (avoids a
  // check-then-use TOCTOU). ENOENT covers "missing" and EISDIR covers
  // "exists but is not a regular file", matching the prior statSync().isFile() check.
  let docText: string
  try {
    docText = readFileSync(docPath, 'utf8')
  } catch (err) {
    assert.fail(`${docPath} must exist and be a readable file: ${(err as Error).message}`)
  }
  const operatorVars = [...collectOperatorEnvVars()].sort()
  assert.ok(operatorVars.length > 0, 'expected to discover operator env vars to check')

  const undocumented = operatorVars.filter((name) => !docText.includes(name))
  assert.deepEqual(
    undocumented,
    [],
    `Undocumented operator env var(s) read by cloud-server/gateway but missing from docs/open-cowork-cloud.md:\n` +
      `${undocumented.join('\n')}\n\n` +
      `Add each to an env-var table in docs/open-cowork-cloud.md, or (only if it is a ` +
      `test-only / internal runtime-injection value) add it to the documented exclusion ` +
      `allowlist in this test with a reason.`,
  )
})

test('doc-coverage exclusion allowlist stays minimal and only lists vars actually read', () => {
  // Guard against the allowlist drifting into a dumping ground: every excluded var
  // must still appear in the scanned source (otherwise drop it), and the allowlist
  // must stay small.
  const files: string[] = []
  for (const dir of scannedSourceDirs) walk(dir, files)
  const corpus = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const name of internalInjectionExclusions) {
    assert.ok(
      corpus.includes(name),
      `Exclusion ${name} is no longer read by cloud-server/gateway source; remove it from the allowlist.`,
    )
  }
  assert.ok(
    internalInjectionExclusions.size <= 8,
    'internal-injection exclusion allowlist should stay small; re-justify before growing it.',
  )
})
