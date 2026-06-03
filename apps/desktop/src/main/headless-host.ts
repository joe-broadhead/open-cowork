import type { RuntimeDoctorCheck, RuntimeStatus } from '@open-cowork/shared'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sanitizeForExport } from './log-sanitizer.ts'

export const HEADLESS_HOST_STATUS_VERSION = 1
export const HEADLESS_HOST_STATE_VERSION = 1

export type HeadlessHostMode = 'check' | 'status' | 'doctor' | 'start' | 'stop'
export type HeadlessTopology = 'loopback' | 'lan' | 'remote' | 'tunnel'

export interface HeadlessHostRequest {
  mode: HeadlessHostMode
  topology?: HeadlessTopology
  bindHost?: string
  port?: number
  workspaceRoot?: string | null
  stateDir?: string | null
  detached?: boolean
}

export interface HeadlessHostPlan {
  ok: boolean
  mode: HeadlessHostMode
  topology: HeadlessTopology
  bindHost: string
  port: number
  reasonCode:
    | 'headless-loopback-check-ready'
    | 'headless-remote-binding-blocked'
    | 'headless-invalid-port'
}

export interface HeadlessHostStatusOutput {
  schemaVersion: typeof HEADLESS_HOST_STATUS_VERSION
  mode: HeadlessHostMode
  topology: HeadlessTopology
  bindHost: string
  port: number
  runtime: Pick<RuntimeStatus, 'ready' | 'phase' | 'error' | 'updatedAt'>
  checks: RuntimeDoctorCheck[]
  redacted: true
}

export interface HeadlessHostState {
  schemaVersion: typeof HEADLESS_HOST_STATE_VERSION
  hostId: string
  pid: number
  mode: HeadlessHostMode
  topology: HeadlessTopology
  bindHost: string
  port: number
  startedAt: string
  updatedAt: string
  status: HeadlessHostStatusOutput
  detached?: boolean
  redacted: true
}

export interface HeadlessHostCommandResult {
  ok: boolean
  exitCode: number
  reasonCode:
    | HeadlessHostPlan['reasonCode']
    | 'headless-runtime-check-passed'
    | 'headless-runtime-check-failed'
    | 'headless-status-read'
    | 'headless-state-not-found'
    | 'headless-state-stale'
    | 'headless-doctor-ready'
    | 'headless-detached-started'
    | 'headless-stopped'
  status: HeadlessHostStatusOutput
  state: HeadlessHostState | null
  diagnostics?: string
  redacted: true
}

export interface HeadlessHostCommandDependencies {
  startRuntime?: (workspaceRoot?: string | null) => Promise<unknown>
  stopRuntime?: () => Promise<void> | void
  runtimeStatus?: () => RuntimeStatus
  setRuntimeReady?: (ready: boolean, error?: string | null) => void
  setRuntimeError?: (error: string | null) => void
  diagnosticsBundle?: () => string
  waitForStop?: (state: HeadlessHostState) => Promise<void>
  signalProcess?: (pid: number, signal: 'SIGTERM') => void
  processExists?: (pid: number) => boolean
  now?: () => Date
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_PORT = 0
const STATE_FILE = 'state.json'

function sanitizeText(value: string | null | undefined) {
  return value ? sanitizeForExport(value).slice(0, 2000) : value
}

function sanitizeCheck(check: RuntimeDoctorCheck): RuntimeDoctorCheck {
  return {
    ...check,
    message: sanitizeForExport(check.message).slice(0, 2000),
    remediation: sanitizeText(check.remediation) || undefined,
    evidence: check.evidence
      ? Object.fromEntries(Object.entries(check.evidence).map(([key, value]) => [
          key,
          typeof value === 'string' ? sanitizeForExport(value).slice(0, 500) : value,
        ]))
      : undefined,
  }
}

export function planHeadlessHostRequest(input: HeadlessHostRequest): HeadlessHostPlan {
  const topology = input.topology || 'loopback'
  const bindHost = input.bindHost || '127.0.0.1'
  const port = input.port ?? DEFAULT_PORT

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return {
      ok: false,
      mode: input.mode,
      topology,
      bindHost,
      port,
      reasonCode: 'headless-invalid-port',
    }
  }

