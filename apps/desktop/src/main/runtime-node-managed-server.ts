import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createManagedOpencodeServerWithSupervisor,
  type ManagedOpencodeServerLogLevel,
  type ManagedOpencodeServerUnexpectedExit,
  type ManagedOpencodeSupervisorProcess,
} from './runtime-managed-server-core.ts'

const currentModulePath = typeof __filename === 'string' && __filename !== '[eval]'
  ? __filename
  : fileURLToPath(import.meta.url)
const currentModuleDir = dirname(currentModulePath)

export function resolveNodeManagedOpencodeSupervisorPath() {
  const jsPath = join(currentModuleDir, 'runtime-managed-server-supervisor.js')
  if (existsSync(jsPath)) return jsPath
  return join(currentModuleDir, 'runtime-managed-server-supervisor.ts')
}

export function forkNodeManagedOpencodeSupervisor(modulePath: string): ManagedOpencodeSupervisorProcess {
  const execArgv = modulePath.endsWith('.ts') ? ['--no-warnings', '--experimental-strip-types'] : []
  const child = fork(modulePath, [], {
    execArgv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  return {
    get pid() {
      return child.pid
    },
    stdout: child.stdout,
    stderr: child.stderr,
    postMessage(message) {
      if (!child.connected) return
      const reportSendError = (error: Error | null) => {
        if (!error || message.type === 'shutdown' || child.listenerCount('error') === 0) return
        child.emit('error', error)
      }
      try {
        child.send(message, reportSendError)
      } catch (error) {
        if (message.type !== 'shutdown' && child.listenerCount('error') > 0) {
          child.emit('error', error as Error)
        }
      }
    },
    kill() {
      return child.kill()
    },
    on(event, listener) {
      child.on(event, listener as Parameters<ChildProcess['on']>[1])
      return child
    },
    off(event, listener) {
      child.off(event, listener as Parameters<ChildProcess['off']>[1])
      return child
    },
  }
}

export async function createNodeManagedOpencodeServer(options: OpencodeServerOptions & {
  env: NodeJS.ProcessEnv
  supervisorPath?: string
  onUnexpectedExit?: (event: ManagedOpencodeServerUnexpectedExit) => void
  opencodeBinPath?: string | null
  logLevel?: ManagedOpencodeServerLogLevel
  cwd?: string
}) {
  return createManagedOpencodeServerWithSupervisor({
    ...options,
    forkSupervisor: forkNodeManagedOpencodeSupervisor,
    startOnSpawnFallbackMs: null,
    supervisorPath: options.supervisorPath || resolveNodeManagedOpencodeSupervisorPath(),
  })
}
