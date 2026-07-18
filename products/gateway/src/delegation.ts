import { z } from 'zod'
import { getConfig, validateAgentTeamConfig } from './config.js'
import { normalizeEnvironmentSelector } from './environments.js'
import {
  createDelegatedWork,
  resolveProjectContext,
  type DelegatedWorkReceipt,
  type ManualGate,
  type ProjectBindingInput,
  type ProjectBindingScope,
  type RoadmapQualitySpec,
  type WorkTaskCreateInput,
} from './work-store.js'
import {
  delegationFailureModes,
  delegationRequestSchema,
  validateDelegationRequest,
  type DelegationFailureMode,
  type DelegationRequest,
} from './delegation-contract.js'
import type { TaskQualitySpec } from './workflow.js'

export interface DelegationSubmitResult {
  ok: boolean
  receipt?: DelegatedWorkReceipt & {
    selectedProfile?: string
    selectedAgentTeam?: string
  }
  failureMode?: DelegationFailureMode
  message?: string
  details?: Record<string, unknown>
}

export function submitDelegation(input: unknown, filePath?: string): DelegationSubmitResult {
  const parsed = delegationRequestSchema.safeParse(input)
  if (!parsed.success) return rejected('insufficient_scope', zodMessage(parsed.error), { issues: parsed.error.issues })
  const request = parsed.data
  const contract = validateDelegationRequest(request)
  if (!contract.ok) return rejected(contract.failureMode || 'insufficient_scope', contract.message || 'Invalid delegation request.')

  const validation = validateDelegationEntrypoint(request)
  if (!validation.ok) return validation

  try {
    const mutation = buildDelegatedMutation(request, filePath)
    if (!mutation.ok || !mutation.input) return mutation
    const receipt = createDelegatedWork(mutation.input, filePath)
    return {
      ok: true,
      receipt: {
        ...receipt,
        selectedProfile: selectedProfile(request),
        selectedAgentTeam: request.desired.agentTeam,
      },
    }
  } catch (err: any) {
    return rejected(errorFailureMode(err), err?.message || String(err))
  }
}

function validateDelegationEntrypoint(request: DelegationRequest): DelegationSubmitResult {
  if (request.notificationTarget.mode !== 'none' && !request.parentSession?.sessionId && !request.notificationTarget.sessionId && request.notificationTarget.mode !== 'channel' && request.notificationTarget.mode !== 'project_binding') {
    return rejected('insufficient_scope', 'Delegation callbacks require parentSession.sessionId, notificationTarget.sessionId, a channel target, a project binding target, or notificationTarget.mode=none.')
  }
  if (request.parentSession?.channel && (!request.parentSession.channel.provider || !request.parentSession.channel.chatId)) {
    return rejected('insufficient_scope', 'parentSession.channel requires provider and chatId when present.')
  }

  const config = getConfig()
  const profiles = new Set(Object.keys(config.profiles))
  for (const profile of [request.desired.profile, ...Object.values(request.desired.stageProfiles || {})].filter(Boolean) as string[]) {
    if (!profiles.has(profile)) return rejected('invalid_profile_or_team', `Requested profile does not exist: ${profile}.`, { profile })
  }
  if (request.desired.agentTeam && !config.agentTeams[request.desired.agentTeam]) {
    return rejected('invalid_profile_or_team', `Requested agent team does not exist: ${request.desired.agentTeam}.`, { agentTeam: request.desired.agentTeam })
  }
  if (request.target.type === 'agent_team_blueprint') {
    try {
      validateAgentTeamConfig(request.target.name, {
        description: request.target.description,
        roles: request.target.roles,
        capabilityRequirements: request.target.capabilityRequirements,
        qualitySpecDefaults: request.target.qualitySpecDefaults,
      } as any)
    } catch (err: any) {
      return rejected('invalid_profile_or_team', err?.message || String(err))
    }
    return rejected('budget_or_gate_required', 'Agent team blueprint delegation requires the existing agent_team_propose/apply human-gated flow; delegation does not silently mutate runtime config.')
  }

  if (request.environment !== undefined) {
    try {
      const environment = normalizeEnvironmentSelector(request.environment, 'delegation.environment')
      if (environment && typeof environment === 'object') {
        const unsafeEnvironment = environment.backend === 'remote-crabbox' || (environment.backend === 'local-container' && Boolean((environment as any).container?.privileged))
        if (unsafeEnvironment) return rejected('budget_or_gate_required', `Environment ${environment.name || environment.backend} requires an explicit approval gate before delegation can be scheduled.`)
      }
    } catch (err: any) {
      return rejected('unsafe_operation', err?.message || String(err))
    }
  }

  const unsafeText = [...request.context.constraints, request.objective].join('\n').toLowerCase()
  if (/\b(destructive|delete production|drop database|credential|secret|external side effect|charge customer|send email)\b/.test(unsafeText)) {
    return rejected('unsafe_operation', 'Delegation describes destructive, credentialed, or external side-effecting work without an explicit approved human gate.')
  }
  return { ok: true }
}

