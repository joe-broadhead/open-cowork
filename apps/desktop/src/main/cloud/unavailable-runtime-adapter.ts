import type { CloudRuntimeAdapter } from './runtime-adapter.ts'

export function createUnavailableRuntimeAdapter(message = 'Cloud runtime is not available in this process role.'): CloudRuntimeAdapter {
  const fail = () => {
    throw new Error(message)
  }
  return {
    createSession: fail,
    promptSession: fail,
    abortSession: fail,
    replyToQuestion: fail,
    rejectQuestion: fail,
    respondToPermission: fail,
  }
}
