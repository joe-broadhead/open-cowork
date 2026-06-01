#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function parseArgs(argv) {
  const args = {
    outputDir: '.open-cowork-test/launch-failover',
    cloudUrl: process.env.OPEN_COWORK_CLOUD_URL || '',
    gatewayUrl: process.env.OPEN_COWORK_GATEWAY_URL || '',
    cloudToken: process.env.OPEN_COWORK_CLOUD_TOKEN || '',
    gatewayAdminToken: process.env.OPEN_COWORK_GATEWAY_ADMIN_TOKEN || '',
    workerHook: process.env.OPEN_COWORK_FAILOVER_WORKER_HOOK || '',
    schedulerHook: process.env.OPEN_COWORK_FAILOVER_SCHEDULER_HOOK || '',
    gatewayHook: process.env.OPEN_COWORK_FAILOVER_GATEWAY_HOOK || '',
    commitSha: process.env.OPEN_COWORK_EVIDENCE_COMMIT_SHA || '',
    cloudImageDigest: process.env.OPEN_COWORK_EVIDENCE_CLOUD_IMAGE_DIGEST || '',
    gatewayImageDigest: process.env.OPEN_COWORK_EVIDENCE_GATEWAY_IMAGE_DIGEST || '',
    executeHooks: process.env.OPEN_COWORK_FAILOVER_EXECUTE_HOOKS === 'true',
    dryRun: process.env.OPEN_COWORK_FAILOVER_DRY_RUN === 'true',
    redacted: process.env.OPEN_COWORK_REDACT_OUTPUT !== 'false',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      continue
    } else if (arg === '--output-dir') {
      args.outputDir = argv[index + 1]
      index += 1
    } else if (arg === '--cloud-url') {
      args.cloudUrl = argv[index + 1]
      index += 1
    } else if (arg === '--gateway-url') {
      args.gatewayUrl = argv[index + 1]
      index += 1
    } else if (arg === '--cloud-token') {
      args.cloudToken = argv[index + 1]
      index += 1
    } else if (arg === '--gateway-admin-token') {
      args.gatewayAdminToken = argv[index + 1]
      index += 1
    } else if (arg === '--worker-hook') {
      args.workerHook = argv[index + 1]
      index += 1
    } else if (arg === '--scheduler-hook') {
      args.schedulerHook = argv[index + 1]
      index += 1
    } else if (arg === '--gateway-hook') {
      args.gatewayHook = argv[index + 1]
      index += 1
    } else if (arg === '--commit-sha') {
      args.commitSha = argv[index + 1]
      index += 1
    } else if (arg === '--cloud-image-digest') {
      args.cloudImageDigest = argv[index + 1]
      index += 1
    } else if (arg === '--gateway-image-digest') {
      args.gatewayImageDigest = argv[index + 1]
      index += 1
    } else if (arg === '--execute-hooks') {
      args.executeHooks = true
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--unredacted') {
      args.redacted = false
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/launch-failover-drill.mjs [--cloud-url url] [--gateway-url url] [--worker-hook evidence] [--scheduler-hook evidence] [--gateway-hook evidence] [--execute-hooks] [--output-dir dir]\n`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function currentCommitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

const PRIVATE_EVIDENCE_PATTERNS = [
  /(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /ya29\.[A-Za-z0-9_-]{8,}/i,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /(?:postgres(?:ql)?|mysql|mongodb):\/\//i,
  /bearer\s+[A-Za-z0-9._-]{8,}/i,
  /(?:token|secret|password|api[_-]?key)=/i,
]

function safeEvidenceText(value, fallback = 'not-provided') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return fallback
  if (PRIVATE_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'redacted-private-value'
  }
  return text.replace(/\s+/g, ' ').slice(0, 512)
}

function redactedUrl(url, redacted) {
  if (!url) return ''
  if (!redacted) return url
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//REDACTED_HOST`
  } catch {
    return 'REDACTED_URL'
  }
}

function redactError(error, redacted) {
  if (!redacted) return error instanceof Error ? error.message : String(error)
  return 'redacted-error'
}

async function probe(name, url, token, path, redacted, dryRun) {
  if (!url) return { name, status: dryRun ? 'skipped' : 'fail', reason: 'url-not-configured' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const headers = token ? { authorization: `Bearer ${token}` } : {}
    const response = await fetch(new URL(path, url), {
      headers,
      signal: controller.signal,
    })
    return { name, status: response.ok ? 'pass' : 'fail', httpStatus: response.status }
  } catch (error) {
    return { name, status: 'fail', error: redactError(error, redacted) }
  } finally {
    clearTimeout(timeout)
  }
}