function buildDelegatedMutation(request: DelegationRequest, filePath?: string): DelegationSubmitResult & { input?: Parameters<typeof createDelegatedWork>[0] } {
  const parentSessionId = request.parentSession?.sessionId || request.notificationTarget.sessionId
  const notificationTarget = {
    ...request.notificationTarget,
    parentSession: request.parentSession,
  }

  if (request.target.type === 'issue') {
    const resolution = request.target.roadmapId
      ? resolveProjectContext({ roadmapId: request.target.roadmapId }, filePath)
      : resolveProjectContext({ alias: request.target.projectAlias }, filePath)
    if (resolution.status !== 'resolved' || !resolution.roadmap) {
      return rejected('ambiguous_project_context', resolution.reason, { candidates: resolution.candidates?.map(candidate => ({ id: candidate.id, alias: candidate.alias, roadmapId: candidate.roadmapId, scope: candidate.scope })) })
    }
    return {
      ok: true,
      input: {
        idempotencyKey: request.idempotencyKey,
        targetType: request.target.type,
        objective: request.objective,
        parentSessionId,
        notificationTarget,
        issue: taskInput(request, resolution.roadmap.id, request.target.title || request.objective),
      },
    }
  }

  if (request.target.type === 'project' || request.target.type === 'initiative') {
    const existing = request.target.projectAlias ? resolveProjectContext({ alias: request.target.projectAlias }, filePath) : undefined
    if (existing && existing.status === 'ambiguous') {
      return rejected('ambiguous_project_context', existing.reason, { candidates: existing.candidates?.map(candidate => ({ id: candidate.id, alias: candidate.alias, roadmapId: candidate.roadmapId, scope: candidate.scope })) })
    }
    const roadmapId = existing?.status === 'resolved' ? existing.roadmap?.id : undefined
    const title = request.target.type === 'initiative' ? `Initiative: ${request.target.title || request.objective}` : request.target.title || request.objective
    return {
      ok: true,
      input: {
        idempotencyKey: request.idempotencyKey,
        targetType: request.target.type,
        objective: request.objective,
        parentSessionId,
        notificationTarget,
        project: {
          roadmapId,
          title,
          agentTeam: request.desired.agentTeam,
          environment: request.environment,
          qualitySpec: roadmapQualitySpec(request),
          tasks: projectTasks(request, roadmapId),
          supervisor: (request.target.createSupervisor ?? true) && !roadmapId ? {
            roadmapId: '',
            sessionId: parentSessionId || `delegation_${request.idempotencyKey}`,
            profile: 'supervisor',
            isDefault: true,
            cadence: request.schedule.supervisorCadenceMs ? { intervalMs: request.schedule.supervisorCadenceMs } : {},
            eventTriggers: { delegation: true, taskDone: true, taskBlocked: true, humanGatePending: true },
            completionPolicy: { mode: request.completionPolicy },
            note: `Delegated from ${parentSessionId || 'unknown parent'} with idempotency key ${request.idempotencyKey}.`,
          } : undefined,
          binding: !roadmapId && request.target.projectAlias ? bindingInput(request, parentSessionId) : undefined,
        },
      },
    }
  }

  return rejected('insufficient_scope', `Unsupported delegation target: ${request.target.type}.`)
}

function projectTasks(request: DelegationRequest, roadmapId?: string): WorkTaskCreateInput[] {
  if (request.target.type !== 'project') return []
  if (!request.target.tasks.length) return [taskInput(request, roadmapId || '', request.objective)]
  return request.target.tasks.map(task => ({
    ...taskInput(request, roadmapId || '', task.title),
    description: task.description || request.context.summary,
    qualitySpec: taskQualitySpec(request, task.acceptanceCriteria.length ? task.acceptanceCriteria : request.acceptanceCriteria, task.definitionOfDone.length ? task.definitionOfDone : request.definitionOfDone),
  }))
}

