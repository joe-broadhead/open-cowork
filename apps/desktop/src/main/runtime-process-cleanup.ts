import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from './logger.ts'
import { getRuntimeEnvPaths } from './runtime-paths.ts'

export interface RuntimeProcessInfo {
  pid: number
  ppid: number
  command: string
}

export const OPEN_COWORK_MANAGED_RUNTIME_ENV = 'OPEN_COWORK_MANAGED_RUNTIME'
export const OPEN_COWORK_MANAGED_RUNTIME_VALUE = '1'
const MANAGED_RUNTIME_PID_LEDGER = 'managed-runtime-pids.json'
const PS_SNAPSHOT_MAX_BUFFER_BYTES = 16 * 1024 * 1024

function isPositiveInteger(value: string) {
  return /^[0-9]+$/.test(value)
}

export function parsePsOutput(output: string): RuntimeProcessInfo[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) return null
      const [, pidRaw, ppidRaw, command] = match
      if (!isPositiveInteger(pidRaw) || !isPositiveInteger(ppidRaw) || !command.trim()) return null
      return {
        pid: Number(pidRaw),
        ppid: Number(ppidRaw),
        command: command.trim(),
      }
    })
    .filter((entry): entry is RuntimeProcessInfo => entry !== null)
}

export function isManagedOpencodeServeCommand(command: string) {
  return command.includes('opencode serve --hostname=127.0.0.1 --port=0')
    && command.includes(`${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`)
}

export function collectProcessTreeFromRootPids(processes: RuntimeProcessInfo[], rootPids: number[]) {
  const byParent = new Map<number, RuntimeProcessInfo[]>()
  for (const process of processes) {
    const bucket = byParent.get(process.ppid)
    if (bucket) bucket.push(process)
    else byParent.set(process.ppid, [process])
  }

  const rootPidSet = new Set(rootPids)
  const roots = processes.filter((process) => rootPidSet.has(process.pid))
  if (roots.length === 0) return []

  const visited = new Set<number>()
  const ordered: RuntimeProcessInfo[] = []

  const visit = (process: RuntimeProcessInfo) => {
    if (visited.has(process.pid)) return
    visited.add(process.pid)
    for (const child of byParent.get(process.pid) || []) visit(child)
    ordered.push(process)
  }

  for (const root of roots) visit(root)
  return ordered
}

export function collectOrphanedManagedProcessTree(processes: RuntimeProcessInfo[]) {
  const roots = processes
    .filter((process) => process.ppid === 1 && isManagedOpencodeServeCommand(process.command))
    .map((process) => process.pid)
  return collectProcessTreeFromRootPids(processes, roots)
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function loadProcessSnapshot(includeEnvironment = false) {
  const args = includeEnvironment
    ? ['eww', '-axo', 'pid=,ppid=,command=']
    : ['-axo', 'pid=,ppid=,command=']
  const output = execFileSync('ps', args, {
    encoding: 'utf8',
    maxBuffer: PS_SNAPSHOT_MAX_BUFFER_BYTES,
  })
  return parsePsOutput(output)
}

function getManagedRuntimePidLedgerPath() {
  return join(getRuntimeEnvPaths().stateHome, MANAGED_RUNTIME_PID_LEDGER)
}

export function readTrackedManagedRuntimePids() {
  try {
    const parsed = JSON.parse(readFileSync(getManagedRuntimePidLedgerPath(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((value) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null))
      .filter((value): value is number => value !== null)
  } catch {
    return []
  }
}

function writeTrackedManagedRuntimePids(pids: number[]) {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))].sort((a, b) => a - b)
  const path = getManagedRuntimePidLedgerPath()
  if (unique.length === 0) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(unique, null, 2)}\n`, 'utf8')
}

export function registerTrackedManagedRuntimePid(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return
  const existing = readTrackedManagedRuntimePids()
  writeTrackedManagedRuntimePids([...existing, pid])
}

export function unregisterTrackedManagedRuntimePid(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return
  const existing = readTrackedManagedRuntimePids()
  writeTrackedManagedRuntimePids(existing.filter((entry) => entry !== pid))
}

export function resolveListeningPid(port: number) {
  if (!Number.isInteger(port) || port <= 0) return null
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    }).trim()
    const pid = Number.parseInt(output.split('\n')[0] || '', 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export async function cleanupOrphanedManagedOpencodeProcesses() {
  const plainSnapshot = loadProcessSnapshot(false)
  const trackedRootPids = readTrackedManagedRuntimePids()
  const trackedRoots = plainSnapshot
    .filter((process) => trackedRootPids.includes(process.pid))
    .filter((process) => process.command.includes('opencode serve --hostname=127.0.0.1 --port=0'))
    .map((process) => process.pid)
  if (trackedRootPids.length > 0 && trackedRoots.length === 0) {
    writeTrackedManagedRuntimePids([])
  }
  const trackedTree = collectProcessTreeFromRootPids(plainSnapshot, trackedRoots)

  const initial = trackedTree.length > 0
    ? trackedTree
    : collectOrphanedManagedProcessTree(loadProcessSnapshot(true))

  if (initial.length === 0) return

  for (const runtimeProcess of initial) {
    try {
      process.kill(runtimeProcess.pid, 'SIGTERM')
    } catch {
      // ignore already-exited processes
    }
  }

  await wait(300)

  const survivors = collectOrphanedManagedProcessTree(loadProcessSnapshot())
  for (const runtimeProcess of survivors) {
    try {
      process.kill(runtimeProcess.pid, 'SIGKILL')
    } catch {
      // ignore already-exited processes
    }
  }

  writeTrackedManagedRuntimePids([])

  log('runtime', `Cleaned ${initial.length} orphaned Cowork runtime process(es) before startup`)
}
