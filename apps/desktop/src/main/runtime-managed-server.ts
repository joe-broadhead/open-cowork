import { createManagedOpencodeServerWithSupervisor, type ManagedOpencodeServerUnexpectedExit, type ManagedOpencodeServerLogLevel, type ManagedOpencodeSupervisorFork, type ManagedOpencodeSupervisorProcess } from '@open-cowork/runtime-host'
import electron from 'electron'
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

const electronUtilityProcess = (electron as { utilityProcess?: typeof import('electron').utilityProcess }).utilityProcess
const currentModulePath = typeof __filename === 'string' && __filename !== '[eval]'
  ? __filename
  : fileURLToPath(import.meta.url)
const currentModuleDir = dirname(currentModulePath)

export function resolveManagedOpencodeSupervisorPath() {
  return join(currentModuleDir, 'runtime-managed-server-supervisor.js')
}

function forkManagedOpencodeSupervisor(modulePath: string): ManagedOpencodeSupervisorProcess {
  if (!electronUtilityProcess) {
    throw new Error('Electron utilityProcess is unavailable; the managed OpenCode server can only start from the Electron main process.')
  }
  return electronUtilityProcess.fork(modulePath, [], {
    serviceName: 'opencode-managed-server',
    stdio: 'pipe',
  }) as ManagedOpencodeSupervisorProcess
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
