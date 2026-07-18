import { createHash } from 'node:crypto'
import { stableStringify } from './stable-stringify.js'
import {
  assembleBoundedTeam,
  type TeamAssemblyMember,
  type TeamAssemblyOptions,
  type TeamAssemblyRejection,
  type TeamAssemblyRequest,
  type TeamAssemblyReceipt,
} from './team-assembly.js'
import {
  appendWorkEvent,
  getDelegationReceipt,
  getRun,
  getWorkTask,
  listAllWorkEventsByType,
  listRecentWorkEvents,
  listWorkEventsByType,
  loadWorkState,
  type RunRecord,
  type WorkEventRecord,
} from './work-store.js'

export type AssignmentGateType = 'review' | 'evidence' | 'eval' | 'human_approval' | 'completion_quality'
export type AssignmentGateStatus = 'pending' | 'passed' | 'failed' | 'blocked' | 'approved' | 'rejected'
export type AssignmentReceiptKind = 'gate_result' | 'review_outcome' | 'completion'

export interface TeamAssignmentBudget {
  maxRuntimeMs?: number
  maxTokens?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxCostUsd?: number
  retryLimit?: number
}

export interface TeamAssignmentScope {
  skills: string[]
  mcpServers: string[]
  tools: string[]
  permissions: Array<{ key: string; policy: 'allow' | 'ask' | 'deny' }>
}

export interface TeamAssignmentGateDefinition {
  id: string
  type: AssignmentGateType
  requiredBefore: 'start' | 'dispatch' | 'complete'
  description?: string
  metadata: Record<string, unknown>
}

export interface TeamAssignmentEvidenceRequirement {
  id: string
  type: string
  summary: string
  required: boolean
  metadata: Record<string, unknown>
}

export interface TeamTaskAssignment {
  id: string
  idempotencyKey: string
  status: 'assigned'
  objective?: string
  taskId?: string
  roadmapId?: string
  delegationId?: string
  runId?: string
  sessionId?: string
  teamRequestId: string
  teamId: string
  teamName: string
  memberId: string
  role: string
  profile: string
  agent: string
  model: string
  profileVersion: string
  profileRevision: string
  budget: TeamAssignmentBudget
  scope: TeamAssignmentScope
  requiredEvidence: TeamAssignmentEvidenceRequirement[]
  gates: TeamAssignmentGateDefinition[]
  createdAt: string
  updatedAt: string
}

export interface TeamAssignmentReceipt {
  receiptKind: 'team_assignment'
  version: 1
  id: string
  idempotencyKey: string
  idempotencyStatus: 'created' | 'replayed' | 'rejected'
  status: 'accepted' | 'rejected'
  objective?: string
  createdAt: string
  assignments: TeamTaskAssignment[]
  teamAssemblyReceipt?: TeamAssemblyReceipt
  rejectionReasons: TeamAssemblyRejection[]
  links: Record<string, string>
  audit: {
    resolverVersion: 'team-assignment-v1'
    assignmentInputs: string[]
    createdAt: string
  }
}

export interface TeamAssignmentResult {
  ok: boolean
  receipt: TeamAssignmentReceipt
}

export interface TeamAssignmentCreateRequest extends TeamAssemblyRequest {
  taskId?: string
  roadmapId?: string
  delegationId?: string
  runId?: string
  sessionId?: string
  scope?: {
    skills?: string[]
    mcpServers?: string[]
    tools?: string[]
    permissions?: Record<string, 'allow' | 'ask' | 'deny'>
  }
  budget?: TeamAssemblyRequest['budget'] & Partial<TeamAssignmentBudget>
  requiredEvidence?: Array<Record<string, unknown>>
  evidenceRequirements?: Array<Record<string, unknown>>
}

