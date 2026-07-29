import {
  type ChannelTelemetryOutcome,
  type ChannelTelemetryStack,
} from '@open-cowork/gateway-channel'
import { recordChannelOperation } from '../runtime-metrics.js'
import type { ChannelAdapter } from './provider.js'

type ChannelEgressMethod =
  | 'sendMessage'
  | 'sendStructuredMessage'
  | 'sendCommandMenu'

export interface ChannelEgressTelemetryRecord {
  provider: string
  stack: ChannelTelemetryStack
  direction: 'outbound'
  outcome: ChannelTelemetryOutcome
  latencyMs?: number
}

export interface ChannelEgressTelemetryOptions {
  stack: ChannelTelemetryStack
  now?: () => number
  record?: (record: ChannelEgressTelemetryRecord) => void
}

const EGRESS_METHODS = new Set<PropertyKey>([
  'sendMessage',
  'sendStructuredMessage',
  'sendCommandMenu',
] satisfies ChannelEgressMethod[])

/**
 * Decorate the three ChannelAdapter egress methods at the daemon composition
 * boundary. Calls made by a raw structured/menu implementation through
 * `this.sendMessage` stay inside the raw adapter, so one public operation emits
 * exactly one attempt and one terminal outcome.
 */
export function withChannelEgressTelemetry<T extends ChannelAdapter>(
  adapter: T,
  options: ChannelEgressTelemetryOptions,
): T {
  const now = options.now || Date.now
  const record = options.record || recordRuntimeOperation
  const wrappers = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>()
  const boundMethods = new Map<PropertyKey, (...args: unknown[]) => unknown>()

  return new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (EGRESS_METHODS.has(property)) {
        if (typeof value !== 'function') return undefined
        const existing = wrappers.get(property)
        if (existing) return existing
        const wrapped = async (...args: unknown[]) => {
          const startedAt = now()
          record({
            provider: target.name,
            stack: options.stack,
            direction: 'outbound',
            outcome: 'attempt',
          })
          try {
            const result = await Reflect.apply(value, target, args)
            record({
              provider: target.name,
              stack: options.stack,
              direction: 'outbound',
              outcome: 'success',
              latencyMs: Math.max(0, now() - startedAt),
            })
            return result
          } catch (error) {
            record({
              provider: target.name,
              stack: options.stack,
              direction: 'outbound',
              // This wrapper does not schedule retries. Retry telemetry is
              // emitted only by the owner that actually defers an operation.
              outcome: 'error',
              latencyMs: Math.max(0, now() - startedAt),
            })
            throw error
          }
        }
        wrappers.set(property, wrapped)
        return wrapped
      }
      if (typeof value !== 'function') return value
      const existing = boundMethods.get(property)
      if (existing) return existing
      const bound = value.bind(target) as (...args: unknown[]) => unknown
      boundMethods.set(property, bound)
      return bound
    },
  })
}

function recordRuntimeOperation(record: ChannelEgressTelemetryRecord): void {
  recordChannelOperation(
    record.provider,
    record.stack,
    record.direction,
    record.outcome,
    record.latencyMs,
  )
}