  if (topology !== 'loopback' || !LOOPBACK_HOSTS.has(bindHost)) {
    return {
      ok: false,
      mode: input.mode,
      topology,
      bindHost,
      port,
      reasonCode: 'headless-remote-binding-blocked',
    }
  }

  return {
    ok: true,
    mode: input.mode,
    topology,
    bindHost,
    port,
    reasonCode: 'headless-loopback-check-ready',
  }
}

export function createHeadlessHostStatusOutput(input: {
  request: HeadlessHostRequest
  runtimeStatus: RuntimeStatus
  checks?: RuntimeDoctorCheck[]
}): HeadlessHostStatusOutput {
  const plan = planHeadlessHostRequest(input.request)
  return {
    schemaVersion: HEADLESS_HOST_STATUS_VERSION,
    mode: plan.mode,
    topology: plan.topology,
    bindHost: plan.bindHost,
    port: plan.port,
    runtime: {
      ready: input.runtimeStatus.ready,
      phase: input.runtimeStatus.phase,
      error: sanitizeText(input.runtimeStatus.error),
      updatedAt: input.runtimeStatus.updatedAt,
    },
    checks: (input.checks || input.runtimeStatus.checks || []).map(sanitizeCheck),
    redacted: true,
  }
}

async function defaultStateDir() {
  const { getAppDataDir } = await import('./config-loader.ts')
  return join(getAppDataDir(), 'headless-host')
}

export async function resolveHeadlessHostStateDir(stateDir?: string | null) {
  const selected = stateDir || process.env.OPEN_COWORK_HEADLESS_STATE_DIR || await defaultStateDir()
  return resolve(selected)
}

function statePathForDir(stateDir: string) {
  return join(stateDir, STATE_FILE)
}

function createHostId(plan: HeadlessHostPlan) {
  return `headless-${plan.topology}-${plan.bindHost.replace(/[^a-z0-9.-]/gi, '_')}-${plan.port}`
}

export async function writeHeadlessHostState(
  request: HeadlessHostRequest,
  status: HeadlessHostStatusOutput,
  options: { stateDir?: string | null; now?: Date } = {},
): Promise<HeadlessHostState> {
  const plan = planHeadlessHostRequest(request)
  const dir = await resolveHeadlessHostStateDir(options.stateDir ?? request.stateDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const timestamp = (options.now || new Date()).toISOString()
  const state: HeadlessHostState = {
    schemaVersion: HEADLESS_HOST_STATE_VERSION,
    hostId: createHostId(plan),
    pid: process.pid,
    mode: plan.mode,
    topology: plan.topology,
    bindHost: plan.bindHost,
    port: plan.port,
    ...(request.detached ? { detached: true } : {}),
    startedAt: timestamp,
    updatedAt: timestamp,
    status,
    redacted: true,
  }
  await writeFile(statePathForDir(dir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  return state
}

export async function readHeadlessHostState(stateDir?: string | null): Promise<HeadlessHostState | null> {
  const dir = await resolveHeadlessHostStateDir(stateDir)
  try {
    const parsed = JSON.parse(await readFile(statePathForDir(dir), 'utf8')) as Partial<HeadlessHostState>
    if (parsed.schemaVersion !== HEADLESS_HOST_STATE_VERSION || parsed.redacted !== true) return null
    if (!parsed.status || parsed.status.redacted !== true) return null
    return parsed as HeadlessHostState
  } catch {
    return null
  }
}

export async function clearHeadlessHostState(stateDir?: string | null) {
  const dir = await resolveHeadlessHostStateDir(stateDir)
  await rm(statePathForDir(dir), { force: true })
}

async function defaultRuntimeStatus() {
  const { getRuntimeStatus } = await import('./runtime-status.ts')
  return getRuntimeStatus()
}

async function defaultSetRuntimeReady(ready: boolean, error?: string | null) {
  const { setRuntimeReady } = await import('./runtime-status.ts')
  setRuntimeReady(ready, error)
}

async function defaultSetRuntimeError(error: string | null) {
  const { setRuntimeError } = await import('./runtime-status.ts')
  setRuntimeError(error)
}

async function defaultStartRuntime(workspaceRoot?: string | null) {
  const { startRuntime } = await import('./runtime.ts')
  return startRuntime(workspaceRoot)
}

async function defaultStopRuntime() {
  const { stopRuntime } = await import('./runtime.ts')
  return stopRuntime()
}

async function defaultDiagnosticsBundle() {
  const { buildDiagnosticsBundle } = await import('./diagnostics-export.ts')
  return buildDiagnosticsBundle()
}

function defaultWaitForStop() {
  return new Promise<void>((finishWaiting) => {
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      process.off('SIGINT', finish)
      process.off('SIGTERM', finish)
      finishWaiting()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
  })
}

function defaultSignalProcess(pid: number, signal: 'SIGTERM') {
  process.kill(pid, signal)
}

function defaultProcessExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      return (error as { code?: unknown }).code === 'EPERM'
    }
    return false
  }
}

