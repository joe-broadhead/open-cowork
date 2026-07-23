/**
 * Pure / near-pure scheduler helpers (LOC façade split).
 * Leaf relative to scheduler.ts — stage resolution, failure classification,
 * dependency source planning, and workdir/tool parsing live here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { getConfig, type AgentProfile, type AgentTeamConfig, type GatewayConfig } from './config.js'
import type { EnvironmentSourcePlan, EnvironmentSpec } from './environments.js'
import { isActiveRunStatus } from './runtime-state-machine.js'
import type { RunAttributionInput, RunRecord, WorkState, WorkTaskRecord } from './work-store.js'
import {
  mergeTaskQualitySpecDefaults,
  profileForStage,
  type FailureClass,
  type StageResult,
  type TaskQualitySpec,
  type WorkflowDecision,
} from './workflow.js'

export type TaskStageResolution =
  | {
      ok: true
      stage: string
      source: string
      profileName: string
      profile: AgentProfile
      agentTeamName?: string
      agentTeam?: AgentTeamConfig
      agentTeamVersion?: string
      qualitySpec?: TaskQualitySpec
    }
  | { ok: false; stage: string; source: string; reason: string; agentTeamName?: string; profileName?: string }

export type RuntimeFailureKind = 'provider_balance' | 'provider_auth' | 'provider_quota' | 'provider_model' | 'transport' | 'unknown'

export function resolveTaskStageAgent(task: WorkTaskRecord, state: WorkState, stage: string, config: GatewayConfig = getConfig()): TaskStageResolution {
  const roadmap = state.roadmaps.find(row => row.id === task.roadmapId)
  const contextTeamName = task.agentTeam || roadmap?.agentTeam
  const contextTeam = contextTeamName ? config.agentTeams[contextTeamName] : undefined
  if (contextTeamName && !contextTeam) return { ok: false, stage, source: task.agentTeam ? 'task.agentTeam' : 'roadmap.agentTeam', reason: `Agent team not found: ${contextTeamName}`, agentTeamName: contextTeamName }

  const taskProfile = profileOverrideForStage(task.stageProfiles, stage)
  if (taskProfile) return validateResolvedProfile(task, stage, 'task.stageProfiles', taskProfile, contextTeamName, contextTeam, config)

  if (task.agentTeam && contextTeam) {
    const profileName = profileForAgentTeamStage(contextTeam, stage)
    if (!profileName) return { ok: false, stage, source: 'task.agentTeam', reason: `Agent team ${task.agentTeam} has no role for stage ${stage}`, agentTeamName: task.agentTeam }
    return validateResolvedProfile(task, stage, 'task.agentTeam', profileName, task.agentTeam, contextTeam, config)
  }

  if (roadmap?.agentTeam) {
    const roadmapTeam = config.agentTeams[roadmap.agentTeam]
    if (!roadmapTeam) return { ok: false, stage, source: 'roadmap.agentTeam', reason: `Agent team not found: ${roadmap.agentTeam}`, agentTeamName: roadmap.agentTeam }
    const profileName = profileForAgentTeamStage(roadmapTeam, stage)
    if (!profileName) return { ok: false, stage, source: 'roadmap.agentTeam', reason: `Agent team ${roadmap.agentTeam} has no role for stage ${stage}`, agentTeamName: roadmap.agentTeam }
    return validateResolvedProfile(task, stage, 'roadmap.agentTeam', profileName, roadmap.agentTeam, roadmapTeam, config)
  }

  return validateResolvedProfile(task, stage, 'scheduler.stageProfiles', profileForStage(stage, config.scheduler), undefined, undefined, config)
}

function validateResolvedProfile(task: WorkTaskRecord, stage: string, source: string, profileName: string, agentTeamName: string | undefined, agentTeam: AgentTeamConfig | undefined, config: GatewayConfig): TaskStageResolution {
  const profile = config.profiles[profileName]
  if (!profile) return { ok: false, stage, source, reason: `Profile not found for stage ${stage}: ${profileName}`, agentTeamName, profileName }
  const missing = missingCapabilities(agentTeam, stage, profile)
  if (missing.length) {
    return { ok: false, stage, source, reason: `Profile ${profileName} does not satisfy agent team ${agentTeamName} requirements for ${stage}: ${missing.join(', ')}`, agentTeamName, profileName }
  }
  const qualitySpec = agentTeam ? mergeTaskQualitySpecDefaults(task.qualitySpec, agentTeam.qualitySpecDefaults) : task.qualitySpec
  return { ok: true, stage, source, profileName, profile, agentTeamName, agentTeam, agentTeamVersion: agentTeam?.revision, qualitySpec }
}

function profileOverrideForStage(stageProfiles: Record<string, string> | undefined, stage: string): string | undefined {
  return stageProfiles?.[stage] || stageProfiles?.['default']
}

function profileForAgentTeamStage(team: AgentTeamConfig, stage: string): string | undefined {
  return team.roles[stage] || team.roles['default']
}

function missingCapabilities(team: AgentTeamConfig | undefined, stage: string, profile: AgentProfile): string[] {
  if (!team) return []
  const required = [...(team.capabilityRequirements['default'] || []), ...(team.capabilityRequirements[stage] || [])]
  return required.filter(capability => !profileHasCapability(profile, capability))
}

function profileHasCapability(profile: AgentProfile, capability: string): boolean {
  if (profile.agent === capability) return true
  if (profile.skills.includes(capability)) return true
  if (profile.capabilities?.includes(capability)) return true
  if (profile.tools?.includes(capability)) return true
  if (profile.mcpServers?.includes(capability)) return true
  const permission = profile.permission || {}
  return permission[capability] === 'allow' || permission[`${capability}_`] === 'allow' || permission[`${capability}_*`] === 'allow'
}

export function priorityRank(priority: string): number {
  return priority === 'HIGH' ? 0 : priority === 'MEDIUM' ? 1 : 2
}

export function deadlineRank(value?: string): number {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER
}

export function dispatchStartLeaseMs(config: { scheduler: { intervalMs: number; leaseMs: number } }, environmentSpec: EnvironmentSpec): number {
  const prepareTimeoutMs = Number(environmentSpec.resources.timeoutMs || 0)
  const schedulerBufferMs = Math.max(config.scheduler.intervalMs * 3, 30_000)
  return Math.max(config.scheduler.leaseMs, prepareTimeoutMs > 0 ? prepareTimeoutMs + schedulerBufferMs : 0)
}

export function classifyRuntimeFailure(message: string): { kind: RuntimeFailureKind; terminal: boolean; summary: string; failureClass: FailureClass; nextAction: string } {
  const text = message.toLowerCase()
  if (/model (not found|not available|unavailable|unknown|unsupported)|provider (not found|not configured|unknown|unsupported|unavailable)|no such model|invalid model|model .*does not exist|provider .*does not exist/.test(text)) return terminalFailure('provider_model', 'Provider/model configuration failure', message, 'needs_credentials', 'Validate the configured provider/model in OpenCode, update the Gateway profile, then retry the task.')
  if (/insufficient balance|billing|payment required|no credits|credit balance|402/.test(text)) return terminalFailure('provider_balance', 'Provider balance or billing failure', message, 'exceeded_budget', 'Top up or rotate the configured model/provider account, then retry the task.')
  if (/unauthorized|forbidden|invalid api key|invalid token|authentication|permission denied|401|403/.test(text)) return terminalFailure('provider_auth', 'Provider authentication failure', message, 'needs_credentials', 'Rotate or fix provider credentials, then retry the task.')
  if (/quota exceeded|rate limit|too many requests|capacity exceeded|429/.test(text)) return terminalFailure('provider_quota', 'Provider quota or rate-limit failure', message, 'exceeded_budget', 'Wait for quota reset or change provider limits before retrying.')
  if (/fetch failed|econnreset|etimedout|timeout|timed out|socket|network|temporar|503|502|504|unavailable/.test(text)) return { kind: 'transport', terminal: false, summary: `Transient OpenCode transport failure: ${shortFailure(message)}`, failureClass: 'flaky_test', nextAction: 'Gateway will retry with bounded backoff; inspect OpenCode/network health if failures repeat.' }
  return { kind: 'unknown', terminal: false, summary: `OpenCode runtime failure: ${shortFailure(message)}`, failureClass: 'flaky_test', nextAction: 'Gateway will retry with bounded backoff; inspect the session and provider logs if failures repeat.' }
}

function terminalFailure(kind: RuntimeFailureKind, label: string, message: string, failureClass: FailureClass, nextAction: string) {
  return { kind, terminal: true, summary: `${label}: ${shortFailure(message)}`, failureClass, nextAction }
}

export function shortFailure(message: string): string {
  return message.replace(/\s+/g, ' ').trim().substring(0, 500)
}

export function evaluateEnvironmentCapacity(environment: EnvironmentSpec, state: WorkState, config: GatewayConfig): { allowed: boolean; reason: string; used: number; limit: number } {
  const active = state.runs.filter(run => run.environment && (isActiveRunStatus(run.status) || run.environment.status === 'retained'))
  const retained = active.filter(run => run.environment?.status === 'retained')
  const retainedLimit = config.environments.maxRetained
  if (retainedLimit === 0 ? retained.length > 0 : retained.length >= retainedLimit) return { allowed: false, reason: `retained environment limit exhausted (${retained.length}/${retainedLimit})`, used: retained.length, limit: retainedLimit }
  const globalLimit = Math.max(1, config.environments.maxConcurrent || config.scheduler.maxConcurrent)
  if (active.length >= globalLimit) return { allowed: false, reason: `environment concurrency exhausted (${active.length}/${globalLimit})`, used: active.length, limit: globalLimit }
  const backendLimit = config.environments.backendMaxConcurrent[environment.backend]
  if (backendLimit) {
    const sameBackend = active.filter(run => run.environment?.backend === environment.backend).length
    if (sameBackend >= backendLimit) return { allowed: false, reason: `environment backend ${environment.backend} concurrency exhausted (${sameBackend}/${backendLimit})`, used: sameBackend, limit: backendLimit }
  }
  const specLimit = environment.resources.maxConcurrent
  if (specLimit) {
    const sameSpec = active.filter(run => run.environment?.specHash === environment.specHash).length
    if (sameSpec >= specLimit) return { allowed: false, reason: `environment ${environment.name} concurrency exhausted (${sameSpec}/${specLimit})`, used: sameSpec, limit: specLimit }
  }
  return { allowed: true, reason: 'environment capacity available', used: active.length, limit: globalLimit }
}

export function dependencyTaskIdsFor(taskId: string, state: WorkState): string[] {
  return (state.dependencies || [])
    .filter(dependency => dependency.taskId === taskId && (dependency.type === 'blocks' || dependency.type === 'blocked_by' || dependency.type === 'parent'))
    .map(dependency => dependency.dependsOnTaskId)
    .sort()
}

export function buildDependencySourcePlan(state: WorkState, workdir: string | undefined, dependencyTaskIds: string[]): EnvironmentSourcePlan {
  const baseRef = sourceBaseRef(workdir)
  if (!dependencyTaskIds.length) return { required: false, baseRef, workdir, dependencyTaskIds: [], patches: [], missing: [] }
  const patches: EnvironmentSourcePlan['patches'] = []
  const missing: EnvironmentSourcePlan['missing'] = []
  for (const dependencyTaskId of dependencyTaskIds) {
    const runs = state.runs
      .filter(run => run.taskId === dependencyTaskId && run.status === 'passed' && run.result)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    const beforeCount = patches.length
    runs.forEach(run => {
      for (const [index, ref] of patchRefsFromRun(run).entries()) {
        const patchPath = resolvePatchPath(ref, workdir)
        if (!patchPath || !fs.existsSync(patchPath)) {
          missing.push({ taskId: dependencyTaskId, reason: `patch artifact not found: ${ref}` })
          continue
        }
        const content = fs.readFileSync(patchPath, 'utf8')
        if (!content.trim()) {
          missing.push({ taskId: dependencyTaskId, reason: `patch artifact is empty: ${ref}` })
          continue
        }
        patches.push({
          id: `${dependencyTaskId}:${run.id}:${index + 1}`,
          taskId: dependencyTaskId,
          runId: run.id,
          stage: run.stage,
          ref,
          path: patchPath,
          content,
          changedFiles: changedFilesFromPatch(content),
        })
      }
    })
    if (patches.length === beforeCount) missing.push({ taskId: dependencyTaskId, reason: 'missing patch artifact' })
  }
  return { required: true, baseRef, workdir, dependencyTaskIds, patches, missing }
}

function patchRefsFromRun(run: RunRecord): string[] {
  if (!run.result) return []
  const refs = [
    ...(run.result.artifacts || []),
    ...(run.result.evidence || []).map(item => item.ref),
  ]
  return uniqueStrings(refs.map(parsePatchRef).filter((ref): ref is string => Boolean(ref)))
}

function parsePatchRef(value: string | undefined): string | undefined {
  const text = String(value || '').trim()
  const prefixed = /^(?:patch|patch-file|diff-file):\s*(.+)$/i.exec(text)
  if (prefixed) return prefixed[1]!.trim()
  return /\.(?:patch|diff)$/i.test(text) ? text : undefined
}

function resolvePatchPath(ref: string, workdir: string | undefined): string | undefined {
  const fileRef = ref.startsWith('file://') ? new URL(ref).pathname : ref
  if (!workdir) return undefined
  const resolved = path.isAbsolute(fileRef) ? fileRef : path.resolve(workdir, fileRef)
  const relative = path.relative(workdir, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return resolved
}

function changedFilesFromPatch(content: string): string[] {
  const files: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const diff = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (diff) files.push(diff[2] === '/dev/null' ? diff[1]! : diff[2]!)
    const added = /^\+\+\+ b\/(.+)$/.exec(line)
    if (added && added[1] !== '/dev/null') files.push(added[1]!)
  }
  return uniqueStrings(files).sort()
}

function sourceBaseRef(workdir: string | undefined): string {
  if (!workdir) return 'none'
  const result = spawnSync('git', ['-C', workdir, 'rev-parse', 'HEAD'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const ref = result.status === 0 ? result.stdout.trim() : ''
  return ref || `workdir:${path.resolve(workdir)}`
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function requiredToolsForTask(task: WorkTaskRecord, qualitySpec: TaskQualitySpec | undefined): string[] {
  const spec = qualitySpec || task.qualitySpec
  const tools = new Set<string>()
  for (const tool of spec?.requiredTools || []) addTool(tools, tool)
  for (const value of [task.note || '', task.description || '', ...(spec?.constraints || []), ...(spec?.systemsTouched || [])]) {
    for (const tool of parseRequiredTools(value)) addTool(tools, tool)
  }
  return [...tools].sort()
}

function parseRequiredTools(value: string): string[] {
  const tools: string[] = []
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:required tools|preflight tools|tools)\s*:\s*(.+?)\s*$/i)
    if (match?.[1]) tools.push(...match[1].split(/[,;]/))
  }
  return tools
}

function addTool(tools: Set<string>, value: string): void {
  const tool = value.replace(/`/g, '').trim().split(/\s+/)[0]?.toLowerCase()
  if (tool) tools.add(tool)
}

export function taskWorkdir(task: WorkTaskRecord | undefined): string | undefined {
  if (!task) return undefined
  const spec = task.qualitySpec
  const candidates = [
    ...(spec?.systemsTouched || []),
    ...(spec?.constraints || []),
    ...(spec?.requiredArtifacts || []),
    task.note || '',
    task.description || '',
  ]
  for (const candidate of candidates) {
    const dir = extractWorkdir(candidate)
    if (dir) return dir
  }
  return undefined
}

export function runWorkdir(run: { environment?: { workdir?: string } } | undefined, task: WorkTaskRecord | undefined): string | undefined {
  return run?.environment?.workdir || taskWorkdir(task)
}

export function extractWorkdir(value: string): string | undefined {
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:workdir|working directory|checkout|directory)\s*:\s*(.+?)\s*$/i)
    const candidate = match?.[1]?.trim()
    if (candidate && path.isAbsolute(candidate)) return canonicalWorkdir(candidate)
  }
  const inline = value.match(/\b(?:workdir|checkout)=([^\s,;]+)/i)?.[1]
  return inline && path.isAbsolute(inline) ? canonicalWorkdir(inline) : undefined
}

export function canonicalWorkdir(directory: string): string {
  try { return fs.realpathSync(directory) } catch { return path.resolve(directory) }
}

export function isNotFoundError(err: any): boolean {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || err?.data?.statusCode || err?.error?.status)
  return status === 404 || /(^|\D)404(\D|$)|not found/i.test(String(err?.message || err))
}

export function sessionAttribution(session: any) {
  const tokens = session?.tokens || {}
  return {
    costUsd: Number(session?.cost || 0),
    inputTokens: Number(tokens.input || 0),
    outputTokens: Number(tokens.output || 0),
    reasoningTokens: Number(tokens.reasoning || 0),
    cacheReadTokens: Number(tokens.cache?.read || 0),
    cacheWriteTokens: Number(tokens.cache?.write || 0),
  }
}

export function latestAssistantError(messages: any[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const role = message?.info?.role || message?.role
    if (role !== 'assistant') continue
    const error = message?.info?.error || message?.error
    if (!error) return undefined
    return formatAssistantError(error)
  }
  return undefined
}

export function formatAssistantError(error: any): string {
  const detail = error?.data?.message || error?.message || error?.name || String(error)
  const status = error?.data?.statusCode ? `HTTP ${error.data.statusCode}: ` : ''
  return `OpenCode assistant error: ${status}${detail}`
}

export function runAttribution(run: RunAttributionInput): RunAttributionInput {
  return {
    costUsd: run.costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    reasoningTokens: run.reasoningTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
  }
}

export function optionalAcquisitionString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function sessionTitle(session: any): string {
  return String(session?.title || session?.info?.title || session?.name || '')
}

export function completionQueueMessage(task: WorkTaskRecord, run: { stage: string }, decision: WorkflowDecision | undefined, result: StageResult): string | undefined {
  if (!decision) return undefined
  if (decision.nextStage) return `Scheduler advanced ${task.title}: ${run.stage} -> ${decision.nextStage}`
  if (decision.retryStage) return `Scheduler retrying ${task.title}: ${run.stage} -> ${decision.retryStage}`
  if (decision.taskStatus === 'done') return `Scheduler completed: ${task.title}`
  if (decision.taskStatus === 'blocked') return `Scheduler blocked ${task.title}: ${decision.blockedReason || result.summary}`
  return undefined
}