export interface AssignmentReceiptRecord {
  receiptKind: AssignmentReceiptKind
  id: string
  assignmentId: string
  gateId?: string
  gateType?: AssignmentGateType
  status: AssignmentGateStatus
  summary: string
  evidence: string[]
  reviewer?: string
  runId?: string
  sessionId?: string
  source?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AssignmentReceiptInput {
  receiptKind: AssignmentReceiptKind
  assignmentId: string
  gateId?: string
  gateType?: AssignmentGateType
  status: AssignmentGateStatus
  summary: string
  evidence?: string[]
  reviewer?: string
  runId?: string
  sessionId?: string
  source?: string
  metadata?: Record<string, unknown>
}

const GATE_TYPES: AssignmentGateType[] = ['review', 'evidence', 'eval', 'human_approval', 'completion_quality']
const GATE_STATUSES: AssignmentGateStatus[] = ['pending', 'passed', 'failed', 'blocked', 'approved', 'rejected']
const PASSING_GATE_STATUSES = new Set<AssignmentGateStatus>(['passed', 'approved'])

export function createTeamTaskAssignments(input: TeamAssignmentCreateRequest, options: TeamAssemblyOptions & { filePath?: string } = {}): TeamAssignmentResult {
  const now = (options.now || new Date()).toISOString()
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
  const receiptId = stableId('team_assignment_receipt', [idempotencyKey])
  const existing = existingAssignmentReceipt(receiptId, options.filePath)
  if (existing) {
    const replayRejections = uniqueRejections([
      ...validateAssignmentTargetPresent(input),
      ...validateWorkLinks(input, options.filePath),
      ...validateAssignmentReplayTargets(input, existing),
    ])
    if (replayRejections.length) {
      return {
        ok: false,
        receipt: {
          ...existing,
          idempotencyStatus: 'rejected',
          status: 'rejected',
          assignments: [],
          rejectionReasons: replayRejections,
          links: assignmentLinks(input, [], receiptId),
        },
      }
    }
    return { ok: true, receipt: { ...existing, idempotencyStatus: 'replayed' } }
  }

  const assembly = assembleBoundedTeam(input, { ...options, workStateFilePath: options.workStateFilePath || options.filePath })
  const rejections = [...assembly.receipt.rejectionReasons]
  rejections.push(...validateWorkLinks(input, options.filePath))
  const budget = normalizeBudget(input.budget, rejections)
  const requiredEvidence = normalizeEvidenceRequirements(input.requiredEvidence || input.evidenceRequirements, rejections)
  const gates = normalizeGates(input.gates, requiredEvidence, rejections)

  rejections.push(...validateAssignmentTargetPresent(input))

  const assignmentInputs = [
    `idempotency:${idempotencyKey || 'missing'}`,
    input.taskId ? `task:${input.taskId}` : undefined,
    input.roadmapId ? `roadmap:${input.roadmapId}` : undefined,
    input.runId ? `run:${input.runId}` : undefined,
    input.sessionId ? `session:${input.sessionId}` : undefined,
    input.delegationId ? `delegation:${input.delegationId}` : undefined,
    `team:${assembly.receipt.selectedTeam.name}`,
  ].filter(Boolean) as string[]

  let assignments: TeamTaskAssignment[] = []
  if (!rejections.length && assembly.ok) {
    const drafted = assembly.receipt.members.map(member => assignmentForMember(input, member, assembly.receipt, budget, requiredEvidence, gates, now, rejections))
    if (!rejections.length) assignments = drafted
  }

  const receipt: TeamAssignmentReceipt = {
    receiptKind: 'team_assignment',
    version: 1,
    id: receiptId,
    idempotencyKey,
    idempotencyStatus: rejections.length || !assembly.ok ? 'rejected' : 'created',
    status: rejections.length || !assembly.ok ? 'rejected' : 'accepted',
    objective: input.objective,
    createdAt: now,
    assignments,
    teamAssemblyReceipt: assembly.receipt,
    rejectionReasons: uniqueRejections(rejections),
    links: assignmentLinks(input, assignments, receiptId),
    audit: {
      resolverVersion: 'team-assignment-v1',
      assignmentInputs: [...new Set(assignmentInputs)].sort(),
      createdAt: now,
    },
  }

  if (receipt.status === 'accepted') {
    appendWorkEvent('team_assignment.created', receipt.id, { receipt }, options.filePath)
  } else {
    appendWorkEvent('team_assignment.rejected', receipt.id, { receipt }, options.filePath)
  }
  return { ok: receipt.status === 'accepted', receipt }
}

export function listTeamTaskAssignments(filter: { receiptId?: string; taskId?: string; roadmapId?: string; runId?: string; sessionId?: string; memberId?: string; limit?: number } = {}, filePath?: string): Array<TeamTaskAssignment & { receipts: AssignmentReceiptRecord[] }> {
  const hasFilter = Boolean(filter.receiptId || filter.taskId || filter.roadmapId || filter.runId || filter.sessionId || filter.memberId)
  const assignmentReceipts = hasFilter ? listAllAssignmentReceipts(filePath) : listAssignmentReceipts(filter.limit || 1000, filePath)
  const receiptRecords = listAssignmentEventReceipts(filePath)
  const receiptByAssignment = groupBy(receiptRecords, receipt => receipt.assignmentId)
  const rows = assignmentReceipts
    .filter(receipt => !filter.receiptId || receipt.id === filter.receiptId)
    .flatMap(receipt => receipt.assignments)
    .filter(assignment => !filter.taskId || assignment.taskId === filter.taskId)
    .filter(assignment => !filter.roadmapId || assignment.roadmapId === filter.roadmapId)
    .filter(assignment => !filter.runId || assignment.runId === filter.runId)
    .filter(assignment => !filter.sessionId || assignment.sessionId === filter.sessionId)
    .filter(assignment => !filter.memberId || assignment.memberId === filter.memberId)
    .map(assignment => ({ ...assignment, receipts: receiptByAssignment.get(assignment.id) || [] }))
  return rows.slice(-Math.max(1, Math.min(filter.limit || 100, 1000)))
}

export function getTeamTaskAssignment(assignmentId: string, filePath?: string): (TeamTaskAssignment & { receipts: AssignmentReceiptRecord[] }) | undefined {
  const receiptByAssignment = groupBy(listAssignmentEventReceipts(filePath), receipt => receipt.assignmentId)
  for (const receipt of listAllAssignmentReceipts(filePath)) {
    const assignment = receipt.assignments.find(row => row.id === assignmentId)
    if (assignment) return { ...assignment, receipts: receiptByAssignment.get(assignment.id) || [] }
  }
  return undefined
}

export function recordTeamAssignmentReceipt(input: AssignmentReceiptInput, filePath?: string): { ok: boolean; receipt?: AssignmentReceiptRecord; rejectionReasons?: TeamAssemblyRejection[] } {
  const assignment = getTeamTaskAssignment(input.assignmentId, filePath)
  if (!assignment) return { ok: false, rejectionReasons: [rejection('assignment_not_found', 'assignmentId', `Team assignment not found: ${input.assignmentId}.`, 'Create the assignment first or pass a valid assignmentId.')] }
  const rejections: TeamAssemblyRejection[] = []
  const kind = normalizeReceiptKind(input.receiptKind, rejections)
  const gateStatus = normalizeGateStatus(input.status, rejections)
  const gate = gateForReceipt(assignment, input, kind, rejections)
  const evidence = normalizeStringList(input.evidence, 1000)
  if ((kind === 'gate_result' && gate?.type === 'evidence') || kind === 'completion') {
    rejections.push(...missingRequiredEvidence(assignment, evidence))
  }
  if (kind === 'completion') {
    const blockers = completionGateBlockers(assignment)
    for (const blocker of blockers) rejections.push(blocker)
  }
  if (rejections.length || !kind || !gateStatus) return { ok: false, rejectionReasons: uniqueRejections(rejections) }

  const createdAt = new Date().toISOString()
  const receipt: AssignmentReceiptRecord = {
    receiptKind: kind,
    id: stableId(`team_assignment_${kind}`, [assignment.id, input.gateId || gate?.id || kind, gateStatus, input.summary, createdAt]),
    assignmentId: assignment.id,
    gateId: input.gateId || gate?.id,
    gateType: input.gateType || gate?.type,
    status: gateStatus,
    summary: boundedText(input.summary, 2000) || `${kind} ${gateStatus}`,
    evidence,
    reviewer: boundedText(input.reviewer, 200),
    runId: boundedText(input.runId || assignment.runId, 200),
    sessionId: boundedText(input.sessionId || assignment.sessionId, 200),
    source: boundedText(input.source, 120),
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {},
    createdAt,
  }
  appendWorkEvent(`team_assignment.${kind}`, assignment.id, { receipt }, filePath)
  return { ok: true, receipt }
}

export function listAssignmentReceipts(limit = 1000, filePath?: string): TeamAssignmentReceipt[] {
  return listWorkEventsByType('team_assignment.created', limit, filePath)
    .map(receiptFromCreatedEvent)
    .filter(Boolean) as TeamAssignmentReceipt[]
}

export function listAssignmentEventReceipts(filePath?: string): AssignmentReceiptRecord[] {
  const receipts = [
    ...listAllWorkEventsByType('team_assignment.gate_result', filePath),
    ...listAllWorkEventsByType('team_assignment.review_outcome', filePath),
    ...listAllWorkEventsByType('team_assignment.completion', filePath),
  ].map(receiptFromEvent).filter((receipt): receipt is AssignmentReceiptRecord => Boolean(receipt))
  return receipts.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function listAllAssignmentReceipts(filePath?: string): TeamAssignmentReceipt[] {
  return listAllWorkEventsByType('team_assignment.created', filePath)
    .map(receiptFromCreatedEvent)
    .filter(Boolean) as TeamAssignmentReceipt[]
}

function existingAssignmentReceipt(receiptId: string, filePath?: string): TeamAssignmentReceipt | undefined {
  return listRecentWorkEvents('team_assignment.created', receiptId, new Date(0), 1, filePath)
    .map(receiptFromCreatedEvent)
    .filter(Boolean)[0] as TeamAssignmentReceipt | undefined
}

function assignmentForMember(input: TeamAssignmentCreateRequest, member: TeamAssemblyMember, assembly: TeamAssemblyReceipt, budget: TeamAssignmentBudget, requiredEvidence: TeamAssignmentEvidenceRequirement[], gates: TeamAssignmentGateDefinition[], now: string, rejections: TeamAssemblyRejection[]): TeamTaskAssignment {
  const scope = normalizeScope(input.scope, member, rejections)
  return {
    id: stableId('team_assignment', [input.idempotencyKey, input.taskId || '', input.roadmapId || '', input.runId || '', input.sessionId || '', input.delegationId || '', member.memberId]),
    idempotencyKey: input.idempotencyKey || '',
    status: 'assigned',
    objective: input.objective,
    taskId: input.taskId,
    roadmapId: input.roadmapId,
    delegationId: input.delegationId,
    runId: input.runId,
    sessionId: input.sessionId,
    teamRequestId: assembly.teamRequestId,
    teamId: assembly.selectedTeam.id,
    teamName: assembly.selectedTeam.name,
    memberId: member.memberId,
    role: member.role,
    profile: member.profile,
    agent: member.agent,
    model: member.model,
    profileVersion: member.profileVersion,
    profileRevision: member.profileRevision,
    budget,
    scope,
    requiredEvidence,
    gates,
    createdAt: now,
    updatedAt: now,
  }
}

function validateWorkLinks(input: TeamAssignmentCreateRequest, filePath?: string): TeamAssemblyRejection[] {
  const rejections: TeamAssemblyRejection[] = []
  let task: { id: string; roadmapId: string } | undefined
  let run: RunRecord | undefined
  let runTask: { id: string; roadmapId: string } | undefined
  if (input.taskId) {
    task = getWorkTask(input.taskId, filePath)
    if (!task) rejections.push(rejection('task_not_found', 'taskId', `Issue not found: ${input.taskId}.`, 'Create the Gateway Issue before assigning team members.'))
  }
  if (input.runId) {
    run = getRun(input.runId, filePath)
    if (!run) rejections.push(rejection('run_not_found', 'runId', `Run not found: ${input.runId}.`, 'Start or reference an existing Gateway run before linking it.'))
    if (run) {
      runTask = getWorkTask(run.taskId, filePath)
      if (!runTask) rejections.push(rejection('run_task_not_found', 'runId', `Run ${run.id} belongs to missing Issue ${run.taskId}.`, 'Use a Run whose Gateway Issue still exists.'))
      if (!task && runTask) task = runTask
    }
  }
  if (input.roadmapId && !loadWorkState(filePath).roadmaps.some(roadmap => roadmap.id === input.roadmapId)) {
    rejections.push(rejection('roadmap_not_found', 'roadmapId', `Project record not found: ${input.roadmapId}.`, 'Create or reference an existing Project record before assignment.'))
  }
  if (task && input.roadmapId && task.roadmapId !== input.roadmapId) {
    rejections.push(rejection('roadmap_task_mismatch', 'roadmapId', `Issue ${task.id} belongs to ${task.roadmapId}, not ${input.roadmapId}.`, 'Use matching Issue and Project record identifiers.'))
  }
  if (run && task && run.taskId !== task.id) {
    rejections.push(rejection('run_task_mismatch', 'runId', `Run ${run.id} belongs to ${run.taskId}, not ${task.id}.`, 'Use a Run that belongs to the assignment Issue.'))
  }
  if (run && input.sessionId && run.sessionId !== input.sessionId) {
    rejections.push(rejection('run_session_mismatch', 'sessionId', `Run ${run.id} is linked to Session ${run.sessionId}, not ${input.sessionId}.`, 'Use the Session from the linked Run.'))
  }
  if (input.delegationId && !getDelegationReceipt(input.delegationId, filePath)) {
    rejections.push(rejection('delegation_not_found', 'delegationId', `Delegation receipt not found: ${input.delegationId}.`, 'Create or reference an existing delegation receipt before assignment.'))
  }
  return rejections
}

function validateAssignmentTargetPresent(input: TeamAssignmentCreateRequest): TeamAssemblyRejection[] {
  if (input.taskId || input.roadmapId || input.runId || input.sessionId || input.delegationId) return []
  return [rejection('missing_assignment_target', 'taskId', 'Team assignment requires taskId, roadmapId, runId, sessionId, or delegationId.', 'Link the assignment to durable Gateway work or an OpenCode session.')]
}

function validateAssignmentReplayTargets(input: TeamAssignmentCreateRequest, receipt: TeamAssignmentReceipt): TeamAssemblyRejection[] {
  const rejections: TeamAssemblyRejection[] = []
  const targetFields: Array<keyof Pick<TeamTaskAssignment, 'taskId' | 'roadmapId' | 'runId' | 'sessionId' | 'delegationId'>> = ['taskId', 'roadmapId', 'runId', 'sessionId', 'delegationId']
  for (const field of targetFields) {
    const expected = normalizeReplayTarget((input as any)[field])
    const actual = [...new Set(receipt.assignments.map(assignment => normalizeReplayTarget((assignment as any)[field])).filter(Boolean))]
    if (expected) {
      if (actual.length !== 1 || actual[0] !== expected) {
        rejections.push(rejection('assignment_idempotency_target_mismatch', field, `Idempotency key ${receipt.idempotencyKey} already assigned ${field} ${actual[0] || '(none)'}, not ${expected}.`, 'Use the original assignment target or choose a new idempotency key.'))
      }
    } else if (actual.length) {
      rejections.push(rejection('assignment_idempotency_target_mismatch', field, `Idempotency key ${receipt.idempotencyKey} already assigned ${field} ${actual[0]}, but this request omitted it.`, 'Use the original assignment target or choose a new idempotency key.'))
    }
  }
  return rejections
}

function normalizeReplayTarget(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeBudget(input: unknown, rejections: TeamAssemblyRejection[]): TeamAssignmentBudget {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const budget: TeamAssignmentBudget = {}
  assignPositiveNumber(raw['maxRuntimeMs'], 'budget.maxRuntimeMs', budget, 'maxRuntimeMs', rejections)
  assignPositiveNumber(raw['maxTokens'] ?? raw['tokenLimit'], 'budget.maxTokens', budget, 'maxTokens', rejections)
  assignPositiveNumber(raw['maxInputTokens'], 'budget.maxInputTokens', budget, 'maxInputTokens', rejections)
  assignPositiveNumber(raw['maxOutputTokens'], 'budget.maxOutputTokens', budget, 'maxOutputTokens', rejections)
  assignPositiveNumber(raw['maxCostUsd'] ?? raw['costLimitUsd'], 'budget.maxCostUsd', budget, 'maxCostUsd', rejections)
  assignRetryLimit(raw['retryLimit'] ?? raw['maxRetries'], budget, rejections)
  return budget
}

function assignPositiveNumber(value: unknown, path: string, target: TeamAssignmentBudget, key: keyof TeamAssignmentBudget, rejections: TeamAssemblyRejection[]): void {
  if (value === undefined || value === null || value === '') return
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    rejections.push(rejection('invalid_budget_limit', path, `${path} must be a positive number.`, 'Use a positive numeric limit or omit the field.'))
    return
  }
  ;(target as any)[key] = number
}

function assignRetryLimit(value: unknown, target: TeamAssignmentBudget, rejections: TeamAssemblyRejection[]): void {
  if (value === undefined || value === null || value === '') return
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 20) {
    rejections.push(rejection('invalid_retry_limit', 'budget.retryLimit', 'budget.retryLimit must be an integer from 0 to 20.', 'Use an explicit bounded retry limit.'))
    return
  }
  target.retryLimit = number
}

function normalizeEvidenceRequirements(input: unknown, rejections: TeamAssemblyRejection[]): TeamAssignmentEvidenceRequirement[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    rejections.push(rejection('invalid_evidence_requirements', 'evidenceRequirements', 'Evidence requirements must be an array.', 'Provide an array of evidence requirement objects.'))
    return []
  }
  return input.map((row, index) => {
    const item = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : {}
    const summary = boundedText(item['summary'], 500) || boundedText(item['description'], 500) || ''
    if (!summary) rejections.push(rejection('evidence_summary_required', `evidenceRequirements.${index}.summary`, 'Evidence requirement summary is required.', 'Describe the evidence that must be provided.'))
    return {
      id: boundedText(item['id'], 120) || stableId('evidence', [index, item]),
      type: boundedText(item['type'], 80) || 'artifact',
      summary,
      required: item['required'] !== false,
      metadata: item,
    }
  })
}

