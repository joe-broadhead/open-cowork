#!/usr/bin/env node
/**
 * JOE-932: When a PR touches dual-stack channel security paths, require the
 * dual-channel checklist in the PR body to be filled (or an explicit exempt).
 *
 * Not a merge-required status on every PR — only activates for relevant diffs.
 *
 * Usage:
 *   node scripts/check-dual-channel-pr-checklist.mjs [--files path1,path2] [--body-file path]
 *
 * Env (CI):
 *   OPEN_COWORK_PR_BODY          — PR body markdown
 *   OPEN_COWORK_CHANGED_FILES    — newline- or comma-separated relative paths
 *   OPEN_COWORK_DUAL_CHANNEL_FORCE — set to "1" to force the gate on (tests)
 *
 * Exit 0 when gate inactive or checklist satisfied; exit 1 with guidance otherwise.
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const scriptLog = (...args) => {
  process.stdout.write(args.map(String).join(' ') + String.fromCharCode(10))
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string[]} argv */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { files: null, bodyFile: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--files' && argv[i + 1]) {
      out.files = argv[++i]
    } else if (a === '--body-file' && argv[i + 1]) {
      out.bodyFile = argv[++i]
    }
  }
  return out
}

/**
 * Paths that count as Durable Gateway channel surface.
 * @param {string} p
 */
export function isDurableChannelPath(p) {
  const n = p.replace(/\\/g, '/')
  return (
    n.startsWith('products/gateway/src/channels/')
    || n === 'products/gateway/src/channels'
  )
}

/**
 * Paths that count as monorepo provider / channel-gateway surface.
 * @param {string} p
 */
export function isMonorepoProviderPath(p) {
  const n = p.replace(/\\/g, '/')
  return (
    /^packages\/gateway-provider-[^/]+\//.test(n)
    || n.startsWith('packages/gateway-channel/')
    || n.startsWith('apps/channel-gateway/')
    || n.startsWith('apps/standalone-gateway/')
  )
}

/**
 * Shared channel security kernels / dual-stack guards.
 * @param {string} p
 */
export function isSharedChannelSecurityPath(p) {
  const n = p.replace(/\\/g, '/')
  return (
    n === 'packages/shared/src/node/channel-webhook-security.ts'
    || n === 'packages/shared/src/node/webhook-rate-limiter.ts'
    || n === 'scripts/check-dual-channel-security.mjs'
    || n === 'scripts/check-dual-channel-pr-checklist.mjs'
    || n === 'docs/product-channel-ownership.md'
    || n === '.github/pull_request_template.md'
  )
}

/**
 * @param {string[]} files
 * @returns {{ active: boolean, reason: string }}
 */
export function shouldRequireDualChannelChecklist(files) {
  if (process.env.OPEN_COWORK_DUAL_CHANNEL_FORCE === '1') {
    return { active: true, reason: 'OPEN_COWORK_DUAL_CHANNEL_FORCE=1' }
  }
  const normalized = files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
  const durable = normalized.some(isDurableChannelPath)
  const monorepo = normalized.some(isMonorepoProviderPath)
  const shared = normalized.some(isSharedChannelSecurityPath)

  if (shared) {
    return { active: true, reason: 'shared channel security / dual-stack docs or guards changed' }
  }
  if (durable && monorepo) {
    return { active: true, reason: 'both Durable channels and monorepo providers changed' }
  }
  // Single-stack security touch still benefits from checklist (N/A or single-stack note).
  if (durable || monorepo) {
    return {
      active: true,
      reason: durable
        ? 'Durable Gateway channel paths changed (confirm other stack N/A or reviewed)'
        : 'monorepo provider/channel paths changed (confirm other stack N/A or reviewed)',
    }
  }
  return { active: false, reason: 'no dual-stack channel security paths in diff' }
}

/**
 * Parse GitHub-style task list checkboxes (both `- [x]` and `* [X]`).
 * @param {string} body
 * @param {RegExp} linePattern — matched against the full checklist line text after the checkbox
 */
function isChecked(body, linePattern) {
  const lines = body.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/)
    if (!m) continue
    const checked = m[1].toLowerCase() === 'x'
    if (checked && linePattern.test(m[2])) return true
  }
  return false
}

/**
 * @param {string} body
 * @returns {{ ok: boolean, detail: string }}
 */
