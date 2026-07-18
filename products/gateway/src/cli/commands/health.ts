import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { z } from 'zod'
import { getConfig } from '../../config.js'
import { redactSecret } from '../../security.js'
import { LAUNCHD_SERVICE_LABEL as LAUNCHD_LABEL } from '../../service-manager.js'
import { formatTaskCounts } from '../../task-summary.js'
import { buildOfflineServiceHealthReport, type ServiceHealthReport } from '../../service-health.js'
import {
  GatewayHttpError,
  assertConfigured,
  cliUsageError,
  formatServiceHealthText,
  gatewayFetch,
  hasArg,
  isGatewayTransportError,
  normalizeServiceHealthReport,
} from '../shared.js'

const zReadinessSuccessResponse = z.object({
  state: z.enum(['ready', 'degraded', 'not_ready']),
  summary: z.string().min(1),
  generatedAt: z.string().min(1),
  version: z.string().min(1),
  mode: z.enum(['local_personal', 'local_plus_channel', 'tunneled_webhook', 'unsupported']),
  checks: z.array(z.object({
    name: z.string().min(1),
    status: z.enum(['pass', 'warn', 'fail']),
    severity: z.enum(['info', 'warning', 'critical']),
    summary: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  })),
  queue: z.record(z.string(), z.number()),
  scheduler: z.record(z.string(), z.unknown()),
  storage: z.record(z.string(), z.unknown()),
  requests: z.object({ questions: z.number().int().nonnegative(), permissions: z.number().int().nonnegative() }),
  sessions: z.record(z.string(), z.number()),
}).passthrough()