function normalizeGates(input: unknown, requiredEvidence: TeamAssignmentEvidenceRequirement[], rejections: TeamAssemblyRejection[]): TeamAssignmentGateDefinition[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    rejections.push(rejection('invalid_gates', 'gates', 'Assignment gates must be an array.', 'Provide an array of gate definition objects.'))
    return []
  }
  return input.map((row, index) => {
    const item = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : {}
    const type = normalizeGateType(item['type'] || item['gate'], `gates.${index}.type`, rejections)
    const requiredBefore = normalizeRequiredBefore(item['requiredBefore'], `gates.${index}.requiredBefore`, rejections)
    if (type === 'evidence' && !requiredEvidence.length) {
      rejections.push(rejection('evidence_gate_without_requirements', `gates.${index}`, 'Evidence gates require at least one evidence requirement.', 'Add evidenceRequirements or remove the evidence gate.'))
    }
    if (type === 'completion_quality' && !item['description'] && !item['criteria']) {
      rejections.push(rejection('completion_quality_gate_missing_criteria', `gates.${index}`, 'Completion quality gates require description or criteria metadata.', 'Describe the completion quality criteria.'))
    }
    return {
      id: boundedText(item['id'], 120) || stableId('gate', [index, item]),
      type: type || 'review',
      requiredBefore,
      description: boundedText(item['description'] || item['summary'] || item['criteria'], 1000),
      metadata: item,
    }
  })
}