function runHook(name, evidence, executeHooks, dryRun) {
  if (!evidence) return { name, status: dryRun ? 'skipped' : 'fail', reason: 'hook-not-configured' }
  const evidenceSummary = safeEvidenceText(evidence)
  if (dryRun) return { name, status: 'dry-run', evidence: evidenceSummary, reason: 'configured-but-not-confirmed' }
  if (!executeHooks) {
    return { name, status: 'fail', evidence: evidenceSummary, reason: 'operator-hook-evidence-not-confirmed' }
  }
  return { name, status: 'pass', evidence: evidenceSummary, reason: 'operator-confirmed-private-hook-evidence' }
}

const args = parseArgs(process.argv.slice(2))
const startedMs = Date.now()
const startedAt = new Date().toISOString()
const preflight = [
  await probe('cloud-health-before', args.cloudUrl, args.cloudToken, '/healthz', args.redacted, args.dryRun),
  await probe('gateway-ready-before', args.gatewayUrl, args.gatewayAdminToken, '/ready', args.redacted, args.dryRun),
]
const hooks = [
  runHook('worker-failover-hook', args.workerHook, args.executeHooks, args.dryRun),
  runHook('scheduler-failover-hook', args.schedulerHook, args.executeHooks, args.dryRun),
  runHook('gateway-failover-hook', args.gatewayHook, args.executeHooks, args.dryRun),
]
const postflight = [
  await probe('cloud-health-after', args.cloudUrl, args.cloudToken, '/healthz', args.redacted, args.dryRun),
  await probe('cloud-metrics-after', args.cloudUrl, args.cloudToken, '/api/metrics', args.redacted, args.dryRun),
  await probe('gateway-ready-after', args.gatewayUrl, args.gatewayAdminToken, '/ready', args.redacted, args.dryRun),
  await probe('gateway-metrics-after', args.gatewayUrl, args.gatewayAdminToken, '/metrics', args.redacted, args.dryRun),
]
const failed = [...preflight, ...hooks, ...postflight].filter((item) => item.status === 'fail')
const result = failed.length === 0 ? (args.dryRun ? 'dry-run' : 'pass') : 'fail'
const finishedAt = new Date().toISOString()
const durationMs = Date.now() - startedMs
const report = {
  schemaVersion: 1,
  purpose: 'open-cowork-launch-failover-drill-evidence',
  redacted: args.redacted,
  startedAt,
  finishedAt,
  durationMs,
  result,
  evidence: {
    command: args.dryRun ? 'pnpm deploy:failover:drill:dry-run' : 'pnpm deploy:failover:drill',
    commitSha: safeEvidenceText(args.commitSha || currentCommitSha(), 'unknown'),
    startedAt,
    finishedAt,
    durationMs,
    status: result,
    imageDigests: {
      cloud: safeEvidenceText(args.cloudImageDigest),
      gateway: safeEvidenceText(args.gatewayImageDigest),
    },
    environmentProfile: {
      cloudUrl: redactedUrl(args.cloudUrl, args.redacted),
      gatewayUrl: redactedUrl(args.gatewayUrl, args.redacted),
      cloudTokenProvided: Boolean(args.cloudToken),
      gatewayAdminTokenProvided: Boolean(args.gatewayAdminToken),
      workerHookConfigured: Boolean(args.workerHook),
      schedulerHookConfigured: Boolean(args.schedulerHook),
      gatewayHookConfigured: Boolean(args.gatewayHook),
      executeHooks: args.executeHooks,
      dryRun: args.dryRun,
    },
  },
  executeHooks: args.executeHooks,
  dryRun: args.dryRun,
  targets: {
    cloudUrl: redactedUrl(args.cloudUrl, args.redacted),
    gatewayUrl: redactedUrl(args.gatewayUrl, args.redacted),
  },
  evidenceItems: [
    'workerFailover',
    'schedulerReplicaFailover',
    'gatewayDeliveryReplayDeadLetter',
  ],
  preflight,
  hooks,
  postflight,
  notes: [
    'Production failover evidence requires configured Cloud/Gateway URLs, private worker/scheduler/gateway operator hook evidence, and --execute-hooks or OPEN_COWORK_FAILOVER_EXECUTE_HOOKS=true to confirm that the private hooks were executed outside this public script.',
    'Use --dry-run only for local contract checks; dry-run output is not launch evidence.',
    'Store unredacted output in a private operations repository. Commit only redacted summaries or checksums to public artifacts.',
  ],
}

mkdirSync(args.outputDir, { recursive: true })
const outputPath = join(args.outputDir, `launch-failover-drill-${Date.now()}.json`)
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, outputPath, report }, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