export function evaluateDualChannelChecklist(body) {
  const text = (body || '').trim()
  if (!text) {
    return {
      ok: false,
      detail: 'PR body is empty — fill Dual-channel security checklist in .github/pull_request_template.md',
    }
  }

  // Explicit exempt for intentional single-stack-only or non-security protocol work.
  if (
    /dual[- ]stack\s+checklist:\s*(exempt|n\/a|skip)/i.test(text)
    || /dual[- ]channel\s+checklist:\s*(exempt|n\/a|skip)/i.test(text)
  ) {
    return { ok: true, detail: 'explicit dual-stack checklist exempt in PR body' }
  }

  const na = isChecked(text, /^N\/A\b/i)
  if (na) {
    return { ok: true, detail: 'N/A — not a channel security/protocol change' }
  }

  const monorepo = isChecked(text, /Reviewed\s+\*\*monorepo providers\*\*/i)
    || isChecked(text, /Reviewed monorepo providers/i)
  const durable = isChecked(text, /Reviewed\s+\*\*Durable Gateway channels\*\*/i)
    || isChecked(text, /Reviewed Durable Gateway channels/i)
  const bothOrSingle = isChecked(text, /Both stacks fixed/i)
    || isChecked(text, /explicit single-stack ownership/i)
  const notesHasSingleStack = /single-stack|other stack\s+(n\/a|N\/A)|follow-up|ownership noted/i.test(text)

  if ((monorepo || durable) && (bothOrSingle || notesHasSingleStack || (monorepo && durable))) {
    return {
      ok: true,
      detail: monorepo && durable
        ? 'both stacks reviewed'
        : 'single-stack reviewed with ownership / follow-up signal',
    }
  }

  if (monorepo || durable || bothOrSingle) {
    return {
      ok: false,
      detail:
        'partial dual-channel checklist — check both stacks (or one stack + single-stack ownership note in Notes), or mark N/A',
    }
  }

  return {
    ok: false,
    detail:
      'dual-channel security paths changed but Dual-channel security checklist is unchecked. '
      + 'Tick N/A, complete the checklist, or add `Dual-stack checklist: exempt` with rationale. '
      + 'See docs/product-channel-ownership.md.',
  }
}

/**
 * @param {string | null} filesArg
 * @returns {string[]}
 */
export function resolveChangedFiles(filesArg) {
  if (filesArg) {
    return filesArg.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
  }
  const fromEnv = process.env.OPEN_COWORK_CHANGED_FILES
  if (fromEnv) {
    return fromEnv.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
  }
  // Local fallback: files changed vs merge-base with master (best-effort).
  try {
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/master'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    })
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * @param {string | null} bodyFile
 * @returns {string}
 */
export function resolvePrBody(bodyFile) {
  if (bodyFile) {
    return readFileSync(resolve(bodyFile), 'utf8')
  }
  if (typeof process.env.OPEN_COWORK_PR_BODY === 'string') {
    return process.env.OPEN_COWORK_PR_BODY
  }
  return ''
}

/**
 * @param {{ files?: string[] | null, body?: string | null, force?: boolean }} input
 */
export function runDualChannelPrChecklistCheck(input = {}) {
  const files = input.files ?? resolveChangedFiles(null)
  const body = input.body ?? resolvePrBody(null)
  const gate = shouldRequireDualChannelChecklist(files)
  if (!gate.active) {
    return { active: false, ok: true, reason: gate.reason, detail: 'gate inactive' }
  }
  const result = evaluateDualChannelChecklist(body)
  return {
    active: true,
    ok: result.ok,
    reason: gate.reason,
    detail: result.detail,
  }
}

function main() {
  const args = parseArgs()
  const files = resolveChangedFiles(args.files)
  const body = resolvePrBody(args.bodyFile)
  const result = runDualChannelPrChecklistCheck({ files, body })

  if (!result.active) {
    scriptLog(`Dual-channel PR checklist: skip (${result.reason})`)
    process.exit(0)
  }

  if (result.ok) {
    scriptLog(`Dual-channel PR checklist: OK — ${result.detail} [${result.reason}]`)
    process.exit(0)
  }

  console.error(`Dual-channel PR checklist: FAIL — ${result.detail}`)
  console.error(`  Trigger: ${result.reason}`)
  console.error('  Template: .github/pull_request_template.md → Dual-channel security checklist')
  console.error('  Docs: docs/product-channel-ownership.md')
  process.exit(1)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main()
}
