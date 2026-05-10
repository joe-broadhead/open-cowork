import type {
  AutomationDetail,
  AutomationRun,
  AutomationRunKind,
  AutonomyLevel,
  OperationalQueueItem,
} from '@open-cowork/shared'
import {
  blockOperationalQueueItem,
  enqueueOperationalRun,
  finishOperationalQueueItem,
  getOperationalQueueItemForRun,
  getWorkspaceProfile,
  listOperationalQueueItems,
  resumeBlockedOperationalQueueItem,
  startOperationalQueueItem,
} from './operational-queue-store.ts'
import {
  applyOperationalQueueSettings,
  resolveOperationalAutonomyCeiling,
} from './operational-queue-controls.ts'

const AUTOMATION_WORKSPACE_PROFILE_ID = 'automation-workspace'
const PROJECT_WORKSPACE_PROFILE_ID = 'project-workspace'

function automationWorkspaceProfileId(automation: AutomationDetail, kind: AutomationRunKind) {
  if (kind === 'execution' && automation.executionMode === 'scoped_execution') return PROJECT_WORKSPACE_PROFILE_ID
  return AUTOMATION_WORKSPACE_PROFILE_ID
}

function requestedAutonomyForAutomation(automation: AutomationDetail, kind: AutomationRunKind): AutonomyLevel {
  if (kind === 'heartbeat') return 'observe'
  if (kind === 'enrichment') return 'draft'
  return automation.autonomyPolicy === 'mostly-autonomous' ? 'supervised' : 'approve'
}

function writeCapableAutomationRun(automation: AutomationDetail, kind: AutomationRunKind) {
  return kind === 'execution' && automation.executionMode === 'scoped_execution'
}

function automationQueueProjectId(automation: AutomationDetail) {
  return automation.projectDirectory || `automation:${automation.id}`
}

function automationGlobalMaxAutonomy(automation: AutomationDetail): AutonomyLevel {
  return automation.autonomyPolicy === 'mostly-autonomous' ? 'supervised' : 'approve'
}

function terminalOperationalStatus(status: AutomationRun['status']): Exclude<OperationalQueueItem['status'], 'queued' | 'running' | 'blocked'> | null {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return null
}

export function enqueueAutomationOperationalQueueItem(automation: AutomationDetail, run: AutomationRun, options: {
  runKind?: 'automation' | 'sop'
} = {}) {
  const workspaceProfileId = automationWorkspaceProfileId(automation, run.kind)
  if (!getWorkspaceProfile(workspaceProfileId)) {
    throw new Error(`Workspace profile ${workspaceProfileId} does not exist.`)
  }
  const writeCapable = writeCapableAutomationRun(automation, run.kind)
  return enqueueOperationalRun({
    runKind: options.runKind || 'automation',
    runId: run.id,
    title: run.title,
    requestedAutonomy: requestedAutonomyForAutomation(automation, run.kind),
    globalMaxAutonomy: resolveOperationalAutonomyCeiling(automationGlobalMaxAutonomy(automation)),
    workspaceProfileId,
    projectId: writeCapable ? automationQueueProjectId(automation) : null,
    externalSystemIds: [],
    writeCapable,
    caps: applyOperationalQueueSettings({
      maxParallel: 1,
      maxRunDurationMinutes: automation.runPolicy.maxRunDurationMinutes,
      maxCostUsd: null,
      maxRetries: automation.retryPolicy.maxRetries,
    }, { writeCapable }),
  })
}

export function getAutomationOperationalQueueItem(runId: string) {
  return getOperationalQueueItemForRun('automation', runId) || getOperationalQueueItemForRun('sop', runId)
}

export function listQueuedAutomationOperationalQueueItems() {
  return listOperationalQueueItems()
    .filter((item) => (item.runKind === 'automation' || item.runKind === 'sop') && item.status === 'queued')
}

export function startAutomationOperationalQueueItem(runId: string) {
  const item = getAutomationOperationalQueueItem(runId)
  if (!item) return null
  return startOperationalQueueItem(item.id)
}

export function syncAutomationOperationalQueueStatus(run: AutomationRun | null, summary?: string | null) {
  if (!run) return null
  const item = getAutomationOperationalQueueItem(run.id)
  if (!item) return null
  const terminal = terminalOperationalStatus(run.status)
  if (terminal) {
    return finishOperationalQueueItem(item.id, terminal, {
      error: terminal === 'failed' || terminal === 'cancelled' ? summary || run.error : null,
    })
  }
  if (run.status === 'needs_user') {
    return blockOperationalQueueItem(item.id, summary || run.summary || 'Automation run is waiting for user input.')
  }
  if (run.status === 'running' && item.status === 'blocked') {
    return resumeBlockedOperationalQueueItem(item.id)
  }
  return getAutomationOperationalQueueItem(run.id)
}
