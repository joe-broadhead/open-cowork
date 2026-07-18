import type { GatewayConfig } from './config.js'
import type { ChannelSyncSummary } from './channel-sync.js'
import type { HumanGateRecord, RunRecord, TaskDispatchReceiptRecord, WorkState, WorkTaskRecord } from './work-store.js'

export type CapacityDimension = 'global' | 'stage' | 'profile' | 'team' | 'roadmap' | 'channel' | 'environment'

export interface CapacityAdmission {
  allowed: boolean
  dimension: CapacityDimension
  key: string
  reason: string
  used: number
  limit: number
}

export interface CapacitySelection {
  task: WorkTaskRecord
  stage: string
  profileName: string
  agentTeamName?: string
}

export interface CapacityReportRow {
  dimension: CapacityDimension
  key: string
  used: number
  limit: number
  pending: number
  status: 'ok' | 'full' | 'pressure'
}

export interface GatewayCapacityReport {
  generatedAt: string
  scheduler: {
    running: number
    starting: number
    maxConcurrent: number
    availableSlots: number
    pending: number
    oldestPending?: { id: string; title: string; ageMs: number; reason: string }
  }
  dimensions: CapacityReportRow[]
  providerBackoff: Array<{ provider: string; retryAfter: string; pending: number; lastError?: string }>
  humanGatePressure: number
}

interface CapacityUnit {
  taskId: string
  roadmapId: string
  stage: string
  profileName: string
  teamName?: string
  channelProviders: string[]
}

export function decideTaskCapacityAdmission(input: {
  task: WorkTaskRecord
  stage: string
  profileName: string
  agentTeamName?: string
  state: WorkState
  config: GatewayConfig
  startingReceipts?: TaskDispatchReceiptRecord[]
  selected?: CapacitySelection[]
}): CapacityAdmission {
  const units = activeCapacityUnits(input.state, input.startingReceipts || [], input.selected || [])
  const selectedCount = input.selected?.length || 0
  const running = input.state.runs.filter(run => run.status === 'running').length
  const starting = (input.startingReceipts || []).length
  const globalUsed = running + starting + selectedCount
  if (globalUsed >= input.config.scheduler.maxConcurrent) {
    return blocked('global', 'scheduler', globalUsed, input.config.scheduler.maxConcurrent)
  }

  const taskUnit = capacityUnitForTask(input.task, input.state, input.stage, input.profileName, input.agentTeamName)
  const stageLimit = input.config.scheduler.stageConcurrency[input.stage]
  if (stageLimit && countUnits(units, unit => unit.stage === input.stage) >= stageLimit) {
    return blocked('stage', input.stage, countUnits(units, unit => unit.stage === input.stage), stageLimit)
  }

  const profileLimit = input.config.scheduler.profileConcurrency[input.profileName]
  if (profileLimit && countUnits(units, unit => unit.profileName === input.profileName) >= profileLimit) {
    return blocked('profile', input.profileName, countUnits(units, unit => unit.profileName === input.profileName), profileLimit)
  }

  const teamName = taskUnit.teamName
  const teamLimit = teamName ? input.config.scheduler.capacity?.teamConcurrency?.[teamName] : undefined
  if (teamName && teamLimit && countUnits(units, unit => unit.teamName === teamName) >= teamLimit) {
    return blocked('team', teamName, countUnits(units, unit => unit.teamName === teamName), teamLimit)
  }

  const roadmapLimit = input.config.scheduler.capacity?.roadmapConcurrency?.[input.task.roadmapId]
  if (roadmapLimit && countUnits(units, unit => unit.roadmapId === input.task.roadmapId) >= roadmapLimit) {
    return blocked('roadmap', input.task.roadmapId, countUnits(units, unit => unit.roadmapId === input.task.roadmapId), roadmapLimit)
  }

  for (const provider of taskUnit.channelProviders) {
    const limit = input.config.scheduler.capacity?.channelConcurrency?.[provider]
    if (!limit) continue
    const used = countUnits(units, unit => unit.channelProviders.includes(provider))
    if (used >= limit) return blocked('channel', provider, used, limit)
  }

  return { allowed: true, dimension: 'global', key: 'scheduler', reason: 'capacity available', used: globalUsed, limit: input.config.scheduler.maxConcurrent }
}

