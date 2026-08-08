import type { Env } from './cloud-config-parse.ts'
import {
  recordCloudLog,
  recordCloudMetric,
  type CloudObservabilityAdapter,
} from './observability.ts'
import {
  createCloudProgressWatchdog,
  resolveCloudProgressWatchdogConfig,
  type CloudProgressWatchdogSnapshot,
} from './progress-watchdog.ts'
import {
  toProgressWatchdogObservation,
  type CloudRuntimeProgressEvent,
} from './runtime-adapter.ts'
import type { CloudWorker } from './worker.ts'

export type CloudProgressWatchdogComposition = {
  readonly enabled: boolean
  observe(event: CloudRuntimeProgressEvent): boolean
  snapshot(): CloudProgressWatchdogSnapshot
  close(): Promise<void>
}

export function createCloudProgressWatchdogComposition(input: {
  env: Env
  observability: CloudObservabilityAdapter | null
  worker: (
    Pick<CloudWorker, 'recoverStalledSession'>
    & Partial<Pick<CloudWorker, 'recordProgressWatchdogAudit'>>
  ) | null
}): CloudProgressWatchdogComposition {
  const worker = input.worker
  const config = resolveCloudProgressWatchdogConfig(worker ? input.env : {})
  const watchdog = createCloudProgressWatchdog({
    config,
    async onDecision(event) {
      const attributes = {
        watchdog_state: event.decision.state,
        watchdog_outcome: event.outcome,
      }
      await recordCloudMetric(input.observability, {
        name: 'open_cowork_cloud_progress_watchdog_decisions_total',
        value: 1,
        kind: 'counter',
        unit: '1',
        attributes,
      })
      await recordCloudLog(input.observability, {
        level: event.outcome === 'failed' ? 'error' : 'info',
        name: 'cloud.progress_watchdog.decision',
        message: 'Cloud progress watchdog decision recorded.',
        attributes,
      })
      if (config.mode !== 'off') {
        await worker?.recordProgressWatchdogAudit?.({ ...event, mode: config.mode })
      }
    },
    recover: worker
      ? (decision, isCurrent) => worker.recoverStalledSession(decision, isCurrent)
      : undefined,
  })

  return {
    enabled: config.mode !== 'off',
    observe(event) {
      const observation = toProgressWatchdogObservation(event)
      return observation ? watchdog.observe(observation) : false
    },
    snapshot: () => watchdog.snapshot(),
    close: () => watchdog.close(),
  }
}
