import type {
  AutonomyLevel,
  OperationalQueueCaps,
} from '@open-cowork/shared'
import { resolveEffectiveAutonomy } from './operational-queue-store.ts'
import { loadSettings } from './settings.ts'

type QueueCapsInput = Partial<Pick<OperationalQueueCaps, 'maxParallel' | 'maxRunDurationMinutes' | 'maxCostUsd' | 'maxRetries'>>

function minNullableCost(left: number | null | undefined, right: number | null | undefined) {
  if (left === null || left === undefined) return right ?? null
  if (right === null || right === undefined) return left
  return Math.min(left, right)
}

function minDefined(left: number | undefined, right: number) {
  return left === undefined ? right : Math.min(left, right)
}

export function resolveOperationalAutonomyCeiling(runCeiling: AutonomyLevel = 'bounded-auto') {
  return resolveEffectiveAutonomy(runCeiling, loadSettings().operationalMaxAutonomy)
}

export function applyOperationalQueueSettings(caps: QueueCapsInput = {}, options: { writeCapable?: boolean } = {}) {
  const settings = loadSettings()
  return {
    maxParallel: options.writeCapable ? settings.operationalWriteMaxParallel : caps.maxParallel,
    maxRunDurationMinutes: minDefined(caps.maxRunDurationMinutes, settings.operationalMaxRunDurationMinutes),
    maxCostUsd: minNullableCost(caps.maxCostUsd, settings.operationalMaxCostUsd),
    maxRetries: minDefined(caps.maxRetries, settings.operationalMaxRetries),
  } satisfies QueueCapsInput
}
