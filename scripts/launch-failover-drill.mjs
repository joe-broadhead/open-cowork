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
    } else if (arg === '--execute-hooks') {
      args.executeHooks = true
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--unredacted') {
      args.redacted = false
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/launch-failover-drill.mjs [--cloud-url url] [--gateway-url url] [--worker-hook command] [--scheduler-hook command] [--gateway-hook command] [--execute-hooks] [--output-dir dir]\n`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
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

function runHook(name, command, executeHooks, redacted, dryRun) {
  if (!command) return { name, status: dryRun ? 'skipped' : 'fail', reason: 'hook-not-configured' }
  if (dryRun) return { name, status: 'dry-run', command: 'configured-but-not-executed' }
  if (!executeHooks) return { name, status: 'fail', reason: 'hook-execution-not-enabled' }
  try {
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command]
    execFileSync(shell, shellArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    return { name, status: 'pass' }
  } catch (error) {
    return {
      name,
      status: 'fail',
      error: redactError(error, redacted),
    }
  }
}

const args = parseArgs(process.argv.slice(2))
const startedAt = new Date().toISOString()
const preflight = [
  await probe('cloud-health-before', args.cloudUrl, args.cloudToken, '/healthz', args.redacted, args.dryRun),
  await probe('gateway-ready-before', args.gatewayUrl, args.gatewayAdminToken, '/ready', args.redacted, args.dryRun),
]
const hooks = [
  runHook('worker-failover-hook', args.workerHook, args.executeHooks, args.redacted, args.dryRun),
  runHook('scheduler-failover-hook', args.schedulerHook, args.executeHooks, args.redacted, args.dryRun),
  runHook('gateway-failover-hook', args.gatewayHook, args.executeHooks, args.redacted, args.dryRun),
]
const postflight = [
  await probe('cloud-health-after', args.cloudUrl, args.cloudToken, '/healthz', args.redacted, args.dryRun),
  await probe('cloud-metrics-after', args.cloudUrl, args.cloudToken, '/api/metrics', args.redacted, args.dryRun),
  await probe('gateway-ready-after', args.gatewayUrl, args.gatewayAdminToken, '/ready', args.redacted, args.dryRun),
  await probe('gateway-metrics-after', args.gatewayUrl, args.gatewayAdminToken, '/metrics', args.redacted, args.dryRun),
]
const failed = [...preflight, ...hooks, ...postflight].filter((item) => item.status === 'fail')
const report = {
  schemaVersion: 1,
  purpose: 'open-cowork-launch-failover-drill-evidence',
  redacted: args.redacted,
  startedAt,
  finishedAt: new Date().toISOString(),
  result: failed.length === 0 ? (args.dryRun ? 'dry-run' : 'pass') : 'fail',
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
    'Production failover evidence requires configured Cloud/Gateway URLs, configured worker/scheduler/gateway hooks, and --execute-hooks or OPEN_COWORK_FAILOVER_EXECUTE_HOOKS=true.',
    'Use --dry-run only for local contract checks; dry-run output is not launch evidence.',
    'Store unredacted output in a private operations repository. Commit only redacted summaries or checksums to public artifacts.',
  ],
}

mkdirSync(args.outputDir, { recursive: true })
const outputPath = join(args.outputDir, `launch-failover-drill-${Date.now()}.json`)
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, outputPath, report }, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