function normalizeScope(input: TeamAssignmentCreateRequest['scope'], member: TeamAssemblyMember, rejections: TeamAssemblyRejection[]): TeamAssignmentScope {
  const requested = input || {}
  const skills = grantSubset('skills', requested.skills, member.grants.skills, rejections)
  const mcpServers = grantSubset('mcpServers', requested.mcpServers, member.grants.mcpServers, rejections)
  const tools = grantSubset('tools', requested.tools, member.grants.tools, rejections)
  const requestedPermissions = requested.permissions || {}
  const permissions = Object.keys(requestedPermissions).length
    ? Object.entries(requestedPermissions).flatMap(([key, policy]) => {
      const requestedPolicy = normalizeScopePermissionPolicy(policy, `scope.permissions.${key}`, rejections)
      if (!requestedPolicy) return []
      const allowed = member.grants.permissions.find(row => row.key === key)
      if (!allowed) {
        rejections.push(rejection('scope_permission_not_granted', `scope.permissions.${key}`, `Permission ${key} is not granted to member ${member.role}.`, 'Request only permissions present in the assembled member grants.'))
        return []
      }
      if (permissionRank(requestedPolicy) > permissionRank(allowed.policy)) {
        rejections.push(rejection('scope_permission_escalates', `scope.permissions.${key}`, `Permission ${key}=${requestedPolicy} exceeds member policy ${allowed.policy}.`, 'Request the same or narrower permission policy.'))
        return []
      }
      return [{ key, policy: requestedPolicy }]
    })
    : member.grants.permissions
  return { skills, mcpServers, tools, permissions }
}

