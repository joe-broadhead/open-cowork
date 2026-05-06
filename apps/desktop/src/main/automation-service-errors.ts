export class AutomationRunStartError extends Error {
  runId: string | null
  retryScheduled: boolean

  constructor(message: string, options: { runId?: string | null, retryScheduled?: boolean } = {}) {
    super(message)
    this.name = 'AutomationRunStartError'
    this.runId = options.runId ?? null
    this.retryScheduled = options.retryScheduled ?? false
  }
}

export class AutomationRunConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutomationRunConflictError'
  }
}