export async function health() {
  if (!validBooleanFlags(process.argv.slice(3), new Set(['--json']))) {
    cliUsageError('Usage: opencode-gateway health [--json]')
    return
  }
  assertConfigured('health')
  const config = getConfig()
  let report: ServiceHealthReport
  try {
    const res = await gatewayFetch('/gateway/health')
    const payload = await res.json().catch(() => ({})) as any
    if (!res.ok) throw new GatewayHttpError(res.status, payload, payload?.error || `HTTP ${res.status}`)
    report = normalizeServiceHealthReport(payload)
  } catch (err: any) {
    if (!isGatewayTransportError(err)) throw err
    report = buildOfflineServiceHealthReport({ reason: `Gateway daemon is unreachable: ${err?.message || err}`, config })
  }
  if (hasArg('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(formatServiceHealthText(report))
  process.exit(report.status === 'ok' ? 0 : 1)
}

export async function readiness() {
  if (!validBooleanFlags(process.argv.slice(3), new Set(['--json', '--strict']))) {
    cliUsageError('Usage: opencode-gateway readiness [--json] [--strict]')
    return
  }
  assertConfigured('readiness')
  try {
    const res = await gatewayFetch('/readiness')
    let data = await res.json().catch(() => ({})) as any
    const expectedNotReady = res.status === 503 && data?.state === 'not_ready'
    if (!res.ok && !expectedNotReady) throw new GatewayHttpError(res.status, data, data?.error || `HTTP ${res.status}`)
    if (res.ok) {
      const validated = zReadinessSuccessResponse.safeParse(data)
      if (!validated.success) {
        const issue = validated.error.issues[0]
        const field = issue?.path.length ? issue.path.join('.') : 'response'
        printReadinessFailure(`Gateway returned an invalid readiness response (${field}: ${issue?.message || 'schema validation failed'}).`)
        return
      }
      data = validated.data
    }
    if (hasArg('--json')) {
      console.log(JSON.stringify(data, null, 2))
    } else {
      const { formatReadinessText } = await import('../../readiness.js')
      console.log(formatReadinessText(data))
    }
    if (data.state === 'not_ready' || (hasArg('--strict') && data.state !== 'ready')) process.exit(1)
  } catch (err: any) {
    if (!isGatewayTransportError(err)) throw err
    if (hasArg('--json')) {
      console.log(JSON.stringify({ state: 'not_ready', summary: `Gateway daemon unreachable: ${err?.message || err}`, checks: [] }, null, 2))
      process.exit(1)
    }
    console.log(`Readiness: not_ready`)
    console.log(`Summary: Gateway daemon unreachable: ${err?.message || err}`)
    process.exit(1)
  }
}

function printReadinessFailure(summary: string): void {
  if (hasArg('--json')) {
    console.log(JSON.stringify({ state: 'not_ready', summary, checks: [] }, null, 2))
  } else {
    console.log('Readiness: not_ready')
    console.log(`Summary: ${summary}`)
  }
  process.exit(1)
}

export async function doctor() {
  if (process.argv.slice(3).length) {
    cliUsageError('Usage: opencode-gateway doctor')
    return
  }
  assertConfigured('doctor')
  console.log('🔍 OpenCode Gateway — Diagnostic Report')
  console.log('=======================================')
  console.log()

  // Check config
  const config = getConfig()
  console.log(`Config: ${config.opencodeUrl} → HTTP :${config.httpPort}`)
  console.log(`Heartbeat: ${config.heartbeat.intervalMs}ms`)
  console.log(`Scheduler: ${config.scheduler.enabled ? 'enabled' : 'disabled'} (${config.scheduler.maxConcurrent} max, ${config.scheduler.defaultPipeline.join('→')})`)
  const plannerProfile = config.profiles['planner']
  console.log(`Planning model: ${plannerProfile ? `${plannerProfile.model.providerID}/${plannerProfile.model.modelID}` : 'unknown'}`)
  console.log(`Agent: ${config.profiles['implementer']?.agent ?? 'unknown'}`)
  console.log(`Security: HTTP host ${config.security.httpHost} (${config.security.allowNonLocalHttp ? 'non-local allowed' : 'local only'}), OpenCode-native permissions`)
  console.log(`Telegram token: ${redactSecret(process.env['TELEGRAM_BOT_TOKEN'] || config.channels.telegram.botToken)}`)
  console.log(`WhatsApp token: ${redactSecret(process.env['WHATSAPP_ACCESS_TOKEN'] || config.channels.whatsapp?.accessToken)}`)
  const { detectGatewayProfileDrift, formatProfileDrift } = await import('../../profile-drift.js')
  const profileDrift = detectGatewayProfileDrift(config)
  console.log(`Gateway profiles: ${profileDrift.length ? 'stale/missing' : 'current'}`)
  if (profileDrift.length) console.log(formatProfileDrift(profileDrift))
  const { buildLocalReadinessCatalog } = await import('../../agent-catalog.js')
  const localReadiness = buildLocalReadinessCatalog({ config })
  const blockedReadiness = localReadiness.entries.filter(entry => entry.status === 'blocked')
  const attentionReadiness = localReadiness.entries.filter(entry => entry.status === 'partial' || entry.status === 'unknown')
  console.log(`Local readiness catalog: ${blockedReadiness.length ? 'blocked' : attentionReadiness.length ? 'attention' : 'ready'} (${Object.entries(localReadiness.totals).map(([status, count]) => `${status}:${count}`).join(', ')})`)
  for (const entry of [...blockedReadiness, ...attentionReadiness].slice(0, 5)) {
    console.log(`- ${entry.id}: ${entry.statusCode} — ${entry.remediation || entry.summary}`)
  }
  console.log()

  // Check daemon health
  try {
    const res = await gatewayFetch('/health')
    if (res.ok) {
      const d = await res.json() as any
      console.log(`Daemon: running (uptime: ${Math.floor((d.uptime || 0)/60)}m)`)
    }
  } catch {
    console.log('Daemon: not running ✗  Fix: run `opencode-gateway start`.')
  }
  console.log()

  // Reuse the guided first-run preflight so misconfiguration surfaces the exact
  // fix here, before the first task is ever created. The preflight's OpenCode
  // probe is bounded (5s AbortSignal), so it doubles as the OpenCode reachability
  // check below — no separate, unbounded fetch that a hung OpenCode could stall.
  const { runQuickstartPreflight } = await import('../../quickstart.js')
  const preflight = await runQuickstartPreflight({ config })

  // Check opencode server (reuse the bounded preflight probe result).
  const opencodeCheck = preflight.checks.find(check => check.id === 'opencode')
  if (opencodeCheck?.ok) {
    console.log(`OpenCode server: ${opencodeCheck.detail}`)
  } else {
    console.log(`OpenCode server: unreachable ✗ (${opencodeCheck?.detail ?? 'no probe'})  Fix: ${opencodeCheck?.fix ?? 'start OpenCode (opencode serve) or fix opencodeUrl via `opencode-gateway setup`.'}`)
  }
  console.log()

  console.log(`Quickstart preflight: ${preflight.ok ? 'ready' : 'action needed'}`)
  for (const check of preflight.checks.filter(row => !row.ok)) {
    console.log(`- ${check.title}: ${check.detail}`)
    if (check.fix) console.log(`  Fix: ${check.fix}`)
  }
  console.log()

  const snapshot = await gatewayFetch('/tasks').then(res => res.ok ? res.json() : null).catch(() => null) as any
  if (snapshot?.counts) console.log(`Issue queue: ${formatTaskCounts(snapshot.counts).replace(/ \| /g, ', ')}`)
  else console.log('Issue queue: unavailable')
  console.log()

  // Check launchd
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
  if (fs.existsSync(plistPath)) {
    console.log('LaunchAgent: service file installed')
  } else {
    console.log('LaunchAgent: not installed (run "opencode-gateway install")')
  }
  console.log()
}

function validBooleanFlags(args: string[], allowed: Set<string>): boolean {
  return args.every(arg => allowed.has(arg)) && new Set(args).size === args.length
}
