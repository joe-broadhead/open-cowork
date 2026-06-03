#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  clearHeadlessHostState,
  readHeadlessHostState,
  resolveHeadlessHostStateDir,
  runHeadlessHostCommand,
  type HeadlessHostMode,
  type HeadlessHostRequest,
  type HeadlessTopology,
} from '../apps/desktop/src/main/headless-host.ts'
import { sanitizeForExport } from '../apps/desktop/src/main/log-sanitizer.ts'

const MODES = new Set<HeadlessHostMode>(['check', 'status', 'doctor', 'start', 'stop'])
const TOPOLOGIES = new Set<HeadlessTopology>(['loopback', 'lan', 'remote', 'tunnel'])

function readValue(args: string[], index: number, name: string) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  return value
}

export function parseArgs(argv: string[]) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    return { help: true as const, request: { mode: 'check' as HeadlessHostMode } }
  }

  const mode = (argv[0] || 'check') as HeadlessHostMode
  if (!MODES.has(mode)) throw new Error(`Unsupported headless host mode: ${mode}`)

  const request: {
    mode: HeadlessHostMode
    topology?: HeadlessTopology
    bindHost?: string
    port?: number
    workspaceRoot?: string | null
    stateDir?: string | null
    detached?: boolean
  } = { mode }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--topology') {
      const value = readValue(argv, index, arg) as HeadlessTopology
      if (!TOPOLOGIES.has(value)) throw new Error(`Unsupported topology: ${value}`)
      request.topology = value
      index += 1
      continue
    }
    if (arg === '--bind-host') {
      request.bindHost = readValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--port') {
      const value = Number(readValue(argv, index, arg))
      request.port = value
      index += 1
      continue
    }
    if (arg === '--workspace') {
      request.workspaceRoot = readValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--state-dir') {
      request.stateDir = readValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--detached') {
      request.detached = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true as const, request }
    }
    throw new Error(`Unknown headless host option: ${arg}`)
  }

  return { help: false as const, request }
}

function usage() {
  return `Usage: node --no-warnings --experimental-strip-types scripts/headless-host.ts [check|start|status|doctor|stop] [options]

Options:
  --workspace <path>       Workspace root for check/start mode.
  --state-dir <path>       Product-owned headless state directory override.
  --topology <name>        loopback, lan, remote, or tunnel. Default: loopback.
  --bind-host <host>       Bind host. Default: 127.0.0.1.
  --port <number>          Bind port. Default: 0.
  --detached               Start loopback runtime, write state, and return immediately.

Default output is redacted JSON. start runs in the foreground on loopback until SIGINT, SIGTERM, or a stop command unless --detached is set. Remote/LAN/tunnel binding fails closed unless a later topology-specific authority is implemented.`
}

export function buildDetachedHeadlessHostArgs(request: HeadlessHostRequest) {
  const args = ['start']
  if (request.topology) args.push('--topology', request.topology)
  if (request.bindHost) args.push('--bind-host', request.bindHost)
  if (request.port !== undefined) args.push('--port', String(request.port))
  if (request.workspaceRoot) args.push('--workspace', request.workspaceRoot)
  if (request.stateDir) args.push('--state-dir', request.stateDir)
  return args
}

async function waitForDetachedState(request: HeadlessHostRequest, childPid: number) {
  const stateDir = await resolveHeadlessHostStateDir(request.stateDir)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const state = await readHeadlessHostState(stateDir)
    if (state?.mode === 'start' && state.pid === childPid) {
      return state
    }
    try {
      process.kill(childPid, 0)
    } catch {
      break
    }
    await sleep(100)
  }
  throw new Error('Detached headless host did not write state before exiting or timing out.')
}

export async function startDetachedHeadlessHost(request: HeadlessHostRequest) {
  const stateDir = await resolveHeadlessHostStateDir(request.stateDir)
  const existing = await runHeadlessHostCommand({ mode: 'status', stateDir })
  if (existing.ok && existing.state?.mode === 'start') {
    return {
      ...existing,
      reasonCode: 'headless-detached-started' as const,
    }
  }
  await clearHeadlessHostState(stateDir)
  const scriptPath = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [
    ...process.execArgv,
    '--no-warnings',
    '--experimental-strip-types',
    scriptPath,
    ...buildDetachedHeadlessHostArgs({ ...request, stateDir, detached: false }),
  ], {
    detached: true,
    env: {
      ...process.env,
      OPEN_COWORK_HEADLESS_DETACHED_CHILD: '1',
    },
    stdio: 'ignore',
  })
  if (!child.pid) throw new Error('Detached headless host did not receive a process id.')
  child.unref()

  const state = await waitForDetachedState({ ...request, stateDir }, child.pid)
  return {
    ok: true,
    exitCode: 0,
    reasonCode: 'headless-detached-started' as const,
    status: state.status,
    state,
    redacted: true as const,
  }
}

export async function runHeadlessHostCli(argv: string[]) {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    return { output: `${usage()}\n`, exitCode: 0 }
  }

  const result = parsed.request.mode === 'start'
    && parsed.request.detached
    && process.env.OPEN_COWORK_HEADLESS_DETACHED_CHILD !== '1'
    ? await startDetachedHeadlessHost(parsed.request)
    : await runHeadlessHostCommand(parsed.request)
  return { output: `${JSON.stringify(result, null, 2)}\n`, exitCode: result.exitCode }
}

async function main() {
  const result = await runHeadlessHostCli(process.argv.slice(2))
  process.stdout.write(result.output)
  process.exitCode = result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${sanitizeForExport(error instanceof Error ? error.message : String(error))}\n`)
    process.exitCode = 1
  })
}