function normalizeScopePermissionPolicy(value: unknown, path: string, rejections: TeamAssemblyRejection[]): 'allow' | 'ask' | 'deny' | undefined {
  if (value === 'allow' || value === 'ask' || value === 'deny') return value
  rejections.push(rejection('invalid_scope_permission_policy', path, `${path} must be allow, ask, or deny.`, 'Use a supported permission policy for assignment scope.'))
  return undefined
}

function permissionRank(policy: 'allow' | 'ask' | 'deny'): number {
  if (policy === 'allow') return 2
  if (policy === 'ask') return 1
  return 0
}

function grantSubset(kind: 'skills' | 'mcpServers' | 'tools', requested: string[] | undefined, allowed: string[], rejections: TeamAssemblyRejection[]): string[] {
  if (!requested) return [...allowed]
  const allowedSet = new Set(allowed)
  return [...new Set(requested)].sort().flatMap(value => {
    if (value === '*') {
      rejections.push(rejection('scope_wildcard_denied', `scope.${kind}`, `Wildcard ${kind} scope is not allowed.`, 'Request exact tools, skills, and MCP servers.'))
      return []
    }
    if (!allowedSet.has(value)) {
      rejections.push(rejection('scope_not_granted', `scope.${kind}.${value}`, `${kind} ${value} is not granted to this team member.`, 'Request only scope that the assembled profile already grants.'))
      return []
    }
    return [value]
  })
}

