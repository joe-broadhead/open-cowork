import type {
  AutonomyLevel,
  CrewRunDetail,
  CrewRunStatus,
  OperationalQueueItem,
} from '@open-cowork/shared'
import {
  blockOperationalQueueItem,
  enqueueOperationalRun,
  finishOperationalQueueItem,
  getOperationalQueueItemForRun,
  getWorkspaceProfile,
  listOperationalQueueItems,
  recordOperationalQueueItemCost,
  startOperationalQueueItem,
} from './operational-queue-store.ts'
import { listCoworkTraceEventsForRun } from './crew-store.ts'
import {
  applyOperationalQueueSettings,
  resolveOperationalAutonomyCeiling,
} from './operational-queue-controls.ts'

const DEFAULT_CREW_WORKSPACE_PROFILE_ID = 'personal-sandbox'
const DEFAULT_CREW_AUTONOMY: AutonomyLevel = 'supervised'

function resolveCrewWorkspaceProfileId(requestedId: string | null | undefined) {
  if (requestedId && getWorkspaceProfile(requestedId)) return requestedId
  return DEFAULT_CREW_WORKSPACE_PROFILE_ID
}

function crewQueueCostUsd(runId: string) {
  return listCoworkTraceEventsForRun(runId).reduce((total, event) => {
    const cost = typeof event.costUsd === 'number' && Number.isFinite(event.costUsd) ? event.costUsd : 0
    return total + cost
  }, 0)
}

function terminalOperationalStatus(status: CrewRunStatus): Exclude<OperationalQueueItem['status'], 'queued' | 'running' | 'blocked'> | null {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return null
}

export function enqueueCrewOperationalQueueItem(detail: CrewRunDetail, options: {
  workspaceProfileId?: string | null
  channelId?: string | null
  budgetCapUsd?: number | null
} = {}) {
  const workspaceProfileId = resolveCrewWorkspaceProfileId(options.workspaceProfileId || detail.version.workspaceProfileId)
  const profile = getWorkspaceProfile(workspaceProfileId)
  const lead = detail.version.members.find((member) => member.role === 'lead')
  const externalSystemIds = profile?.authority.externalSystems
    .filter((system) => system.writeAllowed)
    .map((system) => system.id) || []
  const writeCapable = Boolean(
    profile?.authority.filesystem.writeAllowed
      || externalSystemIds.length > 0,
  )
  const maxCostUsd = typeof options.budgetCapUsd === 'number' && Number.isFinite(options.budgetCapUsd) && options.budgetCapUsd > 0
    ? (typeof detail.version.budgetCapUsd === 'number' && detail.version.budgetCapUsd > 0
        ? Math.min(options.budgetCapUsd, detail.version.budgetCapUsd)
        : options.budgetCapUsd)
    : detail.version.budgetCapUsd
  return enqueueOperationalRun({
    runKind: 'crew',
    runId: detail.run.id,
    title: detail.run.title,
    requestedAutonomy: DEFAULT_CREW_AUTONOMY,
    globalMaxAutonomy: resolveOperationalAutonomyCeiling(DEFAULT_CREW_AUTONOMY),
    workspaceProfileId,
    agentName: lead?.agentName || null,
    crewId: detail.crew.id,
    channelId: options.channelId || null,
    externalSystemIds,
    writeCapable,
    caps: applyOperationalQueueSettings({
      maxParallel: 1,
      maxRunDurationMinutes: 60,
      maxCostUsd,
      maxRetries: 0,
    }, { writeCapable }),
  })
}

export function getCrewOperationalQueueItem(runId: string) {
  return getOperationalQueueItemForRun('crew', runId)
}

export function listQueuedCrewOperationalQueueItems() {
  return listOperationalQueueItems().filter((item) => item.runKind === 'crew' && item.status === 'queued')
}

export function startCrewOperationalQueueItem(runId: string) {
  const item = getCrewOperationalQueueItem(runId)
  if (!item) return null
  return startOperationalQueueItem(item.id)
}

export function recordCrewOperationalQueueCost(runId: string) {
  const item = getCrewOperationalQueueItem(runId)
  if (!item || item.status !== 'running') return item
  return recordOperationalQueueItemCost(item.id, crewQueueCostUsd(runId))
}

export function syncCrewOperationalQueueStatus(runId: string, status: CrewRunStatus, summary?: string | null) {
  const item = getCrewOperationalQueueItem(runId)
  if (!item) return null
  if (item.status === 'running') {
    recordOperationalQueueItemCost(item.id, crewQueueCostUsd(runId))
  }
  const terminal = terminalOperationalStatus(status)
  if (terminal) {
    return finishOperationalQueueItem(item.id, terminal, {
      costUsd: crewQueueCostUsd(runId),
      error: terminal === 'failed' || terminal === 'cancelled' ? summary : null,
    })
  }
  if (status === 'blocked') {
    return blockOperationalQueueItem(item.id, summary || 'Crew run is blocked and requires attention.')
  }
  return getCrewOperationalQueueItem(runId)
}