export function buildCapacityReport(input: {
  state: WorkState
  config: GatewayConfig
  startingReceipts?: TaskDispatchReceiptRecord[]
  channelSync?: ChannelSyncSummary
  humanGates?: HumanGateRecord[]
  now?: number
}): GatewayCapacityReport {
  const now = input.now || Date.now()
  const starting = input.startingReceipts || []
  const runningRuns = input.state.runs.filter(run => run.status === 'running')
  const units = activeCapacityUnits(input.state, starting, [])
  const pendingTasks = input.state.tasks.filter(task => task.status === 'pending' && !task.currentRunId)
  const dimensions: CapacityReportRow[] = []
  const addRow = (dimension: CapacityDimension, key: string, used: number, limit: number, pending: number) => {
    dimensions.push({ dimension, key, used, limit, pending, status: used >= limit ? 'full' : pending > 0 && used > 0 ? 'pressure' : 'ok' })
  }

  addRow('global', 'scheduler', runningRuns.length + starting.length, input.config.scheduler.maxConcurrent, pendingTasks.length)
  for (const [stage, limit] of Object.entries(input.config.scheduler.stageConcurrency || {})) {
    addRow('stage', stage, countUnits(units, unit => unit.stage === stage), limit, pendingTasks.filter(task => currentStage(task) === stage).length)
  }
  for (const [profile, limit] of Object.entries(input.config.scheduler.profileConcurrency || {})) {
    addRow('profile', profile, countUnits(units, unit => unit.profileName === profile), limit, 0)
  }
  for (const [team, limit] of Object.entries(input.config.scheduler.capacity?.teamConcurrency || {})) {
    addRow('team', team, countUnits(units, unit => unit.teamName === team), limit, pendingTasks.filter(task => taskTeamName(task, input.state) === team).length)
  }
  for (const [roadmapId, limit] of Object.entries(input.config.scheduler.capacity?.roadmapConcurrency || {})) {
    addRow('roadmap', roadmapId, countUnits(units, unit => unit.roadmapId === roadmapId), limit, pendingTasks.filter(task => task.roadmapId === roadmapId).length)
  }
  for (const [provider, limit] of Object.entries(input.config.scheduler.capacity?.channelConcurrency || {})) {
    addRow('channel', provider, countUnits(units, unit => unit.channelProviders.includes(provider)), limit, pendingTasks.filter(task => taskChannelProviders(task, input.state).includes(provider)).length)
  }

  const oldestPending = pendingTasks
    .map(task => ({ task, ageMs: Math.max(0, now - Date.parse(task.createdAt || new Date(now).toISOString())) }))
    .sort((a, b) => b.ageMs - a.ageMs)[0]

  return {
    generatedAt: new Date(now).toISOString(),
    scheduler: {
      running: runningRuns.length,
      starting: starting.length,
      maxConcurrent: input.config.scheduler.maxConcurrent,
      availableSlots: Math.max(0, input.config.scheduler.maxConcurrent - runningRuns.length - starting.length),
      pending: pendingTasks.length,
      oldestPending: oldestPending ? { id: oldestPending.task.id, title: oldestPending.task.title, ageMs: oldestPending.ageMs, reason: oldestPending.task.note || 'pending capacity/readiness check' } : undefined,
    },
    dimensions,
    providerBackoff: input.channelSync?.outbox?.providerBackoff || [],
    humanGatePressure: input.humanGates?.length || 0,
  }
}

function activeCapacityUnits(state: WorkState, startingReceipts: TaskDispatchReceiptRecord[], selected: CapacitySelection[]): CapacityUnit[] {
  const units: CapacityUnit[] = []
  for (const run of state.runs.filter(row => row.status === 'running')) {
    const task = state.tasks.find(row => row.id === run.taskId)
    if (!task) continue
    units.push(capacityUnitForRun(run, task, state))
  }
  for (const receipt of startingReceipts) {
    const task = state.tasks.find(row => row.id === receipt.taskId)
    if (!task) continue
    units.push(capacityUnitForTask(task, state, receipt.stage, receipt.profile || task.agent))
  }
  for (const row of selected) units.push(capacityUnitForTask(row.task, state, row.stage, row.profileName, row.agentTeamName))
  return units
}

function capacityUnitForRun(run: RunRecord, task: WorkTaskRecord, state: WorkState): CapacityUnit {
  return capacityUnitForTask(task, state, run.stage, run.resolvedProfile || run.profile, run.agentTeam)
}

function capacityUnitForTask(task: WorkTaskRecord, state: WorkState, stage: string, profileName: string, agentTeamName?: string): CapacityUnit {
  return {
    taskId: task.id,
    roadmapId: task.roadmapId,
    stage,
    profileName,
    teamName: agentTeamName || taskTeamName(task, state),
    channelProviders: taskChannelProviders(task, state),
  }
}

function taskTeamName(task: WorkTaskRecord, state: WorkState): string | undefined {
  return task.agentTeam || state.roadmaps.find(row => row.id === task.roadmapId)?.agentTeam
}

function taskChannelProviders(task: WorkTaskRecord, state: WorkState): string[] {
  return [...new Set(state.projectBindings
    .filter(binding => binding.roadmapId === task.roadmapId && binding.provider && binding.chatId)
    .map(binding => String(binding.provider)))]
}

function currentStage(task: WorkTaskRecord): string {
  return task.currentStage || task.pipeline[0] || 'implement'
}

function countUnits(units: CapacityUnit[], predicate: (unit: CapacityUnit) => boolean): number {
  return units.filter(predicate).length
}

function blocked(dimension: CapacityDimension, key: string, used: number, limit: number): CapacityAdmission {
  return {
    allowed: false,
    dimension,
    key,
    used,
    limit,
    reason: `capacity.${dimension}_full: ${key} ${used}/${limit}`,
  }
}
