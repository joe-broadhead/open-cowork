/**
 * Work-route presentation, validation, and gate helpers (LOC façade split).
 * Leaf relative to work.ts — routes stay in work.ts; pure/response shaping lives here.
 */
import { createHash } from 'node:crypto'
import { HttpError, json } from '../daemon-router.js'
import {
  getConfig,
  updateSchedulerConfig,
  validateAgentTeamConfig,
  validateProfileConfig,
  type AgentTeamConfig,
} from '../config.js'
import { getSchedulerLeaseSummary, resolveTaskStageAgent, schedulerCycle } from '../scheduler.js'
import {
  appendAuditEvent,
  createHumanGate,
  getHumanGate,
  listRoadmapSupervisors,
  listWorkTaskViews,
  loadWorkState,
  summarizeWorkTasks,
  type DelegatedWorkReceipt,
  type HumanGateType,
  type TaskDispatchAcquisitionKind,
  type TaskDispatchAcquisitionRecord,
  type WorkEnvironmentAction,
} from '../work-store.js'
import { getPromotionState, type PromotionSubjectKind } from '../work-store/promotions.js'
import type { WorkStoreProjectBindingFilter } from '../work-store/bindings-port.js'
import { isActiveTaskStatus } from '../task-summary.js'
import { formatProjectStatus, getProjectStatus, type ProjectContextInput } from '../project-ux.js'
import { channelTargetLabel, isTrustedChannelTarget, redactSensitiveObject } from '../security.js'
import { redactEnvironmentRecord } from '../environments.js'
import { summarizeRuntimeIsolationProfile } from '../runtime-isolation.js'
import { previewBlueprint, type BlueprintDefinition } from '../blueprints.js'
import {
  failClosedWarnings,
  formatAccessValidationError,
  inspectOpenCodeAvailability,
  inspectProfileAccess,
  inspectTeamAccess,
} from '../access-inspection.js'
import { httpCallerIdentity, httpRequestSource } from './http-guardrails.js'

export function compactTask(task: any): any {
  return {
    id: task.id,
    roadmapId: task.roadmapId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    agent: task.agent,
    agentTeam: task.agentTeam,
    stageProfiles: task.stageProfiles,
    environment: redactEnvironmentValue(task.environment),
    pipeline: task.pipeline,
    currentStage: task.currentStage,
    attempts: task.attempts,
    note: task.note,
    earliestStartAt: task.earliestStartAt,
    deadlineAt: task.deadlineAt,
    recurrence: task.recurrence,
    manualGate: task.manualGate,
    slaClass: task.slaClass,
    qualitySpec: task.qualitySpec,
    readiness: task.readiness,
    dependencies: task.dependencies,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    activeRun: task.activeRun ? compactRun(task.activeRun) : undefined,
    lastRun: task.lastRun ? compactRun(task.lastRun) : undefined,
  }
}

export function exposeTask(task: any): any {
  return task ? { ...task, environment: redactEnvironmentValue(task.environment) } : task
}

export function compactRoadmap(roadmap: any): any {
  return roadmap ? { ...roadmap, environment: redactEnvironmentValue(roadmap.environment) } : roadmap
}

export function compactRun(run: any): any {
  const result = run.result ? redactSensitiveObject({
    status: run.result.status,
    summary: run.result.summary,
    feedback: run.result.feedback,
    failureClass: run.result.failureClass,
    artifacts: run.result.artifacts,
    evidence: (run.result.evidence || []).slice(0, 20),
    decisions: run.result.decisions,
  }, getConfig()) : undefined
  return {
    id: run.id,
    taskId: run.taskId,
    stage: run.stage,
    sessionId: run.sessionId,
    profile: run.profile,
    agentTeam: run.agentTeam,
    agentTeamVersion: run.agentTeamVersion,
    resolvedProfile: run.resolvedProfile,
    resolvedAgent: run.resolvedAgent,
    environment: redactEnvironmentValue(run.environment),
    runtimeProfile: summarizeRuntimeIsolationProfile(run.runtimeProfile, run.environment),
    status: run.status,
    attempt: run.attempt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    leaseOwner: run.leaseOwner,
    leaseExpiresAt: run.leaseExpiresAt,
    schedulerGeneration: run.schedulerGeneration,
    costUsd: run.costUsd,
    tokens: {
      input: run.inputTokens || 0,
      output: run.outputTokens || 0,
      reasoning: run.reasoningTokens || 0,
      cacheRead: run.cacheReadTokens || 0,
      cacheWrite: run.cacheWriteTokens || 0,
    },
    runtimeMs: run.runtimeMs,
    result,
  }
}

