import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getConfig, getConfigDir, type GatewayConfig } from './config.js'
import { planInitiative, workStatePath, type PlanInitiativeResult } from './work-store.js'
import { ensureLocalHttpAdminTokenFile } from './security.js'

/**
 * Guided first-run ("quickstart"): take a fresh operator from a validated
 * install to a REAL initiative, a REAL agent dispatch, and a VISIBLE result on
 * the dashboard — with narration at every step and near-zero configuration.
 *
 * The core (`runQuickstart`) is transport-agnostic: it talks to the daemon only
 * through the injected {@link QuickstartGateway} port and narrates through the
 * injected {@link QuickstartNarrator}. The CLI wires an HTTP gateway plus a
 * console narrator; the end-to-end test wires a real in-process daemon (faked
 * OpenCode) and a capturing narrator, so the same flow is driven deterministically.
 *
 * It reuses existing business logic rather than re-implementing it:
 * `planInitiative()` (atomic roadmap+task creation) for step c, the daemon's
 * `dispatch_now` scheduler cycle for step d/e, and the run/task getters for the
 * result surface.
 */

// -- Preflight -------------------------------------------------------------

export interface PreflightCheck {
  id: string
  ok: boolean
  title: string
  detail: string
  /** Actionable fix, present when the check failed. */
  fix?: string
}

export interface PreflightReport {
  ok: boolean
  checks: PreflightCheck[]
}

/** Result of probing the configured OpenCode server. Injectable for tests. */
export interface OpencodeProbeResult {
  ok: boolean
  version?: string
  detail?: string
}

export type OpencodeProbe = (config: GatewayConfig) => Promise<OpencodeProbeResult>

export interface QuickstartPreflightOptions {
  config?: GatewayConfig
  /** Override the OpenCode reachability probe (defaults to an HTTP health check). */
  probeOpencode?: OpencodeProbe
}

/** Keep in sync with bin/preflight.mjs, package.json engines, and cli-setup.ts. */
export function isSupportedNodeVersion(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major > 23
}