function gateForReceipt(assignment: TeamTaskAssignment, input: AssignmentReceiptInput, kind: AssignmentReceiptKind | undefined, rejections: TeamAssemblyRejection[]): TeamAssignmentGateDefinition | undefined {
  if (!kind) return undefined
  if (kind === 'review_outcome') {
    const gate = input.gateId ? assignment.gates.find(row => row.id === input.gateId) : assignment.gates.find(row => row.type === 'review')
    if (!gate || gate.type !== 'review') rejections.push(rejection('review_gate_required', 'gateId', 'Review outcome receipts require a configured review gate.', 'Record a gate result for an existing review gate or create an assignment with a review gate.'))
    return gate
  }
  if (kind === 'gate_result') {
    const gate = input.gateId ? assignment.gates.find(row => row.id === input.gateId) : assignment.gates.find(row => row.type === input.gateType)
    if (!gate) rejections.push(rejection('gate_not_found', 'gateId', 'Gate result receipts require a configured assignment gate.', 'Use one of the assignment gate IDs.'))
    return gate
  }
  return undefined
}

function completionGateBlockers(assignment: TeamTaskAssignment & { receipts?: AssignmentReceiptRecord[] }): TeamAssemblyRejection[] {
  const receipts = assignment.receipts || []
  const latestByGate = new Map<string, AssignmentReceiptRecord>()
  for (const receipt of receipts) {
    if (!receipt.gateId) continue
    latestByGate.set(receipt.gateId, receipt)
  }
  return assignment.gates
    .filter(gate => gate.requiredBefore === 'complete')
    .filter(gate => !PASSING_GATE_STATUSES.has(latestByGate.get(gate.id)?.status as AssignmentGateStatus))
    .map(gate => rejection('completion_gate_unmet', `gates.${gate.id}`, `Completion gate ${gate.id} (${gate.type}) has not passed.`, 'Record a passing gate/review receipt before completion.'))
}

