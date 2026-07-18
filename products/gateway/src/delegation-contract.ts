import { z } from 'zod'

const zStringRecord = <Schema extends z.ZodTypeAny>(schema: Schema) => z.record(z.string(), schema)

export const delegationContractVersion = 1

export const delegationFailureModes = [
  'insufficient_scope',
  'unsafe_operation',
  'missing_credentials',
  'ambiguous_project_context',
  'invalid_profile_or_team',
  'budget_or_gate_required',
] as const
export type DelegationFailureMode = typeof delegationFailureModes[number]

const nonEmptyString = z.string().trim().min(1)
const optionalString = z.string().trim().min(1).optional()
const stringList = z.array(nonEmptyString).default([])

export const delegationEvidenceRequirementSchema = z.object({
  type: z.enum(['diff', 'test', 'command', 'link', 'screenshot', 'log', 'decision', 'file', 'note', 'other']).optional(),
  ref: optionalString,
  summary: nonEmptyString,
})

export const delegationNotificationTargetSchema = z.object({
  mode: z.enum(['none', 'parent_session', 'project_binding', 'channel', 'custom']).default('parent_session'),
  sessionId: optionalString,
  provider: z.enum(['opencode', 'telegram', 'whatsapp']).optional(),
  chatId: optionalString,
  threadId: optionalString,
  projectAlias: optionalString,
  notificationMode: z.enum(['immediate', 'digest', 'muted']).optional(),
  mutedUntil: optionalString,
  quietHours: zStringRecord(z.unknown()).optional(),
  escalation: z.object({
    criticalBypassDigest: z.boolean().optional(),
    criticalBypassQuietHours: z.boolean().optional(),
  }).optional(),
})

export const delegationParentSessionSchema = z.object({
  sessionId: nonEmptyString,
  channel: z.object({
    provider: z.enum(['telegram', 'whatsapp']).optional(),
    chatId: optionalString,
    threadId: optionalString,
  }).optional(),
})

export const delegationTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('issue'),
    roadmapId: optionalString,
    projectAlias: optionalString,
    title: optionalString,
  }),
  z.object({
    type: z.literal('project'),
    projectAlias: optionalString,
    title: optionalString,
    tasks: z.array(z.object({
      title: nonEmptyString,
      description: optionalString,
      acceptanceCriteria: stringList,
      definitionOfDone: stringList,
    })).default([]),
    createSupervisor: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('initiative'),
    title: optionalString,
    projectAlias: optionalString,
    milestones: stringList,
    createSupervisor: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('agent_team_blueprint'),
    name: nonEmptyString,
    description: optionalString,
    roles: zStringRecord(nonEmptyString).optional(),
    capabilityRequirements: zStringRecord(z.array(nonEmptyString)).optional(),
    qualitySpecDefaults: zStringRecord(z.unknown()).optional(),
  }),
])

export const delegationRequestSchema = z.object({
  version: z.literal(delegationContractVersion).default(delegationContractVersion),
  idempotencyKey: nonEmptyString,
  target: delegationTargetSchema,
  objective: nonEmptyString,
  context: z.object({
    summary: nonEmptyString,
    references: stringList,
    constraints: stringList,
    nonGoals: stringList,
  }),
  acceptanceCriteria: stringList,
  definitionOfDone: stringList,
  desired: z.object({
    profile: optionalString,
    agentTeam: optionalString,
    stageProfiles: zStringRecord(nonEmptyString).optional(),
  }).default({}),
  environment: z.union([nonEmptyString, zStringRecord(z.unknown())]).optional(),
  schedule: z.object({
    earliestStartAt: optionalString,
    deadlineAt: optionalString,
    recurrence: optionalString,
    supervisorCadenceMs: z.number().int().positive().optional(),
  }).default({}),
  budget: z.object({
    maxCostUsd: z.number().nonnegative().optional(),
    maxRuntimeMs: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    requiresApprovalAbove: z.number().nonnegative().optional(),
  }).default({}),
  evidence: z.array(delegationEvidenceRequirementSchema).default([]),
  notificationTarget: delegationNotificationTargetSchema.default({ mode: 'parent_session' }),
  parentSession: delegationParentSessionSchema.optional(),
  completionPolicy: z.enum(['manual', 'assistant_proposes_user_approves', 'auto_when_evidence_complete', 'never_auto_complete']).default('assistant_proposes_user_approves'),
})

export type DelegationRequest = z.infer<typeof delegationRequestSchema>

export interface DelegationValidationResult {
  ok: boolean
  failureMode?: DelegationFailureMode
  message?: string
}

export function validateDelegationRequest(request: DelegationRequest): DelegationValidationResult {
  if (!request.acceptanceCriteria.length) return invalid('insufficient_scope', 'Delegation requires at least one acceptance criterion.')
  if (!request.definitionOfDone.length) return invalid('insufficient_scope', 'Delegation requires at least one definition-of-done item.')
  if (request.target.type === 'issue' && !request.target.roadmapId && !request.target.projectAlias) {
    return invalid('ambiguous_project_context', 'Issue delegation requires roadmapId or projectAlias.')
  }
  if ((request.target.type === 'project' || request.target.type === 'initiative') && !request.target.title && !request.target.projectAlias) {
    return invalid('insufficient_scope', `${request.target.type} delegation requires title or projectAlias.`)
  }
  if (request.target.type === 'agent_team_blueprint' && !request.target.roles && !request.target.capabilityRequirements && !request.target.qualitySpecDefaults) {
    return invalid('insufficient_scope', 'Agent team blueprint delegation requires roles, capability requirements, or quality defaults.')
  }
  if (request.budget.requiresApprovalAbove !== undefined && request.budget.maxCostUsd !== undefined && request.budget.maxCostUsd > request.budget.requiresApprovalAbove) {
    return invalid('budget_or_gate_required', 'Budget exceeds the approval threshold and must create or reference a human gate.')
  }
  if (request.notificationTarget.mode === 'channel' && (!request.notificationTarget.provider || !request.notificationTarget.chatId)) {
    return invalid('insufficient_scope', 'Channel notification target requires provider and chatId.')
  }
  return { ok: true }
}

function invalid(failureMode: DelegationFailureMode, message: string): DelegationValidationResult {
  return { ok: false, failureMode, message }
}