/** Default OpenCode reachability probe: GET <opencodeUrl>/global/health. */
async function probeOpencodeHealth(config: GatewayConfig): Promise<OpencodeProbeResult> {
  try {
    const res = await fetch(`${config.opencodeUrl}/global/health`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const body = await res.json().catch(() => ({})) as { version?: string }
    return { ok: true, version: body.version }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

function checkNode(): PreflightCheck {
  const ok = isSupportedNodeVersion()
  return {
    id: 'node',
    ok,
    title: 'Node.js runtime',
    detail: ok ? `v${process.versions.node} supported` : `v${process.versions.node} is unsupported`,
    fix: ok ? undefined : 'Install Node.js >=22.13 <23 or >=23.4 (nvm install 22.13), then re-run.',
  }
}

function checkNodeSqlite(): PreflightCheck {
  try {
    const db = new DatabaseSync(':memory:')
    db.close()
    return { id: 'node-sqlite', ok: true, title: 'node:sqlite', detail: 'built-in SQLite is loadable' }
  } catch (err) {
    return {
      id: 'node-sqlite',
      ok: false,
      title: 'node:sqlite',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Use a Node.js build with the built-in node:sqlite module (>=22.5). Reinstall Node from nodejs.org if it is missing.',
    }
  }
}

function checkConfigDirWritable(): PreflightCheck {
  const dir = getConfigDir()
  try {
    // Side-effect-free probe: `doctor` runs this preflight and must NOT create
    // the config dir. When it exists, verify write access directly; otherwise
    // verify the nearest existing ancestor is writable so the actual quickstart
    // flow (never doctor) can create it later.
    if (fs.existsSync(dir)) {
      fs.accessSync(dir, fs.constants.W_OK)
      return { id: 'config-dir', ok: true, title: 'Config directory', detail: `${dir} is writable` }
    }
    let ancestor = path.dirname(dir)
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor)
    fs.accessSync(ancestor, fs.constants.W_OK)
    return { id: 'config-dir', ok: true, title: 'Config directory', detail: `${dir} can be created (${ancestor} is writable)` }
  } catch (err) {
    return {
      id: 'config-dir',
      ok: false,
      title: 'Config directory',
      detail: `${dir}: ${err instanceof Error ? err.message : String(err)}`,
      fix: `Ensure ${dir} exists and is owned by you (mkdir -p "${dir}" && chown -R "$(whoami)" "${dir}").`,
    }
  }
}

function checkConfig(config?: GatewayConfig): { check: PreflightCheck; config?: GatewayConfig } {
  try {
    const resolved = config ?? getConfig()
    return { config: resolved, check: { id: 'config', ok: true, title: 'Gateway config', detail: 'config is present and valid' } }
  } catch (err) {
    return {
      check: {
        id: 'config',
        ok: false,
        title: 'Gateway config',
        detail: err instanceof Error ? err.message : String(err),
        fix: 'Run `opencode-gateway setup` to create a valid config before the first task.',
      },
    }
  }
}

function checkAgentProfile(config: GatewayConfig): PreflightCheck {
  // A "usable agent/profile" means the implement stage can resolve a profile
  // with a concrete model. The implementer profile drives the default pipeline;
  // without a provider/model the first dispatch cannot run.
  const profile = config.profiles['implementer']
  const model = profile?.model
  const ok = !!(profile?.agent && model?.providerID && model?.modelID)
  return {
    id: 'agent-profile',
    ok,
    title: 'Usable agent profile',
    detail: ok
      ? `implementer -> ${profile!.agent} (${model!.providerID}/${model!.modelID})`
      : 'the implementer profile is missing an agent or model',
    fix: ok ? undefined : 'Run `opencode-gateway setup --wizard` and set the implementer model (provider/model).',
  }
}

function opencodeCheck(config: GatewayConfig, probe: OpencodeProbeResult): PreflightCheck {
  return {
    id: 'opencode',
    ok: probe.ok,
    title: 'OpenCode server',
    detail: probe.ok
      ? `reachable at ${config.opencodeUrl}${probe.version ? ` (v${probe.version})` : ''}`
      : `unreachable at ${config.opencodeUrl}${probe.detail ? ` (${probe.detail})` : ''}`,
    fix: probe.ok ? undefined : `Start OpenCode (opencode serve) or fix opencodeUrl via \`opencode-gateway setup\`, then confirm ${config.opencodeUrl}/global/health responds.`,
  }
}

/**
 * Run the guided first-run preflight: Node version, node:sqlite, config-dir
 * writability, config validity, a usable agent/profile, and OpenCode
 * reachability. Every failure carries an actionable `fix` so misconfiguration is
 * caught with a concrete remedy BEFORE any work is created.
 */
export async function runQuickstartPreflight(options: QuickstartPreflightOptions = {}): Promise<PreflightReport> {
  const checks: PreflightCheck[] = []
  checks.push(checkNode())
  checks.push(checkNodeSqlite())
  checks.push(checkConfigDirWritable())
  const configResult = checkConfig(options.config)
  checks.push(configResult.check)
  if (configResult.config) {
    const config = configResult.config
    checks.push(checkAgentProfile(config))
    const probe = await (options.probeOpencode || probeOpencodeHealth)(config)
    checks.push(opencodeCheck(config, probe))
  }
  return { ok: checks.every(check => check.ok), checks }
}

// -- Narration -------------------------------------------------------------

export interface QuickstartNarrator {
  step(message: string): void
  detail(message: string): void
  success(message: string): void
  warn(message: string): void
}

const SILENT_NARRATOR: QuickstartNarrator = { step() {}, detail() {}, success() {}, warn() {} }

// -- Gateway port ----------------------------------------------------------

export interface QuickstartDispatchResult {
  schedulerPaused?: boolean
  dispatchedTotal?: number
  requestedDispatched?: boolean
  guidance?: string
  counts?: Record<string, number>
}

export interface QuickstartRunView {
  id: string
  status: string
  stage?: string
  costUsd?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
  result?: { status?: string; summary?: string; artifacts?: string[] }
}

export interface QuickstartTaskView {
  id: string
  status: string
  currentStage?: string
  activeRun?: QuickstartRunView
  lastRun?: QuickstartRunView
}

/** Minimal daemon surface the quickstart flow needs. Injected for testability. */
export interface QuickstartGateway {
  getHealth(): Promise<{ ok: boolean; uptimeSeconds?: number } | null>
  dispatchNow(input: { taskId: string }): Promise<QuickstartDispatchResult>
  getTask(taskId: string): Promise<QuickstartTaskView | null>
  /**
   * Confirm the caller is authorized for WRITE calls BEFORE any work is created.
   * Under `capabilityScopedLoopback`, loopback reads are token-free but writes
   * are not, so a running daemon started without the admin token would 403 the
   * dispatch and orphan the created work. Return `{ ok: false }` when a write is
   * rejected (403). Optional; when omitted the check is skipped.
   */
  checkWriteAccess?(): Promise<{ ok: boolean; status?: number; detail?: string }>
}

// -- Core flow -------------------------------------------------------------

export interface QuickstartOptions {
  gateway: QuickstartGateway
  narrator?: QuickstartNarrator
  config?: GatewayConfig
  probeOpencode?: OpencodeProbe
  /** Title for the starter initiative. */
  title?: string
  /** Title for the starter task. */
  taskTitle?: string
  /** Description/prompt for the starter task. */
  taskDescription?: string
  /**
   * Called when the daemon is not running, to guide/start it. Return true if the
   * daemon is running afterwards. When omitted, a stopped daemon ends the flow
   * with an actionable message.
   */
  ensureDaemon?: () => Promise<boolean>
  pollIntervalMs?: number
  timeoutMs?: number
  /** Work-store path override (tests). */
  stateFilePath?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type QuickstartOutcome = 'completed' | 'failed' | 'timeout' | 'preflight_failed' | 'daemon_not_running' | 'scheduler_paused' | 'write_forbidden' | 'dispatch_failed'

export interface QuickstartResult {
  ok: boolean
  outcome: QuickstartOutcome
  preflight: PreflightReport
  roadmapId?: string
  taskId?: string
  runId?: string
  runStatus?: string
  taskStatus?: string
  summary?: string
  costUsd?: number
  dashboardUrl?: string
  runUrl?: string
  taskUrl?: string
  nextSteps: string[]
  failureReason?: string
}

const DEFAULT_QUICKSTART_TITLE = 'Quickstart: summarize this repository'
const DEFAULT_QUICKSTART_TASK_TITLE = 'Summarize the current repository'
const DEFAULT_QUICKSTART_TASK_DESCRIPTION =
  'Read the repository at the working directory and produce a concise plain-language summary: what the project is, its main components, how it is built and tested, and two concrete suggestions for a first improvement. Return the summary as your stage result.'

function dashboardBase(config: GatewayConfig): string {
  return `http://127.0.0.1:${config.httpPort}`
}

function quickstartDashboardUrl(config: GatewayConfig): string {
  return `${dashboardBase(config)}/dashboard#/overview`
}

function quickstartRunUrl(config: GatewayConfig, runId: string): string {
  return `${dashboardBase(config)}/dashboard?view=run&id=${encodeURIComponent(runId)}`
}

function quickstartTaskUrl(config: GatewayConfig, taskId: string): string {
  return `${dashboardBase(config)}/dashboard?view=task&id=${encodeURIComponent(taskId)}`
}

const TERMINAL_TASK_STATUSES = new Set(['done', 'blocked'])
const TERMINAL_RUN_STATUSES = new Set(['passed', 'failed', 'blocked'])

function isTerminalTask(view: QuickstartTaskView | null): boolean {
  if (!view) return false
  if (TERMINAL_TASK_STATUSES.has(view.status)) return true
  const run = view.lastRun
  return !!(run && TERMINAL_RUN_STATUSES.has(run.status))
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Drive the guided first-run end to end. Narrates each step and returns a
 * structured result (initiative/task/run ids, dashboard drill-down links, and
 * next steps). Never creates work when preflight fails or the daemon is down.
 */
export async function runQuickstart(options: QuickstartOptions): Promise<QuickstartResult> {
  const narrator = options.narrator ?? SILENT_NARRATOR
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  // NaN-safe floors: a non-finite override (e.g. Number('abc')) must fall back to
  // the default rather than poison the deadline (Math.max(1000, NaN) === NaN),
  // which would make the poll loop never run and report a spurious instant timeout.
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? Math.max(50, options.pollIntervalMs!) : 1500
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs!) : 180_000

  // Step 1/6 — Preflight. Stop BEFORE creating any work on failure.
  narrator.step('Step 1/6  Preflight checks')
  const preflight = await runQuickstartPreflight({ config: options.config, probeOpencode: options.probeOpencode })
  for (const check of preflight.checks) {
    if (check.ok) narrator.detail(`  ok   ${check.title}: ${check.detail}`)
    else {
      narrator.warn(`  FAIL ${check.title}: ${check.detail}`)
      if (check.fix) narrator.warn(`       Fix: ${check.fix}`)
    }
  }
  const config = options.config ?? getConfig()
  const base: Pick<QuickstartResult, 'nextSteps' | 'dashboardUrl'> = {
    nextSteps: [],
    dashboardUrl: quickstartDashboardUrl(config),
  }
  if (!preflight.ok) {
    narrator.warn('Preflight failed. Resolve the fixes above, then re-run `opencode-gateway quickstart`. No work was created.')
    return {
      ok: false,
      outcome: 'preflight_failed',
      preflight,
      failureReason: 'One or more preflight checks failed.',
      nextSteps: preflight.checks.filter(check => !check.ok && check.fix).map(check => check.fix!),
      dashboardUrl: base.dashboardUrl,
    }
  }
  narrator.success('Preflight passed.')

  // Provision the local admin bearer token so authenticated loopback WRITE calls
  // (dispatch, task creation) succeed under the hardened `capabilityScopedLoopback`
  // default. Benign + idempotent; the secret value is never narrated.
  try { ensureLocalHttpAdminTokenFile() } catch {}

  // Step 2/6 — Ensure the daemon so the scheduler can dispatch.
  narrator.step('Step 2/6  Gateway daemon')
  let health = await options.gateway.getHealth().catch(() => null)
  if (!health?.ok && options.ensureDaemon) {
    narrator.detail('  Daemon is not running; starting it...')
    const started = await options.ensureDaemon().catch(() => false)
    if (started) health = await options.gateway.getHealth().catch(() => null)
  }
  if (!health?.ok) {
    narrator.warn('  Gateway daemon is not running. Start it with `opencode-gateway start`, then re-run `opencode-gateway quickstart`. No work was created.')
    return {
      ok: false,
      outcome: 'daemon_not_running',
      preflight,
      failureReason: 'Gateway daemon is not running.',
      nextSteps: ['opencode-gateway start', 'opencode-gateway quickstart'],
      dashboardUrl: base.dashboardUrl,
    }
  }
  narrator.detail(`  ok   Daemon is running${typeof health.uptimeSeconds === 'number' ? ` (uptime ${Math.max(0, Math.floor(health.uptimeSeconds / 60))}m)` : ''}.`)

  // Confirm WRITE authorization BEFORE creating any work. A pre-existing daemon
  // started without the admin token (under `capabilityScopedLoopback`) accepts
  // loopback reads but 403s writes, so detecting it here prevents creating a
  // durable roadmap+task that could never be dispatched.
  if (options.gateway.checkWriteAccess) {
    const writeAccess = await options.gateway.checkWriteAccess().catch(() => ({ ok: true as const }))
    if (!writeAccess.ok) {
      narrator.warn('  The running gateway daemon rejected an authenticated write (security.capabilityScopedLoopback is enabled and the daemon has no admin token).')
      narrator.warn('  Restart it so it picks up the local admin token: `opencode-gateway stop && opencode-gateway start` (or `opencode-gateway install`). No work was created.')
      return {
        ok: false,
        outcome: 'write_forbidden',
        preflight,
        failureReason: 'The gateway daemon rejected an authenticated write (403); it was started without the local admin token.',
        nextSteps: ['opencode-gateway stop', 'opencode-gateway start', 'opencode-gateway quickstart'],
        dashboardUrl: base.dashboardUrl,
      }
    }
  }

  // Step 3/6 — Create a REAL initiative + first task (atomic) via planInitiative.
  narrator.step('Step 3/6  Creating your first initiative')
  const title = options.title || DEFAULT_QUICKSTART_TITLE
  const taskTitle = options.taskTitle || DEFAULT_QUICKSTART_TASK_TITLE
  const taskDescription = options.taskDescription || DEFAULT_QUICKSTART_TASK_DESCRIPTION
  let plan: PlanInitiativeResult
  try {
    plan = planInitiative({
      title,
      priority: 'MEDIUM',
      tasks: [{ title: taskTitle, description: taskDescription, priority: 'MEDIUM', pipeline: ['implement'] }],
    }, options.stateFilePath ?? workStatePath())
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    narrator.warn(`  Could not create the initiative: ${reason}`)
    return { ok: false, outcome: 'failed', preflight, failureReason: reason, nextSteps: ['opencode-gateway doctor'], dashboardUrl: base.dashboardUrl }
  }
  const task = plan.tasks[0]!
  narrator.detail(`  ok   Initiative ${plan.roadmap.id}: "${plan.roadmap.title}"`)
  narrator.detail(`  ok   Task ${task.id}: "${task.title}"`)

  // Step 4/6 — Dispatch it (reuse the daemon dispatch_now scheduler cycle).
  narrator.step('Step 4/6  Dispatching to an agent')
  const taskUrl = quickstartTaskUrl(config, task.id)
  let dispatch: QuickstartDispatchResult
  try {
    // `dispatchNow` throws on non-2xx (production postGatewayJson). The work is
    // already durable at this point, so a dispatch failure must SURFACE the
    // created roadmap/task + drill-down link + actionable next steps — never a
    // bare Fatal and never silent orphaned work.
    dispatch = await options.gateway.dispatchNow({ taskId: task.id })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    narrator.warn(`  Dispatch failed: ${reason}`)
    narrator.warn('  Your initiative and task were created and are safe. Retry the dispatch after resolving the daemon error.')
    narrator.detail(`  Open the task: ${taskUrl}`)
    return {
      ok: false,
      outcome: 'dispatch_failed',
      preflight,
      roadmapId: plan.roadmap.id,
      taskId: task.id,
      dashboardUrl: base.dashboardUrl,
      taskUrl,
      failureReason: `Dispatch failed after the task was created: ${reason}`,
      nextSteps: [`Open ${taskUrl}`, 'opencode-gateway doctor', 'opencode-gateway start   # ensure the daemon is healthy, then retry', 'opencode-gateway quickstart'],
    }
  }
  if (dispatch.schedulerPaused) {
    narrator.warn('  The scheduler is paused, so nothing was dispatched. Resume it with `opencode-gateway operator resume` (or scheduler_resume), then re-run.')
    return {
      ok: false,
      outcome: 'scheduler_paused',
      preflight,
      roadmapId: plan.roadmap.id,
      taskId: task.id,
      failureReason: dispatch.guidance || 'Scheduler is paused.',
      nextSteps: ['opencode-gateway operator resume', `opencode-gateway quickstart`],
      dashboardUrl: base.dashboardUrl,
      taskUrl,
    }
  }
  narrator.detail('  ok   Dispatched. An OpenCode session is now working the task.')

  // Step 5/6 — Watch the run to completion, pumping the scheduler each poll so
  // the run advances even before the next daemon heartbeat.
  narrator.step('Step 5/6  Watching the run')
  const deadline = now() + timeoutMs
  let view = await options.gateway.getTask(task.id).catch(() => null)
  let lastStatus = ''
  const narrateStatus = (current: QuickstartTaskView | null) => {
    const status = current?.activeRun ? `running (${current.activeRun.stage || current.currentStage || 'implement'})` : current?.status || 'unknown'
    if (status !== lastStatus) {
      narrator.detail(`  ...  ${status}`)
      lastStatus = status
    }
  }
  narrateStatus(view)
  while (!isTerminalTask(view) && now() < deadline) {
    await sleep(pollIntervalMs)
    await options.gateway.dispatchNow({ taskId: task.id }).catch(() => undefined)
    view = await options.gateway.getTask(task.id).catch(() => view)
    narrateStatus(view)
  }

  // Step 6/6 — Show the result + dashboard drill-down + next steps.
  narrator.step('Step 6/6  Result')
  const run = view?.lastRun || view?.activeRun
  const runId = run?.id
  const runUrl = runId ? quickstartRunUrl(config, runId) : undefined
  const dashboardUrl = base.dashboardUrl
  const summary = run?.result?.summary
  const costUsd = run?.costUsd

  if (!isTerminalTask(view)) {
    narrator.warn(`  Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the run to finish. OpenCode may be slow or unreachable.`)
    narrator.detail(`  Watch it live: ${taskUrl}`)
    return {
      ok: false,
      outcome: 'timeout',
      preflight,
      roadmapId: plan.roadmap.id,
      taskId: task.id,
      runId,
      runStatus: run?.status,
      taskStatus: view?.status,
      dashboardUrl,
      runUrl,
      taskUrl,
      failureReason: 'Timed out waiting for the run to complete.',
      nextSteps: [`Open ${taskUrl}`, 'opencode-gateway triage', 'opencode-gateway logs'],
    }
  }

  const passed = run?.status === 'passed' && view?.status === 'done'
  const nextSteps = [
    `Open the run: ${runUrl || taskUrl}`,
    'opencode-gateway triage      # review anything that needs attention',
    'opencode-gateway analytics   # spend + completion scorecards',
    'opencode-gateway project new <alias> --title "..." --task "..."   # your next real initiative',
  ]

  if (passed) {
    narrator.success(`  Completed. Run ${runId} finished as ${run?.status}.`)
    if (typeof costUsd === 'number') narrator.detail(`  Cost: $${costUsd.toFixed(4)}`)
    if (summary) narrator.detail(`  Summary: ${summary.slice(0, 300)}`)
    if (runUrl) narrator.detail(`  Dashboard: ${runUrl}`)
    narrator.detail('')
    narrator.detail('Next steps:')
    for (const step of nextSteps) narrator.detail(`  ${step}`)
  } else {
    narrator.warn(`  The run finished as ${run?.status || view?.status}. Open the dashboard to see why.`)
    if (summary) narrator.detail(`  Summary: ${summary.slice(0, 300)}`)
    if (runUrl) narrator.detail(`  Dashboard: ${runUrl}`)
  }

  return {
    ok: passed,
    outcome: passed ? 'completed' : 'failed',
    preflight,
    roadmapId: plan.roadmap.id,
    taskId: task.id,
    runId,
    runStatus: run?.status,
    taskStatus: view?.status,
    summary,
    costUsd,
    dashboardUrl,
    runUrl,
    taskUrl,
    nextSteps,
    failureReason: passed ? undefined : `Run finished as ${run?.status || view?.status}.`,
  }
}
