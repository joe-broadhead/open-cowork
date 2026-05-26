type ElectronAppWithCommandLine = {
  commandLine: {
    appendSwitch(name: string, value?: string): void
  }
}

export function resolveE2ERemoteDebuggingPort(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPEN_COWORK_E2E !== '1') return null
  const raw = env.OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT?.trim()
  if (!raw || !/^\d{1,5}$/.test(raw)) return null
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return String(port)
}

export function appendE2ERemoteDebuggingSwitches(electronApp: ElectronAppWithCommandLine, env: NodeJS.ProcessEnv = process.env) {
  const port = resolveE2ERemoteDebuggingPort(env)
  if (!port) return false
  electronApp.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  electronApp.commandLine.appendSwitch('remote-debugging-port', port)
  return true
}
