import { createManagedOpencodeServerWithSupervisor, type ManagedOpencodeServerUnexpectedExit, type ManagedOpencodeServerLogLevel, type ManagedOpencodeSupervisorFork, type ManagedOpencodeSupervisorProcess } from '@open-cowork/runtime-host'
import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
export {
  MANAGED_OPENCODE_SERVER_USERNAME,
  buildManagedOpencodeAuthorizationHeader,
  buildManagedOpencodeServerEnvironment,
  createManagedOpencodeServerAuth,
  resolveManagedOpencodeCommand,
  resolveManagedOpencodeSpawn,
  type ManagedOpencodeServerAuth,
  type ManagedOpencodeServerLogLevel,
  type ManagedOpencodeServerUnexpectedExit,
  type ManagedOpencodeSupervisorFork,
  type ManagedOpencodeSupervisorProcess,
} from '@open-cowork/runtime-host'
export {
  drainManagedOpencodeProcessOutput,
  parseManagedOpencodeServerStdoutChunk,
  type ManagedOpencodeServerStdoutParseResult,
  type ManagedProcessOutputStreams,
} from '@open-cowork/runtime-host'

const currentModulePath = typeof __filename === 'string' && __filename !== '[eval]'
  ? __filename
  : fileURLToPath(import.meta.url)
const currentModuleDir = dirname(currentModulePath)

export function resolveManagedOpencodeSupervisorPath() {
  return join(currentModuleDir, 'runtime-managed-server-supervisor.js')
}

// The managed OpenCode server is forked via Electron's utilityProcess, which only
// exists in the desktop main process. The desktop injects that forker at startup
// (see desktop-electron-hosts.ts); the cloud server never sets it and never calls
// createManagedOpencodeServer (it forks its supervisor with node:child_process via
// runtime-node-managed-server instead), so the "unavailable" guard below is exactly
// the behavior the build-cloud Electron shim produced before.
let injectedSupervisorForker: ManagedOpencodeSupervisorFork | null = null

export function setManagedOpencodeSupervisorForker(fork: ManagedOpencodeSupervisorFork | null) {
  injectedSupervisorForker = fork
}

function forkManagedOpencodeSupervisor(modulePath: string): ManagedOpencodeSupervisorProcess {
  if (!injectedSupervisorForker) {
    throw new Error('Electron utilityProcess is unavailable; the managed OpenCode server can only start from the Electron main process.')
  }
  return injectedSupervisorForker(modulePath)
}

export async function createManagedOpencodeServer(options: OpencodeServerOptions & {
  env: NodeJS.ProcessEnv
  forkUtilityProcess?: ManagedOpencodeSupervisorFork
  onUnexpectedExit?: (event: ManagedOpencodeServerUnexpectedExit) => void
  opencodeBinPath?: string | null
  logLevel?: ManagedOpencodeServerLogLevel
  cwd?: string
}) {
  return createManagedOpencodeServerWithSupervisor({
    ...options,
    forkSupervisor: options.forkUtilityProcess || forkManagedOpencodeSupervisor,
    supervisorPath: resolveManagedOpencodeSupervisorPath(),
  })
}