export function compactEnvironment(environment: any): any {
  return redactEnvironmentValue(environment)
}

export function compactTaskDispatchAcquisition(acquisition: TaskDispatchAcquisitionRecord): any {
  return {
    dispatchId: acquisition.dispatchId,
    dispatchStatus: acquisition.dispatchStatus,
    taskId: acquisition.taskId,
    stage: acquisition.stage,
    kind: acquisition.kind,
    status: acquisition.status,
    provider: acquisition.provider,
    idempotencyKey: acquisition.idempotencyKey,
    resourceId: acquisition.resourceId,
    resource: acquisition.resource ? redactSensitiveObject(redactEnvironmentValue(acquisition.resource), getConfig()) : undefined,
    metadata: redactSensitiveObject(acquisition.metadata, getConfig()),
    leaseOwner: acquisition.leaseOwner,
    leaseExpiresAt: acquisition.leaseExpiresAt,
    leadershipScope: acquisition.leadershipScope,
    hasLeader: Boolean(acquisition.leaderId),
    hasFencingToken: Boolean(acquisition.fencingToken),
    createdAt: acquisition.createdAt,
    updatedAt: acquisition.updatedAt,
    error: acquisition.error,
  }
}

export function projectProfiles(profiles: Record<string, any>): Record<string, any> {
  const config = getConfig()
  const availability = inspectOpenCodeAvailability(config.opencodeConfigDir)
  return Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, projectProfile(name, profile, config, availability)]))
}

export function projectProfile(name: string, profile: any, config = getConfig(), availability = inspectOpenCodeAvailability(config.opencodeConfigDir)): any {
  return { ...profile, promotion: compactPromotionState('profile', name), inspection: inspectProfileAccess(name, profile, { config, availability }) }
}

export function projectAgentTeams(teams: Record<string, any>): Record<string, any> {
  const config = getConfig()
  const availability = inspectOpenCodeAvailability(config.opencodeConfigDir)
  return Object.fromEntries(Object.entries(teams).map(([name, team]) => [name, projectAgentTeam(name, team, config, availability)]))
}

export function projectAgentTeam(name: string, team: any, config = getConfig(), availability = inspectOpenCodeAvailability(config.opencodeConfigDir)): any {
  return { ...team, promotion: compactPromotionState('team', name), inspection: inspectTeamAccess(name, team, { config, availability }) }
}

export function compactPromotionState(subjectKind: PromotionSubjectKind, subjectName: string): any {
  const promotion = getPromotionState(subjectKind, subjectName)
  return {
    state: promotion.state,
    scorecardId: promotion.scorecard?.id,
    recommendation: promotion.scorecard?.recommendation,
    regression: promotion.scorecard?.regression,
    decisionId: promotion.decision?.id,
    rollback: promotion.rollback,
    updatedAt: promotion.decision?.updatedAt || promotion.scorecard?.updatedAt,
  }
}

export function promotionSubjectKindFromValue(value: unknown): PromotionSubjectKind | undefined {
  if (value === 'profile' || value === 'team') return value
  if (value === undefined || value === null || value === '') return undefined
  throw new HttpError(400, 'subjectKind must be profile or team')
}

export function normalizeEnvironmentAction(value: unknown): WorkEnvironmentAction {
  if (value === 'retain' || value === 'release' || value === 'abort' || value === 'cleanup') return value
  throw new HttpError(400, 'environment action must be retain, release, abort, or cleanup')
}

export function taskDispatchAcquisitionKind(value: unknown): TaskDispatchAcquisitionKind {
  if (value === 'environment' || value === 'session') return value
  throw new HttpError(400, 'dispatch acquisition kind must be environment or session')
}

export function optionalTaskDispatchAcquisitionKind(value: unknown): TaskDispatchAcquisitionKind | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return taskDispatchAcquisitionKind(value)
}

export function redactEnvironmentValue(value: any): any {
  return value === undefined ? undefined : redactEnvironmentRecord(value)
}

