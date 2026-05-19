export type ManagedOpencodeServerBootMessage = {
  type: 'boot'
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs: number
}

export type ManagedOpencodeServerShutdownMessage = {
  type: 'shutdown'
}

export type ManagedOpencodeServerParentMessage =
  | ManagedOpencodeServerBootMessage
  | ManagedOpencodeServerShutdownMessage

export type ManagedOpencodeServerReadyMessage = {
  type: 'ready'
  url: string
  pid?: number
}

export type ManagedOpencodeServerSupervisorReadyMessage = {
  type: 'supervisor-ready'
}

export type ManagedOpencodeServerStartupErrorMessage = {
  type: 'startup-error'
  message: string
  stdoutTail: string
}

export type ManagedOpencodeServerExitedMessage = {
  type: 'exited'
  code: number | null
  signal: NodeJS.Signals | null
}

export type ManagedOpencodeServerSupervisorMessage =
  | ManagedOpencodeServerSupervisorReadyMessage
  | ManagedOpencodeServerReadyMessage
  | ManagedOpencodeServerStartupErrorMessage
  | ManagedOpencodeServerExitedMessage