function taskInput(request: DelegationRequest, roadmapId: string, title: string): WorkTaskCreateInput & { roadmapId: string } {
  return {
    title,
    description: request.context.summary,
    roadmapId,
    agent: request.desired.profile,
    agentTeam: request.desired.agentTeam,
    stageProfiles: request.desired.stageProfiles,
    environment: request.environment,
    note: taskNote(request),
    earliestStartAt: request.schedule.earliestStartAt,
    deadlineAt: request.schedule.deadlineAt,
    recurrence: request.schedule.recurrence,
    manualGate: manualGateFor(request),
    qualitySpec: taskQualitySpec(request, request.acceptanceCriteria, request.definitionOfDone),
  }
}

function taskQualitySpec(request: DelegationRequest, acceptanceCriteria: string[], definitionOfDone: string[]): TaskQualitySpec {
  return {
    objective: request.objective,
    constraints: [...request.context.constraints, ...request.context.nonGoals.map(item => `Non-goal: ${item}`)],
    acceptanceCriteria,
    definitionOfDone,
    filesTouched: request.context.references.filter(ref => ref.startsWith('/') || ref.startsWith('./') || ref.includes('.')),
    systemsTouched: [],
    requiredTools: [],
    verificationCommands: request.evidence.filter(item => item.type === 'command').map(item => item.ref || item.summary),
    evidenceRequirements: request.evidence.map(item => item.summary),
    requiredArtifacts: request.evidence.filter(item => item.ref).map(item => item.ref!),
  }
}

function roadmapQualitySpec(request: DelegationRequest): RoadmapQualitySpec {
  return {
    objective: request.objective,
    acceptanceCriteria: request.acceptanceCriteria,
    definitionOfDone: request.definitionOfDone,
    evidenceRequirements: request.evidence.map(item => item.summary),
    requiredArtifacts: request.evidence.filter(item => item.ref).map(item => item.ref!),
    residualRiskNotes: request.context.constraints,
    completionPolicy: request.completionPolicy,
  }
}

function taskNote(request: DelegationRequest): string {
  const lines = [
    `Delegation idempotency key: ${request.idempotencyKey}`,
    request.parentSession?.sessionId ? `Parent session: ${request.parentSession.sessionId}` : '',
    request.context.references.length ? `References: ${request.context.references.join('; ')}` : '',
    request.context.nonGoals.length ? `Non-goals: ${request.context.nonGoals.join('; ')}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

function manualGateFor(request: DelegationRequest): ManualGate | undefined {
  if (request.budget.requiresApprovalAbove !== undefined) return 'approval_required'
  return undefined
}

function bindingInput(request: DelegationRequest, parentSessionId?: string): ProjectBindingInput | undefined {
  if (request.target.type !== 'project' && request.target.type !== 'initiative') return undefined
  const alias = request.target.projectAlias
  if (!alias) return undefined
  const channel = request.parentSession?.channel
  const target = request.notificationTarget
  const provider = target.mode === 'channel' ? target.provider : channel?.provider
  const chatId = target.mode === 'channel' ? target.chatId : channel?.chatId
  const threadId = target.mode === 'channel' ? target.threadId : channel?.threadId
  const scope: ProjectBindingScope = provider === 'telegram' || provider === 'whatsapp' ? provider : 'opencode'
  return {
    alias,
    roadmapId: '',
    sessionId: parentSessionId || `delegation_${request.idempotencyKey}`,
    scope,
    provider,
    chatId,
    threadId,
    title: request.target.title || request.objective,
    notificationMode: request.notificationTarget.notificationMode,
    mutedUntil: request.notificationTarget.mutedUntil,
    quietHours: request.notificationTarget.quietHours,
    allowRebind: false,
  }
}

function selectedProfile(request: DelegationRequest): string | undefined {
  return request.desired.profile || request.desired.stageProfiles?.['default']
}

function rejected(failureMode: DelegationFailureMode, message: string, details?: Record<string, unknown>): DelegationSubmitResult {
  return { ok: false, failureMode, message, details }
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')
}

function errorFailureMode(err: any): DelegationFailureMode {
  const message = String(err?.message || err)
  if (message.includes('profile not found') || message.includes('agent team not found')) return 'invalid_profile_or_team'
  if (message.includes('roadmap not found') || message.includes('Project alias')) return 'ambiguous_project_context'
  if (delegationFailureModes.some(mode => message.includes(mode))) return delegationFailureModes.find(mode => message.includes(mode))!
  return 'insufficient_scope'
}
