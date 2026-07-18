#!/usr/bin/env node
/**
 * Evidence and public-copy safety gate.
 *
 * Replaces the milestone-era per-document assertion list with two durable,
 * generic checks over every tracked Markdown/JSON document:
 *
 *   1. redaction: no secret-shaped text (tokens, credentials, bot tokens,
 *      private absolute paths, provider targets, session ids, phone numbers,
 *      webhook URLs) in anything we ship or export;
 *   2. claim safety: no unsupported positive release wording outside an
 *      explicit claim-boundary context.
 *
 * Run: node scripts/check-evidence-safety.mjs [--preset release] [--json]
 * The release preset scans README, docs, and evidence JSON. Extra files can
 * be passed as positional arguments (used by evidence-export tooling).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const extraFiles = argv.filter(arg => !arg.startsWith('--') && arg !== 'release')

const UNSAFE_TEXT_RULES = [
  { code: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i },
  { code: 'bot_token', pattern: /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/i },
  { code: 'private_path', pattern: /(?:^|[\s:="'`])(?:\/Users\/(?!you\b|example\b|jane\b|<)|\/home\/(?!node\b|nonroot\b|user\b|example\b|<)|\/private\/var\/|\/var\/folders\/)/ },
  { code: 'provider_target', pattern: /\b(?:telegram|whatsapp|discord):[A-Za-z0-9_.@+-]{5,}(?::[A-Za-z0-9_.@+-]{2,})?\b/i },
  { code: 'opencode_session_id', pattern: /\bses(?:[_-]|[0-9])[A-Za-z0-9-]{12,}\b/i },
  { code: 'webhook_url', pattern: /\bhttps?:\/\/(?!example\.|.*\bexample\b)[^\s"'`<>]*webhooks?\/[^\s"'`<>]+/i },
  { code: 'phone_number', pattern: /(?<![A-Za-z0-9_])\+\d[\d .()-]{8,}\d(?![A-Za-z0-9_])/ },
]

const UNSUPPORTED_CLAIM_RULES = [
  { code: 'production_ready', pattern: /\bproduction[-\s]+ready\b/i },
  { code: 'production_certified', pattern: /\bproduction\s+certified\b/i },
  { code: 'release_candidate_approved', pattern: /\brelease-candidate\s+approved\b/i },
  { code: 'hosted_team_ready', pattern: /\bhosted\/team[-\s]+ready\b/i },
  { code: 'saas_ready', pattern: /\bSaaS[-\s]+ready\b/i },
  { code: 'multi_tenant_ready', pattern: /\bmulti-tenant(?:\s+production)?[-\s]+ready\b/i },
  { code: 'universal_channel_ready', pattern: /\buniversal-channel[-\s]+ready\b/i },
  { code: 'arbitrary_scale_ready', pattern: /\barbitrary[-\s]scale(?:[-\s]+ready)?\b/i },
  { code: 'unattended_ready', pattern: /\bunattended\s+operation\s+(?:supported|ready)\b/i },
  { code: 'compliance_certified', pattern: /\bformal\s+compliance\s+certified\b/i },
]

// A line that states or negates the boundary is not an overclaim.
const CLAIM_BOUNDARY_CONTEXT =
  /\b(?:blocked|not|no|never|remain(?:s)?|forbidden|unsupported|without|until|deferred|waived|boundary|residual|non-goal|fixture|negative|fail[- ]closed|scope gate|criteria|do(?:es)? not)\b/i

function listFiles(relativeDir, extensions) {
  const absolute = path.join(root, relativeDir)
  if (!fs.existsSync(absolute)) return []
  const results = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (extensions.some(ext => entry.name.endsWith(ext))) results.push(path.relative(root, full))
    }
  }
  walk(absolute)
  return results
}

const files = new Set(['README.md', 'CHANGELOG.md', ...listFiles('docs', ['.md', '.json']), ...extraFiles])
const findings = []

for (const relative of files) {
  const absolute = path.isAbsolute(relative) ? relative : path.join(root, relative)
  if (!fs.existsSync(absolute)) {
    findings.push({ file: relative, line: 0, code: 'missing_file', excerpt: '' })
    continue
  }
  const text = fs.readFileSync(absolute, 'utf8')
  if (relative.endsWith('.json')) {
    try {
      JSON.parse(text)
    } catch (error) {
      findings.push({ file: relative, line: 0, code: 'json_parse', excerpt: String(error instanceof Error ? error.message : error).slice(0, 120) })
    }
  }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const rule of UNSAFE_TEXT_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ file: relative, line: index + 1, code: rule.code, excerpt: line.trim().slice(0, 120) })
      }
    }
    const claimContext = `${lines[index - 1] ?? ''}\n${line}`
    for (const rule of UNSUPPORTED_CLAIM_RULES) {
      if (relative === 'CHANGELOG.md') break
      if (rule.pattern.test(line) && !CLAIM_BOUNDARY_CONTEXT.test(claimContext)) {
        findings.push({ file: relative, line: index + 1, code: `claim:${rule.code}`, excerpt: line.trim().slice(0, 120) })
      }
    }
  }
}

const report = {
  status: findings.length === 0 ? 'pass' : 'fail',
  scannedFiles: files.size,
  findings,
}
if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  console.log(`evidence:safety ${report.status.toUpperCase()} (${files.size} files scanned)`)
  for (const finding of findings.slice(0, 50)) {
    console.error(`  FAIL ${finding.file}:${finding.line} [${finding.code}] ${finding.excerpt}`)
  }
  if (findings.length > 50) console.error(`  ... and ${findings.length - 50} more`)
}
if (findings.length > 0) process.exit(1)
