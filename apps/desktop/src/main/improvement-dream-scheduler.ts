import type { AppSettings, DreamRun } from '@open-cowork/shared'
import {
  getLatestCompletedDreamRun,
  getRunningDreamRun,
} from './improvement-store.ts'
import { runScheduledDreamConsolidation, type DreamRuntimeDriver } from './improvement-dream-runner.ts'
import { loadSettings } from './settings.ts'
import { log } from './logger.ts'

const MIN_DREAM_CONSOLIDATION_INTERVAL_HOURS = 24
const MAX_DREAM_CONSOLIDATION_INTERVAL_HOURS = 720

function clampIntervalHours(value: number) {
  if (!Number.isFinite(value)) return 168
  return Math.max(
    MIN_DREAM_CONSOLIDATION_INTERVAL_HOURS,
    Math.min(MAX_DREAM_CONSOLIDATION_INTERVAL_HOURS, Math.floor(value)),
  )
}

function parseRunStartedAt(run: DreamRun | null) {
  if (!run) return null
  const timestamp = Date.parse(run.startedAt)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function isScheduledDreamConsolidationDue(
  settings: AppSettings,
  latestRun: DreamRun | null,
  now = new Date(),
) {
  if (!settings.improvementProposalsEnabled) return false
  if (!settings.dreamConsolidationScheduleEnabled) return false
  const latestStartedAt = parseRunStartedAt(latestRun)
  if (!latestStartedAt) return true
  const intervalMs = clampIntervalHours(settings.dreamConsolidationIntervalHours) * 60 * 60 * 1000
  return now.getTime() - latestStartedAt >= intervalMs
}

export async function runScheduledDreamConsolidationTick(
  now = new Date(),
  driver?: DreamRuntimeDriver,
  settings: AppSettings = loadSettings(),
) {
  if (getRunningDreamRun()) return null
  const latestCompletedRun = getLatestCompletedDreamRun()
  if (!isScheduledDreamConsolidationDue(settings, latestCompletedRun, now)) return null
  try {
    return await runScheduledDreamConsolidation(driver)
  } catch (error) {
    log('improvement', `Scheduled dream consolidation failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