export function validateAgentTeamBody(body: any): { ok: true; name: string; agentTeam: AgentTeamConfig; resolution?: ReturnType<typeof resolveTaskStageAgent> } {
  const name = normalizeAgentTeamRouteName(body.name)
  try {
    const agentTeam = validateAgentTeamConfig(name, agentTeamDefinitionFromBody(body))
    const config = getConfig()
    const inspection = inspectTeamAccess(name, agentTeam, { config: { ...config, agentTeams: { ...config.agentTeams, [name]: agentTeam } } })
    if (failClosedWarnings(inspection).length) throw new Error(formatAccessValidationError(inspection))
    const resolution = body.taskId && body.stage ? validateAgentTeamDispatch(name, agentTeam, String(body.taskId), String(body.stage)) : undefined
    return { ok: true, name, agentTeam: { ...agentTeam, inspection } as any, resolution }
  } catch (err: any) {
    throw new HttpError(422, err?.message || String(err))
  }
}

export function validateProfileForRoute(name: string, body: any): any {
  try {
    const profile = validateProfileConfig(name, body)
    const config = getConfig()
    const inspection = inspectProfileAccess(name, profile, { config: { ...config, profiles: { ...config.profiles, [name]: profile } } })
    if (failClosedWarnings(inspection).length) throw new Error(formatAccessValidationError(inspection))
    return profile
  } catch (err: any) {
    throw new HttpError(422, err?.message || String(err))
  }
}

export function validateAgentTeamDispatch(name: string, agentTeam: AgentTeamConfig, taskId: string, stage: string): ReturnType<typeof resolveTaskStageAgent> {
  const state = loadWorkState()
  const task = state.tasks.find(row => row.id === taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const config = getConfig()
  return resolveTaskStageAgent({ ...task, agentTeam: task.agentTeam || name }, state, stage, { ...config, agentTeams: { ...config.agentTeams, [name]: agentTeam } })
}

export function agentTeamDefinitionFromBody(body: any): Partial<AgentTeamConfig> {
  const source = body?.team && typeof body.team === 'object' && !Array.isArray(body.team) ? body.team : body
  const { name: _name, gateId: _gateId, approvedGateId: _approvedGateId, taskId: _taskId, roadmapId: _roadmapId, stage: _stage, ...team } = source || {}
  return team
}

export function blueprintDefinitionFromBody(body: any): BlueprintDefinition {
  const source = body?.blueprint && typeof body.blueprint === 'object' && !Array.isArray(body.blueprint) ? body.blueprint : body
  return source as BlueprintDefinition
}

export function normalizeAgentTeamRouteName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'agent team name required')
  const name = value.trim()
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new HttpError(400, 'agent team name must be 1-64 letters, numbers, underscores, or dashes')
  return name
}

export function requireApprovedAgentTeamGate(req: any, operation: string, name: string, body: any, details: Record<string, unknown>) {
  const gateId = String(body.gateId || body.approvedGateId || '')
  const scopeKey = agentTeamScopeKey(operation, name)
  if (!gateId) return createHumanGate(agentTeamGateInput(operation, name, req, details))
  const gate = getHumanGate(gateId)
  if (!gate) throw new HttpError(404, 'agent team human gate not found')
  if (gate.scopeKey !== scopeKey) throw new HttpError(403, 'agent team human gate scope mismatch')
  if (gate.status !== 'approved') throw new HttpError(409, 'agent team human gate is not approved')
  return undefined
}

export function agentTeamGateInput(operation: string, name: string, req: any, details: Record<string, unknown>) {
  const identity = httpCallerIdentity(req)
  return {
    type: 'manual' as const,
    reason: `Approve agent team ${operation}: ${name}`,
    requestedBy: identity.actor,
    scopeKey: agentTeamScopeKey(operation, name),
    details: { operation, agentTeam: name, ...details, ...(identity.claimedActor ? { claimedActor: identity.claimedActor } : {}) },
  }
}

export function agentTeamScopeKey(operation: string, name: string): string {
  return `agent_team:${operation}:${name}`
}

/**
 * Which trust surface is approving a human gate. The MCP proxy tags its requests
 * with Gateway-owned request headers; body source/actor fields are ignored so a
 * caller cannot self-identify as a different approval surface in JSON.
 */
