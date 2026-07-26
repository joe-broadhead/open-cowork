export type CloudCleanup = () => Promise<unknown> | unknown

export type CloudCleanupHandle = {
  deactivate(): void
}

export class CloudAppShutdownError extends Error {
  readonly failureCount: number

  constructor(failureCount: number) {
    super('Cloud app shutdown encountered one or more cleanup failures.')
    this.name = 'CloudAppShutdownError'
    this.failureCount = failureCount
  }
}

export function createCloudStartupCleanupStack() {
  const entries: Array<{
    active: boolean
    cleanup: CloudCleanup
  }> = []

  return {
    add(cleanup: CloudCleanup): CloudCleanupHandle {
      const entry = { active: true, cleanup }
      entries.push(entry)
      return {
        deactivate() {
          entry.active = false
        },
      }
    },
    disarm() {
      entries.length = 0
    },
    async unwind() {
      for (const entry of entries.reverse()) {
        if (!entry.active) continue
        entry.active = false
        try {
          await entry.cleanup()
        } catch {
          // Startup must preserve its original failure. Individual resources
          // own redacted cleanup telemetry where diagnostics are actionable.
        }
      }
      entries.length = 0
    },
  }
}

export async function settleCloudCleanups(cleanups: readonly CloudCleanup[]) {
  let failureCount = 0
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch {
      failureCount += 1
    }
  }
  if (failureCount > 0) throw new CloudAppShutdownError(failureCount)
}