function missingRequiredEvidence(assignment: TeamTaskAssignment, evidence: string[]): TeamAssemblyRejection[] {
  return assignment.requiredEvidence
    .filter(item => item.required)
    .filter(item => !evidence.some(ref => evidenceSatisfiesRequirement(ref, item)))
    .map(item => rejection('evidence_required', `evidence.${item.id}`, `Required evidence is missing: ${item.summary || item.id}.`, 'Attach evidence that references each required evidence id or summary.'))
}

function evidenceSatisfiesRequirement(ref: string, requirement: TeamAssignmentEvidenceRequirement): boolean {
  const text = ref.toLowerCase()
  return Boolean(
    (requirement.id && text.includes(requirement.id.toLowerCase())) ||
    (requirement.summary && text.includes(requirement.summary.toLowerCase())),
  )
}

function normalizeReceiptKind(value: unknown, rejections: TeamAssemblyRejection[]): AssignmentReceiptKind | undefined {
  if (value === 'gate_result' || value === 'review_outcome' || value === 'completion') return value
  rejections.push(rejection('invalid_receipt_kind', 'receiptKind', 'receiptKind must be gate_result, review_outcome, or completion.', 'Use a supported assignment receipt kind.'))
  return undefined
}

function normalizeGateStatus(value: unknown, rejections: TeamAssemblyRejection[]): AssignmentGateStatus | undefined {
  if (GATE_STATUSES.includes(value as AssignmentGateStatus)) return value as AssignmentGateStatus
  rejections.push(rejection('invalid_gate_status', 'status', 'Gate status must be pending, passed, failed, blocked, approved, or rejected.', 'Use a supported gate status.'))
  return undefined
}