export function gateApproverSurface(req: any, body: any): string {
  void body
  return httpCallerIdentity(req).actor === 'mcp' ? 'mcp' : 'http'
}

export function gateApproverIdentity(req: any, approverSurface: string): { actor: string; source: string } {
  if (approverSurface === 'mcp') return { actor: 'mcp', source: 'mcp' }
  const fingerprint = bearerFingerprint(req?.headers?.authorization)
  if (fingerprint) return { actor: `http-token:${fingerprint}`, source: 'http-token' }
  return { actor: 'http', source: 'http' }
}

export function bearerFingerprint(header: unknown): string | undefined {
  const value = Array.isArray(header) ? header[0] : header
  const match = String(value || '').match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : undefined
}

/**
 * Human-gate types that authorize an *external effect* (destroying state,
 * acting outside the sandbox, spending beyond budget, or using a credential).
 * A gate of one of these types must not be self-approved through the same MCP
 * surface an agent controls — that is the confused-deputy path where a delegated
 * agent rubber-stamps its own authority. Workflow-only gates (task_start,
 * stage_transition, manual) do not authorize external effects and stay
 * MCP-approvable.
 */
const EXTERNAL_AUTHORITY_GATE_TYPES: ReadonlySet<HumanGateType> = new Set([
  'destructive_action',
  'external_side_effect',
  'budget_exception',
  'credential_use',
])

/**
 * SEC2: when security.requireNonMcpDestructiveApproval is on, a gate that
 * authorizes an external effect cannot be approved through the MCP proxy trust
 * tier; the operator must approve out-of-band (HTTP/CLI). Enabled by default for
 * new configs. (The flag name is retained; its scope is every
 * external-authority gate type, not only destructive_action.)
 */
export function rejectMcpExternalAuthorityGateApproval(gateId: string, body: any, approverSurface: string) {
  if (!getConfig().security.requireNonMcpDestructiveApproval) return null
  if (String(body?.decision) !== 'approve') return null
  if (approverSurface !== 'mcp') return null
  const gate = getHumanGate(gateId)
  if (!gate || !EXTERNAL_AUTHORITY_GATE_TYPES.has(gate.type)) return null
  appendAuditEvent({ actor: 'mcp', source: 'mcp', operation: 'human_gate.approve.denied_non_mcp_required', target: gateId, result: 'denied', details: { gateType: gate.type } })
  return json({
    error: 'external-authority gate approval must come from a non-MCP surface',
    message: `security.requireNonMcpDestructiveApproval rejects human-gate approvals that authorize external effects (here: ${gate.type}) when they arrive through the MCP proxy trust tier; approve this gate from the operator HTTP or CLI surface instead.`,
    gateId,
  }, 403)
}

export function requireApprovedBlueprintGate(req: any, preview: ReturnType<typeof previewBlueprint>, body: any) {
  const gateId = String(body.gateId || body.approvedGateId || '')
  const scopeKey = blueprintScopeKey(preview.blueprint.name, preview.blueprint.version, preview.blueprint.revision)
  if (!gateId) {
    return createHumanGate({
      type: 'manual',
      reason: `Approve blueprint apply: ${preview.blueprint.name}@${preview.blueprint.version}`,
      requestedBy: httpCallerIdentity(req).actor,
      scopeKey,
      details: { operation: 'apply', blueprint: preview.blueprint, diff: preview.diff, rollback: preview.rollback },
    })
  }
  const gate = getHumanGate(gateId)
  if (!gate) throw new HttpError(404, 'blueprint human gate not found')
  if (gate.scopeKey !== scopeKey) throw new HttpError(403, 'blueprint human gate scope mismatch')
  if (gate.status !== 'approved') throw new HttpError(409, 'blueprint human gate is not approved')
  return undefined
}

export function blueprintScopeKey(name: string, version: string, revision: string): string {
  return `blueprint:apply:${name}:${version}:${revision}`
}