function stateProcessIsLive(state: HeadlessHostState, dependencies: HeadlessHostCommandDependencies) {
  if (state.mode !== 'start') return true
  if (state.pid === process.pid) return true
  const processExists = dependencies.processExists || defaultProcessExists
  return processExists(state.pid)
}

async function readCurrentHeadlessHostState(
  stateDir: string | null,
  dependencies: HeadlessHostCommandDependencies,
) {
  const state = await readHeadlessHostState(stateDir)
  if (!state || stateProcessIsLive(state, dependencies)) return { state, stale: false }
  await clearHeadlessHostState(stateDir)
  return { state: null, stale: true }
}

async function statusFromDependencies(
  request: HeadlessHostRequest,
  dependencies: HeadlessHostCommandDependencies,
) {
  const runtimeStatus = dependencies.runtimeStatus ? dependencies.runtimeStatus() : await defaultRuntimeStatus()
  return createHeadlessHostStatusOutput({ request, runtimeStatus })
}

export async function runHeadlessHostCommand(
  request: HeadlessHostRequest,
  dependencies: HeadlessHostCommandDependencies = {},
): Promise<HeadlessHostCommandResult> {
  const plan = planHeadlessHostRequest(request)
  const now = dependencies.now || (() => new Date())
  const status = await statusFromDependencies(request, dependencies)
  const stateDir = request.stateDir || null

  if (!plan.ok) {
    return {
      ok: false,
      exitCode: 2,
      reasonCode: plan.reasonCode,
      status,
      state: null,
      redacted: true,
    }
  }

  if (request.mode === 'status') {
    const { state, stale } = await readCurrentHeadlessHostState(stateDir, dependencies)
    return {
      ok: Boolean(state),
      exitCode: state ? 0 : 3,
      reasonCode: state ? 'headless-status-read' : stale ? 'headless-state-stale' : 'headless-state-not-found',
      status,
      state,
      redacted: true,
    }
  }

  if (request.mode === 'stop') {
    const state = await readHeadlessHostState(stateDir)
    if (state?.mode === 'start' && state.pid !== process.pid && stateProcessIsLive(state, dependencies)) {
      try {
        const signalProcess = dependencies.signalProcess || defaultSignalProcess
        signalProcess(state.pid, 'SIGTERM')
      } catch {
        // State cleanup below is authoritative for this product surface. A
        // missing process is treated as already stopped.
      }
    }
    const stopRuntime = dependencies.stopRuntime || defaultStopRuntime
    await stopRuntime()
    if (dependencies.setRuntimeReady) dependencies.setRuntimeReady(false, null)
    else await defaultSetRuntimeReady(false, null)
    await clearHeadlessHostState(stateDir)
    return {
      ok: true,
      exitCode: 0,
      reasonCode: 'headless-stopped',
      status: await statusFromDependencies(request, dependencies),
      state: null,
      redacted: true,
    }
  }

  if (request.mode === 'doctor') {
    const diagnostics = dependencies.diagnosticsBundle
      ? dependencies.diagnosticsBundle()
      : await defaultDiagnosticsBundle()
    const state = await readHeadlessHostState(stateDir)
    return {
      ok: true,
      exitCode: 0,
      reasonCode: 'headless-doctor-ready',
      status,
      state,
      diagnostics: sanitizeForExport(diagnostics),
      redacted: true,
    }
  }

  if (request.mode === 'start') {
    try {
      const startRuntime = dependencies.startRuntime || defaultStartRuntime
      const stopRuntime = dependencies.stopRuntime || defaultStopRuntime
      const waitForStop = dependencies.waitForStop || defaultWaitForStop
      if (dependencies.setRuntimeReady) dependencies.setRuntimeReady(false, null)
      else await defaultSetRuntimeReady(false, null)
      await startRuntime(request.workspaceRoot || null)
      if (dependencies.setRuntimeReady) dependencies.setRuntimeReady(true)
      else await defaultSetRuntimeReady(true)
      const startedStatus = await statusFromDependencies(request, dependencies)
      const startedState = await writeHeadlessHostState(request, startedStatus, { stateDir, now: now() })
      if (request.detached) {
        return {
          ok: true,
          exitCode: 0,
          reasonCode: 'headless-detached-started',
          status: startedStatus,
          state: startedState,
          redacted: true,
        }
      }
      await waitForStop(startedState)
      await stopRuntime()
      if (dependencies.setRuntimeReady) dependencies.setRuntimeReady(false, null)
      else await defaultSetRuntimeReady(false, null)
      await clearHeadlessHostState(stateDir)
      return {
        ok: true,
        exitCode: 0,
        reasonCode: 'headless-stopped',
        status: await statusFromDependencies(request, dependencies),
        state: null,
        redacted: true,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (dependencies.setRuntimeError) dependencies.setRuntimeError(message)
      else await defaultSetRuntimeError(message)
      const failedStatus = await statusFromDependencies(request, dependencies)
      const failedState = await writeHeadlessHostState(request, failedStatus, { stateDir, now: now() })
      try {
        await (dependencies.stopRuntime || defaultStopRuntime)()
      } catch {
        // Startup failure is already captured in the redacted status.
      }
      return {
        ok: false,
        exitCode: 1,
        reasonCode: 'headless-runtime-check-failed',
        status: failedStatus,
        state: failedState,
        redacted: true,
      }
    }
  }

  try {
    const startRuntime = dependencies.startRuntime || defaultStartRuntime
    const stopRuntime = dependencies.stopRuntime || defaultStopRuntime
    if (dependencies.setRuntimeReady) dependencies.setRuntimeReady(false, null)
    else await defaultSetRuntimeReady(false, null)
    await startRuntime(request.workspaceRoot || null)
    if (dependencies.setRuntimeReady) dependencies.setRuntimeReady(true)
    else await defaultSetRuntimeReady(true)
    const passedStatus = await statusFromDependencies(request, dependencies)
    const state = await writeHeadlessHostState(request, passedStatus, { stateDir, now: now() })
    await stopRuntime()
    return {
      ok: true,
      exitCode: 0,
      reasonCode: 'headless-runtime-check-passed',
      status: passedStatus,
      state,
      redacted: true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (dependencies.setRuntimeError) dependencies.setRuntimeError(message)
    else await defaultSetRuntimeError(message)
    const failedStatus = await statusFromDependencies(request, dependencies)
    const state = await writeHeadlessHostState(request, failedStatus, { stateDir, now: now() })
    try {
      await (dependencies.stopRuntime || defaultStopRuntime)()
    } catch {
      // The failed check result already records the runtime error. Cleanup
      // failure is reported by the next doctor/status run.
    }
    return {
      ok: false,
      exitCode: 1,
      reasonCode: 'headless-runtime-check-failed',
      status: failedStatus,
      state,
      redacted: true,
    }
  }
}
