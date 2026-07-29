import { createServer } from 'node:http'
import {
  recordCloudLog,
  recordCloudMetric,
  recordCloudSchedulerMetric,
  recordCloudWorkerMetric,
  type CloudObservabilityAdapter,
} from './observability.ts'
import type { CloudScheduler } from './scheduler.ts'
import type { CloudWorker } from './worker.ts'

function loopErrorAttributes(error: unknown) {
  return {
    error_name: error instanceof Error ? error.name : 'Error',
    error_message: error instanceof Error ? error.message : String(error),
  }
}

export async function recordLoopError(
  observability: CloudObservabilityAdapter | null,
  name: string,
  error: unknown,
  attributes: Record<string, string | number | boolean | null | undefined> = {},
) {
  await recordCloudMetric(observability, {
    name: 'open_cowork_cloud_loop_errors_total',
    value: 1,
    unit: '1',
  })
  await recordCloudLog(observability, {
    level: 'error',
    name,
    message: error instanceof Error ? error.message : String(error),
    attributes: {
      ...attributes,
      ...loopErrorAttributes(error),
    },
  })
}

export type LoopStopper = () => Promise<boolean>

async function waitForLoopDrain(
  loopName: 'worker' | 'scheduler',
  current: Promise<void> | null,
  graceMs: number,
  observability: CloudObservabilityAdapter | null,
) {
  if (!current) return true
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutMarker = Symbol('shutdown-timeout')
  const result = await Promise.race([
    current.then(() => null),
    new Promise<symbol>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(timeoutMarker), graceMs)
    }),
  ])
  if (timeout) clearTimeout(timeout)
  if (result === timeoutMarker) {
    await recordCloudLog(observability, {
      level: 'warn',
      name: `cloud.${loopName}.shutdown_timeout`,
      message: `Cloud ${loopName} loop did not finish before shutdown grace elapsed.`,
      attributes: { grace_ms: graceMs },
    })
    return false
  }
  return true
}

export type LoopHeartbeat = {
  beat(): void
  ageMs(): number
}

export function createLoopHeartbeat(): LoopHeartbeat {
  let lastBeatMs = Date.now()
  return {
    beat() { lastBeatMs = Date.now() },
    ageMs() { return Date.now() - lastBeatMs },
  }
}

export async function startCloudLivenessServer(
  port: number,
  hostname: string,
  isLive: () => boolean,
): Promise<{ close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === '/livez') {
      const live = isLive()
      res.writeHead(live ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: live }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false }))
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 8_000
  server.maxConnections = 64
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, hostname)
  })
  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}

export function startWorkerLoop(
  worker: CloudWorker,
  pollMs: number,
  observability: CloudObservabilityAdapter | null,
  shutdownGraceMs: number,
  heartbeat?: LoopHeartbeat,
): LoopStopper {
  let active = false
  let stopping = false
  let current: Promise<void> | null = null
  const timer = setInterval(() => {
    heartbeat?.beat()
    if (active || stopping) return
    active = true
    current = worker.processAllSessionCommands()
      .then(() => undefined)
      .catch(async (error) => {
        await recordCloudWorkerMetric(observability, {
          name: 'open_cowork_cloud_worker_loop_failures_total',
          status: 'error',
        })
        await recordLoopError(observability, 'cloud.worker.loop.error', error)
      })
      .finally(() => {
        active = false
        current = null
      })
  }, pollMs)
  return async () => {
    stopping = true
    clearInterval(timer)
    return waitForLoopDrain('worker', current, shutdownGraceMs, observability)
  }
}

export function startSchedulerLoop(
  scheduler: CloudScheduler,
  pollMs: number,
  observability: CloudObservabilityAdapter | null,
  shutdownGraceMs: number,
  heartbeat?: LoopHeartbeat,
): LoopStopper {
  let active = false
  let stopping = false
  let current: Promise<void> | null = null
  const timer = setInterval(() => {
    heartbeat?.beat()
    if (active || stopping) return
    active = true
    current = scheduler.processDueWorkflows()
      .then(() => undefined)
      .catch(async (error) => {
        await recordCloudSchedulerMetric(observability, {
          name: 'open_cowork_cloud_scheduler_failures_total',
          status: 'error',
        })
        await recordLoopError(observability, 'cloud.scheduler.loop.error', error)
      })
      .finally(() => {
        active = false
        current = null
      })
  }, pollMs)
  return async () => {
    stopping = true
    clearInterval(timer)
    return waitForLoopDrain('scheduler', current, shutdownGraceMs, observability)
  }
}