export function blueprintWithExpectedStateFromGate(blueprint: BlueprintDefinition, gate: ReturnType<typeof getHumanGate>): BlueprintDefinition {
  if (!gate) throw new HttpError(404, 'blueprint human gate not found')
  const diff = Array.isArray(gate.details?.['diff']) ? gate.details['diff'] : undefined
  if (!diff) throw new HttpError(409, 'blueprint human gate is missing preview diff; preview and approve again')
  const expected: NonNullable<BlueprintDefinition['expected']> = { profiles: {}, teams: {} }
  for (const entry of diff as any[]) {
    if (entry?.target === 'profile' && typeof entry.name === 'string') expected.profiles![entry.name] = typeof entry.beforeRevision === 'string' ? entry.beforeRevision : 'missing'
    if (entry?.target === 'agentTeam' && typeof entry.name === 'string') expected.teams![entry.name] = typeof entry.beforeRevision === 'string' ? entry.beforeRevision : 'missing'
  }
  return { ...blueprint, expected }
}

export function agentTeamReferences(name: string): { roadmapIds: string[]; taskIds: string[] } {
  const state = loadWorkState()
  return {
    roadmapIds: state.roadmaps.filter(row => row.agentTeam === name).map(row => row.id),
    taskIds: state.tasks.filter(row => row.agentTeam === name).map(row => row.id),
  }
}

export function agentTeamBindTarget(body: any): { kind: 'roadmap' | 'task'; id: string } {
  const roadmapId = typeof body.roadmapId === 'string' && body.roadmapId.trim() ? body.roadmapId.trim() : undefined
  const taskId = typeof body.taskId === 'string' && body.taskId.trim() ? body.taskId.trim() : undefined
  if (Boolean(roadmapId) === Boolean(taskId)) throw new HttpError(400, 'exactly one of roadmapId or taskId is required')
  return roadmapId ? { kind: 'roadmap', id: roadmapId } : { kind: 'task', id: taskId! }
}

export function auditAgentTeam(req: any, operation: string, target: string, result: 'ok' | 'denied' | 'error', details: Record<string, unknown> = {}): void {
  try {
    const identity = httpCallerIdentity(req)
    appendAuditEvent({
      actor: identity.actor,
      source: httpRequestSource(req),
      operation,
      target,
      result,
      details: identity.claimedActor ? { ...details, claimedActor: identity.claimedActor } : details,
    })
  } catch {}
}

export async function abortSessions(client: any, sessionIds: string[]): Promise<void> {
  const { createOpenCodeSessionRuntime } = await import('../opencode-session-runtime.js')
  const runtime = createOpenCodeSessionRuntime(client)
  for (const id of [...new Set(sessionIds.filter(Boolean))]) {
    await runtime.abort(id)
  }
}

export async function handleSchedulerAction(action: 'pause' | 'resume' | 'run', client: any) {
  if (action === 'pause') return json({ scheduler: updateSchedulerConfig({ enabled: false }) })
  if (action === 'resume') return json({ scheduler: updateSchedulerConfig({ enabled: true }) })
  const state = await schedulerCycle(client)
  const tasks = listWorkTaskViews(state)
  return json({
    scheduler: getConfig().scheduler,
    counts: summarizeWorkTasks(tasks),
    leases: getSchedulerLeaseSummary(state),
    activeTasks: tasks.filter(task => isActiveTaskStatus(task.status)).map(compactTask),
    recentRuns: state.runs.slice(-5).map(compactRun),
  })
}

export function projectContextFromUrl(url: URL): ProjectContextInput {
  return {
    alias: url.searchParams.get('alias') || undefined,
    roadmapId: url.searchParams.get('roadmapId') || undefined,
    provider: url.searchParams.get('provider') || undefined,
    chatId: url.searchParams.get('chatId') || undefined,
    threadId: url.searchParams.has('threadId') ? url.searchParams.get('threadId') || '' : undefined,
    sessionId: url.searchParams.get('sessionId') || undefined,
  }
}

export function projectContextFromBody(body: any): ProjectContextInput {
  return {
    alias: body.alias,
    roadmapId: body.roadmapId,
    provider: body.provider,
    chatId: body.chatId,
    threadId: body.threadId,
    sessionId: body.sessionId,
  }
}