function normalizeGateType(value: unknown, path: string, rejections: TeamAssemblyRejection[]): AssignmentGateType | undefined {
  if (GATE_TYPES.includes(value as AssignmentGateType)) return value as AssignmentGateType
  rejections.push(rejection('invalid_gate_type', path, 'Gate type must be review, evidence, eval, human_approval, or completion_quality.', 'Use a supported assignment gate type.'))
  return undefined
}

function normalizeRequiredBefore(value: unknown, path: string, rejections: TeamAssemblyRejection[]): 'start' | 'dispatch' | 'complete' {
  if (value === undefined || value === null || value === '') return 'complete'
  if (value === 'start' || value === 'dispatch' || value === 'complete') return value
  rejections.push(rejection('invalid_gate_required_before', path, 'Gate requiredBefore must be start, dispatch, or complete.', 'Use a supported gate checkpoint.'))
  return 'complete'
}

function receiptFromCreatedEvent(event: WorkEventRecord): TeamAssignmentReceipt | undefined {
  const receipt = (event.payload as any)?.receipt
  return receipt?.receiptKind === 'team_assignment' ? receipt as TeamAssignmentReceipt : undefined
}

function receiptFromEvent(event: WorkEventRecord): AssignmentReceiptRecord | undefined {
  const receipt = (event.payload as any)?.receipt
  return receipt?.assignmentId && receipt?.receiptKind ? receipt as AssignmentReceiptRecord : undefined
}

function assignmentLinks(input: TeamAssignmentCreateRequest, assignments: TeamTaskAssignment[], receiptId: string): Record<string, string> {
  const links: Record<string, string> = {}
  if (input.taskId) links['task'] = `/tasks/${input.taskId}`
  if (input.roadmapId) links['roadmap'] = `/roadmaps/${input.roadmapId}`
  if (input.runId) links['run'] = `/runs/${input.runId}`
  if (input.sessionId) links['session'] = `/opencode/sessions/${input.sessionId}`
  if (input.delegationId) links['delegation'] = `/delegations/${input.delegationId}`
  if (assignments.length) links['assignments'] = `/team-assignments?receiptId=${receiptId}`
  return links
}

function normalizeStringList(values: unknown, maxLength: number): string[] {
  if (!Array.isArray(values)) return []
  return values.map(value => boundedText(value, maxLength)).filter(Boolean) as string[]
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text.substring(0, maxLength) : undefined
}

function rejection(code: string, path: string, message: string, action: string): TeamAssemblyRejection {
  return { code, path, message, action }
}

function uniqueRejections(rejections: TeamAssemblyRejection[]): TeamAssemblyRejection[] {
  const seen = new Set<string>()
  return rejections.filter(row => {
    const key = `${row.code}:${row.path}:${row.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code))
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const value of values) {
    const group = key(value)
    map.set(group, [...(map.get(group) || []), value])
  }
  return map
}

function stableId(prefix: string, parts: unknown[]): string {
  return `${prefix}_${createHash('sha256').update(stableStringify(parts)).digest('hex').slice(0, 16)}`
}