export function projectCreateReplayFromReceipt(receipt: DelegatedWorkReceipt): Record<string, unknown> {
  if (receipt.targetType !== 'project_create') throw new HttpError(409, `idempotency key already used for ${receipt.targetType}`)
  const state = loadWorkState()
  const roadmap = receipt.roadmapId ? state.roadmaps.find(row => row.id === receipt.roadmapId) : undefined
  if (!roadmap) throw new HttpError(409, `project create receipt references a missing roadmap: ${receipt.idempotencyKey}`)
  const taskIds = new Set(receipt.taskIds)
  const tasks = state.tasks.filter(task => task.roadmapId === roadmap.id && (!taskIds.size || taskIds.has(task.id)))
  const supervisor = listRoadmapSupervisors({ roadmapId: roadmap.id })[0]
  const binding = receipt.projectBindingId
    ? state.projectBindings.find(row => row.id === receipt.projectBindingId)
    : state.projectBindings.find(row => row.roadmapId === roadmap.id)
  if (!binding) throw new HttpError(409, `project create receipt references a missing binding: ${receipt.idempotencyKey}`)
  const status = getProjectStatus({ alias: binding.alias })
  return {
    roadmap: compactRoadmap(roadmap),
    tasks: tasks.map(compactTask),
    supervisor,
    binding,
    status,
    text: formatProjectStatus(status),
    idempotencyStatus: 'replayed',
  }
}

export function projectSurfaceFilter(body: any, sessionId: string): WorkStoreProjectBindingFilter {
  if (body.provider && body.chatId) return { provider: body.provider, chatId: body.chatId, threadId: body.threadId || '' }
  if (body.scope === 'opencode') return { scope: 'opencode', sessionId }
  if (body.scope === 'telegram' || body.scope === 'whatsapp' || body.scope === 'discord') return { scope: body.scope, provider: body.provider, chatId: body.chatId, threadId: body.threadId || '' }
  return { scope: body.scope || 'global', alias: body.alias }
}

export type ProjectBindingRouteScope = 'global' | 'opencode' | 'telegram' | 'whatsapp' | 'discord'

export function projectBindingScopeFromBody(body: any): ProjectBindingRouteScope {
  if (body.scope === 'global' || body.scope === 'opencode' || body.scope === 'telegram' || body.scope === 'whatsapp' || body.scope === 'discord') return body.scope
  if (body.scope !== undefined && body.scope !== null && body.scope !== '') throw new HttpError(400, 'scope must be global, opencode, telegram, whatsapp, or discord')
  if (body.provider === 'telegram' || body.provider === 'whatsapp' || body.provider === 'discord') return body.provider
  return 'global'
}

export function validateProjectBindingSurfaceBody(body: any, scope: ProjectBindingRouteScope): void {
  if ((scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') && !body.chatId) throw new HttpError(400, 'chatId required for channel project bindings')
  if ((scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') && body.provider && body.provider !== scope) throw new HttpError(400, `provider must match project binding scope: ${scope}`)
  if (scope !== 'telegram' && scope !== 'whatsapp' && scope !== 'discord' && (body.provider || body.chatId || body.threadId)) throw new HttpError(400, 'provider, chatId, and threadId are only valid for channel project bindings')
  if (scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') {
    const provider = String(body.provider || scope)
    const chatId = String(body.chatId || '')
    const threadId = body.threadId === undefined || body.threadId === null ? undefined : String(body.threadId)
    if (!isTrustedChannelTarget(provider, chatId, threadId, getConfig())) throw new HttpError(403, `channel target is not trusted: ${channelTargetLabel(provider, chatId, threadId)}`)
  }
}

export async function createProjectSession(client: any, alias: string, title: string): Promise<string> {
  if (!client?.session?.create) throw new HttpError(400, 'sessionId required when OpenCode client session creation is unavailable')
  const session = await (await import('../opencode-session-runtime.js')).createOpenCodeSessionRuntime(client).createSession({
    title: `GW:project:${alias}: ${title}`.substring(0, 200),
  })
  if (!session.id) throw new HttpError(502, 'OpenCode session creation returned no id')
  return session.id
}

/**
 * A destructive route serves a mutation-free blast-radius preview instead of
 * acting when the caller opts into dry-run via ?dryRun=true / ?preview=true or a
 * { dryRun: true } / { preview: true } body field. Absent the opt-in, behavior is
 * identical to before.
 */
export function wantsDryRun(url: URL, body?: any): boolean {
  const flag = url.searchParams.get('dryRun') || url.searchParams.get('preview')
  if (flag === 'true' || flag === '1') return true
  return body?.dryRun === true || body?.preview === true
}
