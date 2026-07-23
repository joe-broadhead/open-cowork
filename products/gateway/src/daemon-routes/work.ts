import { z } from 'zod'
import type { RouteHandler } from '../daemon-router.js'
import { defineApiRouteContracts, HttpError, json, pathMatch, readJsonBodyAs } from '../daemon-router.js'
import { deleteAgentTeam, deleteProfile, getAgentTeam, getConfig, listAgentTeams, listProfiles, updateSchedulerConfig, upsertAgentTeam, upsertProfile } from '../config.js'
import { getSchedulerLeaseSummary, getWorkQueueSnapshot, schedulerCycleSnapshots } from '../scheduler.js'
import { addWorkDependency, appendAuditEvent, applyWorkEnvironmentAction, applyWorkTaskAction, archiveRoadmap, archiveRoadmapSupervisor, archiveWorkTask, createHumanGate, createRoadmap, createRoadmapSupervisor, createRoadmapWithTasks, createSupervisedProject, createWorkTask, createWorkTasks, decideHumanGate, decideRoadmapCompletionProposal, deleteRoadmap, deleteWorkDependency, deleteWorkTask, getDelegationReceipt, getHumanGate, getRoadmapCompletionProposal, getRoadmapSupervisor, getRun, getWorkEnvironment, getWorkTask, getWorkTaskReadiness, listHumanGates, listRoadmapCompletionProposals, listRoadmapSupervisors, listTaskDispatchAcquisitions, listWorkDependencies, listWorkEnvironments, listWorkEvents, listWorkTaskViews, loadWorkState, markTaskDispatchAcquisitionSettled, planInitiative, proposeRoadmapCompletion, reconcileWorkEnvironments, recomputeRoadmapStatus, summarizeWorkTasks, updateRoadmap, updateRoadmapSupervisor, updateWorkTask, updateWorkTasks, updateWorkTaskWithResult } from '../work-store.js'
import { applyPromotionDecision, createPromotionScorecard, getPromotionScorecard, getPromotionState, listPromotionDecisions, listPromotionScorecards } from '../work-store/promotions.js'
import { createSqliteWorkStoreBindingsPort } from '../work-store/bindings-port.js'
import { buildRoadmapMemory } from '../roadmap-memory.js'
import { formatProjectDigest, formatProjectStatus, getProjectDigest, getProjectStatus, requestProjectReview } from '../project-ux.js'
import { redactSensitiveObject, redactSensitiveText } from '../security.js'
import { applyBlueprint, previewBlueprint } from '../blueprints.js'
import { buildAgentCatalog } from '../agent-catalog.js'
import { inspectProfileAccess, inspectTeamAccess } from '../access-inspection.js'
import { assembleBoundedTeam } from '../team-assembly.js'
import { createTeamTaskAssignments, getTeamTaskAssignment, listTeamTaskAssignments, recordTeamAssignmentReceipt } from '../team-assignment.js'
import { submitDelegation } from '../delegation.js'
import { delegationRequestSchema } from '../delegation-contract.js'
import { deliverDelegationProgress } from '../delegation-progress.js'
import { queueEvent } from '../wakeup.js'
import { buildMainAgentBriefing, formatMainAgentBriefing } from '../briefing.js'
import { listPendingPermissions, listPendingQuestions } from '../opencode-requests.js'
import { createPersona, listPersonas, PersonaValidationError } from '../persona.js'
import { createAgentPresence, getAgentPresence, listAgentPresences, updateAgentPresence } from '../agent-presence.js'
import { previewBulkTaskUpdate, previewRoadmapDelete, previewTaskDelete } from '../destructive-preview.js'
import { auditHttp, consumeDestructiveHttpApproval, httpCallerIdentity, httpRequestSource, requireDestructiveHttpApproval } from './http-guardrails.js'
import { guardUnredactedExport } from '../unredacted-export-guard.js'
import {
  abortSessions,
  agentTeamBindTarget,
  agentTeamDefinitionFromBody,
  agentTeamGateInput,
  agentTeamReferences,
  auditAgentTeam,
  blueprintDefinitionFromBody,
  blueprintWithExpectedStateFromGate,
  compactEnvironment,
  compactRoadmap,
  compactRun,
  compactTask,
  compactTaskDispatchAcquisition,
  createProjectSession,
  exposeTask,
  gateApproverIdentity,
  gateApproverSurface,
  handleSchedulerAction,
  normalizeAgentTeamRouteName,
  normalizeEnvironmentAction,
  optionalTaskDispatchAcquisitionKind,
  projectAgentTeam,
  projectAgentTeams,
  projectBindingScopeFromBody,
  projectContextFromBody,
  projectContextFromUrl,
  projectCreateReplayFromReceipt,
  projectProfile,
  projectProfiles,
  projectSurfaceFilter,
  promotionSubjectKindFromValue,
  redactEnvironmentValue,
  rejectMcpExternalAuthorityGateApproval,
  requireApprovedAgentTeamGate,
  requireApprovedBlueprintGate,
  taskDispatchAcquisitionKind,
  validateAgentTeamBody,
  validateProfileForRoute,
  validateProjectBindingSurfaceBody,
  wantsDryRun,
} from './work-presentation.js'

const projectBindings = createSqliteWorkStoreBindingsPort()

const zPriority = z.enum(['HIGH', 'MEDIUM', 'LOW'])
const zWorkStatus = z.enum(['pending', 'running', 'done', 'blocked', 'paused', 'cancelled', 'archived'])
const zRoadmapStatus = z.enum(['active', 'done', 'blocked', 'archived'])
const zManualGate = z.enum(['approval_required', 'credentials_required', 'external_dependency', 'waiting_for_user'])
const zTaskAction = z.enum(['pause', 'resume', 'cancel', 'retry', 'done', 'block'])
const zDependencyType = z.enum(['blocks', 'blocked_by', 'parent', 'child', 'related', 'duplicate'])
const zSchedulerAction = z.enum(['pause', 'resume', 'run'])
const zProjectBindingScope = z.enum(['global', 'opencode', 'telegram', 'whatsapp', 'discord'])
const zProvider = z.enum(['telegram', 'whatsapp', 'discord'])
const zRoadmapSupervisorStatus = z.enum(['active', 'paused', 'blocked', 'completed', 'archived'])
const zPromotionState = z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked'])
const zStringRecord = z.record(z.string(), z.string())
const zUnknownRecord = z.record(z.string(), z.unknown())
const zPromotionSubjectKind = z.enum(['profile', 'team'])
const zPromotionSourceKind = z.enum(['arena', 'eval', 'manual'])
const zPromotionRecommendation = z.enum(['promote', 'hold', 'block', 'deprecate'])
const zPromotionAction = z.enum(['promote', 'deprecate', 'rollback', 'block'])

const zSessionAdmitBody = z.object({
  title: z.string().optional(),
  agent: z.string().optional(),
  directory: z.string().optional(),
  presenceId: z.string().optional(),
  taskId: z.string().optional(),
  purpose: z.enum(['interactive', 'worker', 'presence']).optional(),
  peerId: z.string().optional(),
}).passthrough()

const zAgentPresenceBody = z.object({
  name: z.string().min(1, 'name required'),
  opencodeAgent: z.string().min(1, 'opencodeAgent required'),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  profile: z.string().optional(),
  status: z.enum(['active', 'paused', 'blocked', 'archived']).optional(),
  wake: zUnknownRecord.optional(),
  provider: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  note: z.string().optional(),
}).passthrough()

const zAgentPresencePatchBody = z.object({
  name: z.string().optional(),
  opencodeAgent: z.string().optional(),
  sessionId: z.string().nullable().optional(),
  directory: z.string().nullable().optional(),
  profile: z.string().nullable().optional(),
  status: z.enum(['active', 'paused', 'blocked', 'archived']).optional(),
  wake: zUnknownRecord.optional(),
  provider: z.string().nullable().optional(),
  chatId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}).passthrough()

const zTaskCreateBody = z.object({
  title: z.string().min(1, 'title required'),
  description: z.string().optional(),
  roadmapId: z.string().optional(),
  priority: zPriority.optional(),
  agent: z.string().optional(),
  agentTeam: z.string().optional(),
  stageProfiles: zStringRecord.optional(),
  environment: zUnknownRecord.optional(),
  pipeline: z.array(z.string()).optional(),
  note: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  earliestStartAt: z.string().optional(),
  deadlineAt: z.string().optional(),
  recurrence: z.string().optional(),
  manualGate: z.union([zManualGate, z.literal('')]).optional(),
  slaClass: z.string().optional(),
  qualitySpec: zUnknownRecord.optional(),
  idempotencyKey: z.string().optional(),
  sourceType: z.string().optional(),
}).passthrough()

const zTaskUpdateShape = {
  title: z.string().min(1, 'title required').optional(),
  description: z.string().optional(),
  roadmapId: z.string().optional(),
  status: zWorkStatus.optional(),
  priority: zPriority.optional(),
  agent: z.string().optional(),
  agentTeam: z.string().nullable().optional(),
  stageProfiles: zStringRecord.nullable().optional(),
  environment: zUnknownRecord.nullable().optional(),
  pipeline: z.array(z.string()).optional(),
  currentStage: z.string().optional(),
  note: z.string().optional(),
  earliestStartAt: z.string().optional(),
  deadlineAt: z.string().optional(),
  recurrence: z.string().optional(),
  manualGate: z.union([zManualGate, z.literal('')]).optional(),
  slaClass: z.string().optional(),
  qualitySpec: zUnknownRecord.optional(),
}
const zTaskUpdateBody = z.object(zTaskUpdateShape).passthrough()
const zTaskBulkUpdateBody = z.object({ taskId: z.string().min(1, 'taskId required'), ...zTaskUpdateShape }).passthrough()
const zTaskBulkPatchBody = z.object({
  updates: z.array(zTaskBulkUpdateBody).optional(),
  tasks: z.array(zTaskBulkUpdateBody).optional(),
  dryRun: z.boolean().optional(),
  preview: z.boolean().optional(),
}).passthrough()
const zTaskBulkCreateBody = z.object({
  tasks: z.array(zTaskCreateBody),
  roadmapId: z.string().optional(),
}).passthrough()
const zTaskActionBody = z.object({
  action: zTaskAction,
  stage: z.string().optional(),
  note: z.string().optional(),
}).passthrough()
const zTaskDependencyCreateBody = z.object({
  dependsOnTaskId: z.string().min(1, 'dependsOnTaskId required'),
  type: zDependencyType.optional(),
}).passthrough()
const zArchiveBody = z.object({ note: z.string().optional() }).passthrough()
const zDestructiveActionBody = z.object({
  dryRun: z.boolean().optional(),
  preview: z.boolean().optional(),
  gateId: z.string().optional(),
  approvedGateId: z.string().optional(),
  approvalId: z.string().optional(),
  note: z.string().optional(),
}).passthrough()

const zRoadmapSupervisorCreateBody = z.object({
  roadmapId: z.string().min(1, 'roadmapId required'),
  sessionId: z.string().min(1, 'sessionId required'),
  profile: z.string().optional(),
  status: zRoadmapSupervisorStatus.optional(),
  isDefault: z.boolean().optional(),
  cadence: zUnknownRecord.optional(),
  eventTriggers: zUnknownRecord.optional(),
  lastReviewedEventId: z.number().int().optional(),
  lastReviewAt: z.string().optional(),
  nextReviewAt: z.string().optional(),
  completionPolicy: zUnknownRecord.optional(),
  notificationPolicyRef: z.string().optional(),
  note: z.string().optional(),
}).passthrough()
const zRoadmapSupervisorUpdateBody = z.object({
  sessionId: z.string().optional(),
  profile: z.string().optional(),
  status: zRoadmapSupervisorStatus.optional(),
  isDefault: z.boolean().optional(),
  cadence: zUnknownRecord.optional(),
  eventTriggers: zUnknownRecord.optional(),
  lastReviewedEventId: z.number().int().nullable().optional(),
  lastReviewAt: z.string().nullable().optional(),
  nextReviewAt: z.string().nullable().optional(),
  completionPolicy: zUnknownRecord.optional(),
  notificationPolicyRef: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  lastResultHash: z.string().nullable().optional(),
  lastResultAt: z.string().nullable().optional(),
  lastResultStatus: z.string().nullable().optional(),
  lastResultSummary: z.string().nullable().optional(),
}).passthrough()

const zRoadmapCreateBody = z.object({
  title: z.string().min(1, 'title required'),
  priority: zPriority.optional(),
  agentTeam: z.string().optional(),
  environment: zUnknownRecord.optional(),
  qualitySpec: zUnknownRecord.optional(),
}).passthrough()
const zRoadmapUpdateBody = z.object({
  title: z.string().min(1, 'title required').optional(),
  status: zRoadmapStatus.optional(),
  priority: zPriority.optional(),
  agentTeam: z.string().nullable().optional(),
  environment: zUnknownRecord.nullable().optional(),
  qualitySpec: zUnknownRecord.nullable().optional(),
}).passthrough()
const zRoadmapWithTasksBody = zRoadmapCreateBody.extend({
  tasks: z.array(zTaskCreateBody).optional(),
})
const zPlanInitiativeBody = zRoadmapCreateBody.extend({
  tasks: z.array(zTaskCreateBody).optional(),
  dependencies: z.array(zUnknownRecord).optional(),
  supervisor: zUnknownRecord.optional(),
})
const zDispatchNowBody = z.object({
  taskId: z.string().optional(),
  roadmapId: z.string().optional(),
}).passthrough()

const zProjectBindingBody = z.object({
  alias: z.string().min(1, 'alias required'),
  roadmapId: z.string().min(1, 'roadmapId required'),
  sessionId: z.string().min(1, 'sessionId required'),
  scope: zProjectBindingScope.optional(),
  provider: zProvider.optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  title: z.string().optional(),
  allowRebind: z.boolean().optional(),
  notificationMode: z.enum(['immediate', 'digest', 'muted']).optional(),
  mutedUntil: z.string().optional(),
  quietHours: zUnknownRecord.optional(),
  lastDigestAt: z.string().optional(),
}).passthrough()
const zProjectCreateBody = z.object({
  alias: z.string().min(1, 'alias required'),
  sessionId: z.string().optional(),
  scope: zProjectBindingScope.optional(),
  provider: zProvider.optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  title: z.string().optional(),
  priority: zPriority.optional(),
  agentTeam: z.string().optional(),
  environment: zUnknownRecord.optional(),
  qualitySpec: zUnknownRecord.optional(),
  tasks: z.array(zTaskCreateBody).optional(),
  profile: z.string().optional(),
  cadence: zUnknownRecord.optional(),
  eventTriggers: zUnknownRecord.optional(),
  completionPolicy: zUnknownRecord.optional(),
  note: z.string().optional(),
  allowRebind: z.boolean().optional(),
  notificationMode: z.enum(['immediate', 'digest', 'muted']).optional(),
  mutedUntil: z.string().optional(),
  quietHours: zUnknownRecord.optional(),
  lastDigestAt: z.string().optional(),
  idempotencyKey: z.string().optional(),
  sourceType: z.string().optional(),
}).passthrough()
const zProjectBindingPatchBody = z.object({
  alias: z.string().optional(),
  roadmapId: z.string().optional(),
  sessionId: z.string().optional(),
  scope: zProjectBindingScope.optional(),
  provider: zProvider.nullable().optional(),
  chatId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  allowRebind: z.boolean().optional(),
  notificationMode: z.enum(['immediate', 'digest', 'muted']).optional(),
  mutedUntil: z.string().nullable().optional(),
  quietHours: zUnknownRecord.nullable().optional(),
  lastDigestAt: z.string().nullable().optional(),
}).passthrough()
const zProjectReviewBody = z.object({
  alias: z.string().optional(),
  roadmapId: z.string().optional(),
  provider: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
}).passthrough()
const zProjectCompletionDecisionBody = zProjectReviewBody.extend({
  proposalId: z.string().optional(),
  decision: z.enum(['approve', 'reject']),
  actor: z.string().optional(),
  source: z.string().optional(),
  note: z.string().optional(),
})
const zProjectSupervisorActionBody = zProjectReviewBody.extend({
  action: z.enum(['pause', 'resume']),
  note: z.string().optional(),
})

const zCompletionProposalBody = z.object({
  roadmapId: z.string().min(1, 'roadmapId required'),
  proposedBy: z.string().optional(),
  sessionId: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  unresolvedRisks: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
  expiresAt: z.string().optional(),
}).passthrough()
const zCompletionProposalDecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  actor: z.string().optional(),
  source: z.string().optional(),
  note: z.string().optional(),
}).passthrough()

const zSchedulerBody = z.object({
  action: zSchedulerAction.optional(),
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().optional(),
  maxConcurrent: z.number().int().optional(),
  retryLimit: z.number().int().optional(),
  defaultPipeline: z.array(z.string()).optional(),
  stageProfiles: zStringRecord.optional(),
  stageConcurrency: z.record(z.string(), z.number().int()).optional(),
  profileConcurrency: z.record(z.string(), z.number().int()).optional(),
  capacity: zUnknownRecord.optional(),
  reviewGateIsolation: zUnknownRecord.optional(),
}).passthrough()

const zAgentProfileBody = z.object({
  version: z.string().optional(),
  updatedAt: z.string().optional(),
  description: z.string().optional(),
  model: z.object({
    providerID: z.string().min(1, 'model.providerID required'),
    modelID: z.string().min(1, 'model.modelID required'),
    variant: z.string().optional(),
  }).passthrough(),
  agent: z.string().min(1, 'agent required'),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  permission: z.record(z.string(), z.string()),
  heartbeatMs: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive(),
  role: z.enum(['planning', 'execution']),
  environment: z.union([z.string(), zUnknownRecord]).optional(),
  capabilities: z.array(z.string()).optional(),
  budget: zUnknownRecord.optional(),
  outputContract: zUnknownRecord.optional(),
  promotionState: zPromotionState.optional(),
}).passthrough()

const zEnvironmentActionBody = z.object({
  action: z.enum(['retain', 'release', 'abort', 'cleanup']),
  actor: z.string().optional(),
  note: z.string().optional(),
}).passthrough()
const zDispatchAcquisitionSettleBody = z.object({
  status: z.enum(['released', 'failed']).optional(),
  reason: z.string().min(1).max(1000).optional(),
  note: z.string().max(1000).optional(),
}).passthrough()

const zHumanGateBody = z.object({
  type: z.enum(['task_start', 'stage_transition', 'external_side_effect', 'budget_exception', 'destructive_action', 'credential_use', 'manual']),
  reason: z.string().min(1, 'reason required'),
}).passthrough()
const zHumanGateDecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  scope: z.enum(['once', 'always']).optional(),
  actor: z.string().optional(),
  source: z.string().optional(),
  note: z.string().optional(),
}).passthrough()

const zPersonaCreateBody = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'persona name must be lowercase alphanumeric with single hyphens'),
  description: z.string().max(10_000).optional(),
  prompt: z.string().max(100_000).optional(),
  model: z.string().min(1).max(512).optional(),
  permission: z.record(z.string(), z.unknown()).optional(),
  skillContent: z.string().max(250_000).optional(),
  configDir: z.string().min(1).max(4096).optional(),
})

const zTeamAssemblyRoleBody = z.object({
  role: z.string().min(1, 'role required'),
  purpose: z.string().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  profilePreference: z.string().optional(),
}).passthrough()
const zTeamAssemblyGrantBody = z.object({
  role: z.string().min(1, 'role required'),
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  permission: z.record(z.string(), z.enum(['allow', 'ask', 'deny'])).optional(),
  reason: z.string().optional(),
}).passthrough()
const zTeamAssemblyBody = z.object({
  version: z.number().int().optional(),
  idempotencyKey: z.string().min(1, 'idempotencyKey required'),
  objective: z.string().optional(),
  packageRef: z.object({
    id: z.string().optional(),
    version: z.string().optional(),
    fingerprint: z.string().optional(),
    trustTier: z.string().optional(),
  }).passthrough().optional(),
  blueprint: z.union([z.string(), zUnknownRecord]).optional(),
  blueprintName: z.string().optional(),
  blueprintVersion: z.string().optional(),
  teamName: z.string().optional(),
  team: z.object({
    preferredTeam: z.string().optional(),
    requiredPromotionState: z.array(zPromotionState).optional(),
    roles: z.array(zTeamAssemblyRoleBody).optional(),
  }).passthrough().optional(),
  roles: z.array(zTeamAssemblyRoleBody).optional(),
  grants: z.array(zTeamAssemblyGrantBody).optional(),
  requiredPromotionState: z.array(zPromotionState).optional(),
  budget: zUnknownRecord.optional(),
  gates: z.array(zUnknownRecord).optional(),
  evidenceRequirements: z.array(zUnknownRecord).optional(),
}).passthrough()
const zTeamAssignmentBody = zTeamAssemblyBody.extend({
  taskId: z.string().optional(),
  roadmapId: z.string().optional(),
  delegationId: z.string().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  scope: z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    permissions: z.record(z.string(), z.enum(['allow', 'ask', 'deny'])).optional(),
  }).passthrough().optional(),
  requiredEvidence: z.array(zUnknownRecord).optional(),
}).passthrough()
const zTeamAssignmentReceiptBody = z.object({
  receiptKind: z.enum(['gate_result', 'review_outcome', 'completion']),
  gateId: z.string().optional(),
  gateType: z.enum(['review', 'evidence', 'eval', 'human_approval', 'completion_quality']).optional(),
  status: z.enum(['pending', 'passed', 'failed', 'blocked', 'approved', 'rejected']),
  summary: z.string().min(1, 'summary required'),
  evidence: z.array(z.string()).optional(),
  reviewer: z.string().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().optional(),
  metadata: zUnknownRecord.optional(),
}).passthrough()
const zAgentTeamBody = z.object({
  name: z.string().optional(),
  team: zUnknownRecord.optional(),
  gateId: z.string().optional(),
  approvedGateId: z.string().optional(),
  taskId: z.string().optional(),
  roadmapId: z.string().optional(),
  stage: z.string().optional(),
  version: z.string().optional(),
  promotionState: zPromotionState.optional(),
  roles: zStringRecord.optional(),
  capabilityRequirements: z.record(z.string(), z.array(z.string())).optional(),
  qualitySpecDefaults: zUnknownRecord.optional(),
  environment: z.union([z.string(), zUnknownRecord]).optional(),
}).passthrough()
const zAgentTeamNamedBody = zAgentTeamBody.extend({ name: z.string().min(1, 'name required') }).passthrough()
const zAgentTeamBindBody = z.object({
  roadmapId: z.string().optional(),
  taskId: z.string().optional(),
  gateId: z.string().optional(),
  approvedGateId: z.string().optional(),
}).passthrough()
const zAgentTeamGateBody = z.object({
  gateId: z.string().optional(),
  approvedGateId: z.string().optional(),
}).passthrough()
const zBlueprintBody = z.object({
  blueprint: zUnknownRecord.optional(),
  gateId: z.string().optional(),
  approvedGateId: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  revision: z.string().optional(),
  profiles: z.record(z.string(), zUnknownRecord).optional(),
  teams: z.record(z.string(), zUnknownRecord).optional(),
  expected: zUnknownRecord.optional(),
}).passthrough()
const zPromotionMetricBody = z.object({
  id: z.string().min(1, 'metric id required'),
  score: z.number(),
  maxScore: z.number(),
  passed: z.boolean(),
  diagnostic: z.string().optional(),
}).passthrough()
const zPromotionThresholdBody = z.object({
  id: z.string().min(1, 'threshold id required'),
  metric: z.string().min(1, 'threshold metric required'),
  minScore: z.number().optional(),
  minPercentage: z.number().optional(),
  actualScore: z.number().optional(),
  actualPercentage: z.number().optional(),
  passed: z.boolean().optional(),
}).passthrough()
const zPromotionScorecardBody = z.object({
  id: z.string().optional(),
  subjectKind: zPromotionSubjectKind,
  subjectName: z.string().min(1, 'subjectName required'),
  subjectRevision: z.string().optional(),
  sourceKind: zPromotionSourceKind.optional(),
  sourceId: z.string().min(1, 'sourceId required'),
  sourceVersion: z.string().optional(),
  metrics: z.array(zPromotionMetricBody).optional(),
  thresholds: z.array(zPromotionThresholdBody).optional(),
  evidence: z.array(z.string()).optional(),
  conclusion: z.string().optional(),
  recommendation: zPromotionRecommendation.optional(),
  status: zPromotionState.optional(),
  regression: zUnknownRecord.optional(),
  gateId: z.string().optional(),
  projectPromotionState: z.boolean().optional(),
}).passthrough()
const zPromotionDecisionBody = z.object({
  decisionId: z.string().optional(),
  subjectKind: zPromotionSubjectKind.optional(),
  subjectName: z.string().optional(),
  action: zPromotionAction.optional(),
  scorecardId: z.string().optional(),
  gateId: z.string().optional(),
  note: z.string().optional(),
}).passthrough()

/** @public Loaded from the built module by the API reference generator. */
export const WORK_API_ROUTE_CONTRACTS = defineApiRouteContracts([
  { method: 'POST', path: '/sessions/admit', bodySchema: zSessionAdmitBody, responses: [201, 400, 429] },
  { method: 'POST', path: '/personas', bodySchema: zPersonaCreateBody, responses: [201, 400, 422] },
  { method: 'POST', path: '/agent-presences', bodySchema: zAgentPresenceBody, responses: [201, 400] },
  { method: 'GET', path: '/agent-presences/{id}', responses: [200, 404] },
  { method: 'PATCH', path: '/agent-presences/{id}', bodySchema: zAgentPresencePatchBody, responses: [200, 400, 404] },
  { method: 'POST', path: '/tasks', bodySchema: zTaskCreateBody, responses: [200, 400] },
  { method: 'POST', path: '/delegations', bodySchema: delegationRequestSchema, responses: [200, 400] },
  { method: 'POST', path: '/tasks/bulk', bodySchema: zTaskBulkCreateBody, responses: [200, 400] },
  { method: 'PATCH', path: '/tasks/bulk', bodySchema: zTaskBulkPatchBody, responses: [200, 400] },
  { method: 'GET', path: '/tasks/{id}', responses: [200, 404] },
  { method: 'PATCH', path: '/tasks/{id}', bodySchema: zTaskUpdateBody, responses: [200, 400, 404] },
  { method: 'DELETE', path: '/tasks/{id}', bodySchema: zDestructiveActionBody, responses: [200, 400, 404, 428] },
  { method: 'POST', path: '/tasks/{id}/action', bodySchema: zTaskActionBody, responses: [200, 400, 404] },
  { method: 'POST', path: '/tasks/{id}/archive', bodySchema: zArchiveBody, responses: [200, 400, 404] },
  { method: 'POST', path: '/tasks/{id}/dependencies', bodySchema: zTaskDependencyCreateBody, responses: [200, 400] },
  { method: 'DELETE', path: '/tasks/{id}/dependencies', requestBody: false, responses: [200, 400] },
  { method: 'POST', path: '/projects', bodySchema: zProjectCreateBody, responses: [200, 400, 403, 409, 502] },
  { method: 'POST', path: '/projects/review-now', bodySchema: zProjectReviewBody, responses: [200, 400] },
  { method: 'POST', path: '/projects/completion-decision', bodySchema: zProjectCompletionDecisionBody, responses: [200, 400, 404] },
  { method: 'POST', path: '/projects/supervisor-action', bodySchema: zProjectSupervisorActionBody, responses: [200, 400] },
  { method: 'POST', path: '/roadmaps', bodySchema: zRoadmapCreateBody, responses: [200, 400] },
  { method: 'POST', path: '/roadmaps/with-tasks', bodySchema: zRoadmapWithTasksBody, responses: [200, 400] },
  { method: 'POST', path: '/workflows/plan-initiative', bodySchema: zPlanInitiativeBody, responses: [200, 400, 422] },
  { method: 'POST', path: '/workflows/dispatch-now', bodySchema: zDispatchNowBody, responses: [200, 400, 404] },
  { method: 'GET', path: '/roadmaps/{id}', responses: [200, 404] },
  { method: 'PATCH', path: '/roadmaps/{id}', bodySchema: zRoadmapUpdateBody, responses: [200, 400, 404] },
  { method: 'DELETE', path: '/roadmaps/{id}', bodySchema: zDestructiveActionBody, responses: [200, 400, 404, 428] },
  { method: 'POST', path: '/roadmaps/{id}/archive', bodySchema: zArchiveBody, responses: [200, 400, 404] },
  { method: 'POST', path: '/roadmaps/{id}/recompute', requestBody: false, responses: [200, 404] },
  { method: 'GET', path: '/roadmaps/{id}/memory', responses: [200, 404] },
  { method: 'POST', path: '/roadmap-completion-proposals', bodySchema: zCompletionProposalBody, responses: [200, 400] },
  { method: 'GET', path: '/roadmap-completion-proposals/{id}', responses: [200, 404] },
  { method: 'POST', path: '/roadmap-completion-proposals/{id}/decision', bodySchema: zCompletionProposalDecisionBody, responses: [200, 400, 404] },
  { method: 'POST', path: '/roadmap-supervisors', bodySchema: zRoadmapSupervisorCreateBody, responses: [200, 400] },
  { method: 'PATCH', path: '/roadmap-supervisors/{id}', bodySchema: zRoadmapSupervisorUpdateBody, responses: [200, 404] },
  { method: 'POST', path: '/roadmap-supervisors/{id}/archive', bodySchema: zArchiveBody, responses: [200, 404] },
  { method: 'POST', path: '/project-bindings', bodySchema: zProjectBindingBody, responses: [200, 400, 403] },
  { method: 'GET', path: '/project-bindings/{id}', responses: [200, 404] },
  { method: 'PATCH', path: '/project-bindings/{id}', bodySchema: zProjectBindingPatchBody, responses: [200, 400, 403, 404] },
  { method: 'DELETE', path: '/project-bindings/{id}', requestBody: false, responses: [200] },
  { method: 'GET', path: '/dispatch-acquisitions', responses: [200] },
  { method: 'POST', path: '/dispatch-acquisitions/{dispatchId}/{kind}/settle', bodySchema: zDispatchAcquisitionSettleBody, responses: [200, 400, 404] },
  { method: 'POST', path: '/environments/reconcile', requestBody: false, responses: [200] },
  { method: 'POST', path: '/environments/{id}/action', bodySchema: zEnvironmentActionBody, responses: [200, 400, 404] },
  { method: 'GET', path: '/runs/{id}', responses: [200, 403, 404] },
  { method: 'POST', path: '/human-gates', bodySchema: zHumanGateBody, responses: [200, 400] },
  { method: 'POST', path: '/human-gates/{id}/decision', bodySchema: zHumanGateDecisionBody, responses: [200, 400, 403, 404] },
  { method: 'POST', path: '/scheduler', bodySchema: zSchedulerBody, responses: [200, 400] },
  { method: 'POST', path: '/scheduler/pause', requestBody: false, responses: [200] },
  { method: 'POST', path: '/scheduler/resume', requestBody: false, responses: [200] },
  { method: 'POST', path: '/scheduler/run', requestBody: false, responses: [200] },
  { method: 'POST', path: '/agent-factory/teams/assemble', bodySchema: zTeamAssemblyBody, responses: [200, 400, 422] },
  { method: 'POST', path: '/agent-teams/validate', bodySchema: zAgentTeamNamedBody, responses: [200, 400, 422] },
  { method: 'POST', path: '/agent-teams/propose', bodySchema: zAgentTeamNamedBody, responses: [202, 400, 422] },
  { method: 'GET', path: '/agent-teams/{name}', responses: [200, 404] },
  { method: 'PUT', path: '/agent-teams/{name}', bodySchema: zAgentTeamBody, responses: [200, 202, 400, 403, 404, 409, 422] },
  { method: 'POST', path: '/agent-teams/{name}/apply', bodySchema: zAgentTeamBody, responses: [200, 202, 400, 403, 404, 409, 422] },
  { method: 'POST', path: '/agent-teams/{name}/bind', bodySchema: zAgentTeamBindBody, responses: [200, 202, 400, 403, 404, 409] },
  { method: 'DELETE', path: '/agent-teams/{name}', bodySchema: zAgentTeamGateBody, responses: [200, 202, 400, 404, 409] },
  { method: 'PUT', path: '/profiles/{name}', bodySchema: zAgentProfileBody, responses: [200, 422] },
  { method: 'POST', path: '/profiles/{name}', bodySchema: zAgentProfileBody, responses: [200, 422] },
  { method: 'DELETE', path: '/profiles/{name}', requestBody: false, responses: [200] },
  { method: 'POST', path: '/blueprints/preview', bodySchema: zBlueprintBody, responses: [200, 400] },
  { method: 'POST', path: '/blueprints/apply', bodySchema: zBlueprintBody, responses: [200, 202, 400, 404, 409, 422] },
  { method: 'POST', path: '/team-assignments', bodySchema: zTeamAssignmentBody, responses: [200, 400, 422] },
  { method: 'POST', path: '/team-assignments/{id}/receipts', bodySchema: zTeamAssignmentReceiptBody, responses: [200, 400, 422] },
  { method: 'POST', path: '/promotion/scorecards', bodySchema: zPromotionScorecardBody, responses: [201, 400] },
  { method: 'GET', path: '/promotion/scorecards/{id}', responses: [200, 404] },
  { method: 'GET', path: '/promotion/state', responses: [200, 400] },
  { method: 'POST', path: '/promotion/decisions', bodySchema: zPromotionDecisionBody, responses: [200, 202, 400, 404] },
] as const)

export function workRoutes(): RouteHandler[] {
  return [
    async ({ req, url }) => {
      if (req.method === 'POST' && url.pathname === '/sessions/admit') {
        const body = await readJsonBodyAs(req, zSessionAdmitBody)
        const { admitOpenCodeSession } = await import('../opencode-session-runtime.js')
        try {
          const admission = await admitOpenCodeSession(body || {})
          return json({ admission }, 201)
        } catch (err: any) {
          const message = err?.message || String(err)
          if (/capacity full/i.test(message)) throw new HttpError(429, message)
          throw new HttpError(400, message)
        }
      }
    },
    async ({ req, url }) => {
      if (req.method === 'GET' && url.pathname === '/personas') {
        return json({ personas: listPersonas(url.searchParams.get('configDir') || undefined) })
      }
      if (req.method === 'POST' && url.pathname === '/personas') {
        const body = await readJsonBodyAs(req, zPersonaCreateBody)
        try {
          return json({ persona: createPersona(body) }, 201)
        } catch (err) {
          if (err instanceof PersonaValidationError) throw new HttpError(422, err.message)
          throw err
        }
      }
      if (req.method === 'GET' && url.pathname === '/agent-presences') {
        const includeArchived = url.searchParams.get('includeArchived') === 'true'
        const status = url.searchParams.get('status') || undefined
        return json({ agentPresences: listAgentPresences({ status: status as any, includeArchived }) })
      }
      if (req.method === 'POST' && url.pathname === '/agent-presences') {
        const body = await readJsonBodyAs(req, zAgentPresenceBody)
        const { skipAgentCheck: _ignore, ...safe } = (body || {}) as any
        void _ignore
        return json({ agentPresence: createAgentPresence(safe) }, 201)
      }
      const presenceMatch = pathMatch(url.pathname, /^\/agent-presences\/([^/]+)$/)
      if (presenceMatch && req.method === 'GET') {
        const agentPresence = getAgentPresence(presenceMatch[0])
        if (!agentPresence) throw new HttpError(404, 'agent presence not found')
        return json({ agentPresence })
      }
      if (presenceMatch && req.method === 'PATCH') {
        const body = await readJsonBodyAs(req, zAgentPresencePatchBody)
        const agentPresence = updateAgentPresence(presenceMatch[0], body || {})
        if (!agentPresence) throw new HttpError(404, 'agent presence not found')
        return json({ agentPresence })
      }
    },
async ({ req, url, client, channels }) => {
    if (req.method === 'GET' && url.pathname === '/tasks') {
      const snapshot = getWorkQueueSnapshot()
      return json({ tasks: snapshot.tasks.map(compactTask), counts: snapshot.counts, roadmaps: snapshot.state.roadmaps.map(compactRoadmap), runs: snapshot.state.runs.slice(-20).map(compactRun) })
    }

    if (req.method === 'GET' && url.pathname === '/briefing') {
      const [questions, permissions] = await Promise.all([
        listPendingQuestions().catch(() => []),
        listPendingPermissions().catch(() => []),
      ])
      const briefing = buildMainAgentBriefing({ questions, permissions, limit: Number(url.searchParams.get('limit') || 8) })
      return json({ briefing, text: formatMainAgentBriefing(briefing) })
    }

    if (req.method === 'POST' && url.pathname === '/tasks') {
      const body = await readJsonBodyAs(req, zTaskCreateBody)
      return json({ task: exposeTask(createWorkTask(body as any)) })
    }

    if (req.method === 'POST' && url.pathname === '/delegations') {
      const result = submitDelegation(await readJsonBodyAs(req, delegationRequestSchema))
      return json(result, result.ok ? 200 : 400, result.ok ? () => {
        deliverDelegationProgress(channels, {}, { sessionClient: client as any }).catch((err: any) => queueEvent(`Delegation progress notify failed: ${err?.message || err}`))
      } : undefined)
    }

    if (req.method === 'POST' && url.pathname === '/tasks/bulk') {
      const body = await readJsonBodyAs(req, zTaskBulkCreateBody)
      const tasks = createWorkTasks(body.tasks as any, body.roadmapId)
      return json({ tasks: tasks.map(compactTask), created: tasks.length })
    }

    if (req.method === 'PATCH' && url.pathname === '/tasks/bulk') {
      const body = await readJsonBodyAs(req, zTaskBulkPatchBody)
      if (wantsDryRun(url, body)) return json({ preview: previewBulkTaskUpdate(body.updates || body.tasks || [], loadWorkState()) })
      const result = updateWorkTasks((body.updates || body.tasks || []) as any)
      await abortSessions(client, result.abortedSessionIds)
      return json({ ...result, tasks: result.tasks.map(exposeTask) })
    }

    const taskMatch = pathMatch(url.pathname, /^\/tasks\/([^/]+)$/)
    if (req.method === 'GET' && taskMatch) {
      const task = getWorkTask(taskMatch[0])
      if (!task) throw new HttpError(404, 'task not found')
      return json({ task: exposeTask(task) })
    }

    if (req.method === 'PATCH' && taskMatch) {
      const result = updateWorkTaskWithResult(taskMatch[0], await readJsonBodyAs(req, zTaskUpdateBody) as any)
      if (!result) throw new HttpError(404, 'task not found')
      await abortSessions(client, result.abortedSessionId ? [result.abortedSessionId] : [])
      return json({ ...result, task: exposeTask(result.task) })
    }

    if (req.method === 'DELETE' && taskMatch) {
      const body = await readJsonBodyAs(req, zDestructiveActionBody)
      if (wantsDryRun(url, body)) return json({ preview: previewTaskDelete(taskMatch[0], loadWorkState()) })
      const approval = requireDestructiveHttpApproval(req, body, 'task.delete', taskMatch[0])
      if (approval) return approval
      const result = deleteWorkTask(taskMatch[0])
      if (!result.deleted) throw new HttpError(404, 'task not found')
      if (result.abortedSessionId) await abortSessions(client, [result.abortedSessionId])
      consumeDestructiveHttpApproval(req, body, 'task.delete')
      auditHttp(req, 'task.delete', taskMatch[0], 'ok', { abortedSessionId: result.abortedSessionId })
      return json(result)
    }

    const taskArchiveMatch = pathMatch(url.pathname, /^\/tasks\/([^/]+)\/archive$/)
    if (req.method === 'POST' && taskArchiveMatch) {
      const body = await readJsonBodyAs(req, zArchiveBody)
      const result = archiveWorkTask(taskArchiveMatch[0], { note: body.note })
      if (!result) throw new HttpError(404, 'task not found')
      if (result.abortedSessionId) await abortSessions(client, [result.abortedSessionId])
      return json(result)
    }

    const taskReadinessMatch = pathMatch(url.pathname, /^\/tasks\/([^/]+)\/readiness$/)
    if (req.method === 'GET' && taskReadinessMatch) {
      const readiness = getWorkTaskReadiness(taskReadinessMatch[0])
      if (!readiness) throw new HttpError(404, 'task not found')
      return json({ readiness })
    }

    const taskDependencyMatch = pathMatch(url.pathname, /^\/tasks\/([^/]+)\/dependencies$/)
    if (req.method === 'GET' && taskDependencyMatch) {
      return json({ dependencies: listWorkDependencies(taskDependencyMatch[0]) })
    }
    if (req.method === 'POST' && taskDependencyMatch) {
      const body = await readJsonBodyAs(req, zTaskDependencyCreateBody)
      return json({ dependency: addWorkDependency({ taskId: taskDependencyMatch[0], dependsOnTaskId: body.dependsOnTaskId, type: body.type }) })
    }
    if (req.method === 'DELETE' && taskDependencyMatch) {
      const dependsOnTaskId = url.searchParams.get('dependsOnTaskId') || ''
      if (!dependsOnTaskId) throw new HttpError(400, 'dependsOnTaskId required')
      return json({ deleted: deleteWorkDependency(taskDependencyMatch[0], dependsOnTaskId, url.searchParams.get('type') as any || undefined) })
    }

    const taskActionMatch = pathMatch(url.pathname, /^\/tasks\/([^/]+)\/action$/)
    if (req.method === 'POST' && taskActionMatch) {
      const body = await readJsonBodyAs(req, zTaskActionBody)
      const result = applyWorkTaskAction(taskActionMatch[0], body.action, { stage: body.stage, note: body.note })
      if (!result) throw new HttpError(404, 'task not found')
      if (result.abortedSessionId) await abortSessions(client, [result.abortedSessionId])
      return json(result)
    }

    if (req.method === 'GET' && url.pathname === '/roadmaps') {
      const snapshot = getWorkQueueSnapshot()
      return json({ roadmaps: snapshot.state.roadmaps.map(compactRoadmap) })
    }

    if (req.method === 'POST' && url.pathname === '/projects') {
      const body = await readJsonBodyAs(req, zProjectCreateBody)
      const scope = projectBindingScopeFromBody(body)
      validateProjectBindingSurfaceBody(body, scope)
      const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
      if (idempotencyKey) {
        const receipt = getDelegationReceipt(idempotencyKey)
        if (receipt) return json(projectCreateReplayFromReceipt(receipt))
      }
      const existingBinding = projectBindings.listProjectBindings({ alias: body.alias, scope })[0]
      if (existingBinding && idempotencyKey) throw new HttpError(409, `project alias already exists for a different create request: ${body.alias}`)
      if (!body.allowRebind && existingBinding) throw new HttpError(409, `project alias already exists: ${body.alias}`)
      const title = String(body.title || body.alias)
      if (!body.allowRebind) {
        const preSessionSurfaceConflict = scope !== 'opencode'
          ? projectBindings.listProjectBindings(projectSurfaceFilter({ ...body, scope }, ''))[0]
          : undefined
        if (preSessionSurfaceConflict) throw new HttpError(409, `project surface already bound: ${preSessionSurfaceConflict.alias}`)
      }
      const sessionId = body.sessionId || await createProjectSession(client, body.alias, title)
      if (!body.allowRebind && scope === 'opencode') {
        const surfaceConflict = projectBindings.listProjectBindings(projectSurfaceFilter({ ...body, scope }, sessionId))[0]
        if (surfaceConflict) throw new HttpError(409, `project surface already bound: ${surfaceConflict.alias}`)
      }
      const { roadmap, tasks, supervisor, binding, idempotencyStatus } = createSupervisedProject({
        idempotencyKey,
        roadmap: { title, priority: body.priority, agentTeam: body.agentTeam, environment: body.environment as any, qualitySpec: body.qualitySpec as any },
        tasks: body.tasks as any,
        supervisor: { sessionId, isDefault: true, profile: body.profile, cadence: body.cadence, eventTriggers: body.eventTriggers, completionPolicy: body.completionPolicy, note: body.note },
        binding: { alias: body.alias, sessionId, scope, provider: body.provider, chatId: body.chatId, threadId: body.threadId, title, allowRebind: body.allowRebind, notificationMode: body.notificationMode, mutedUntil: body.mutedUntil, quietHours: body.quietHours, lastDigestAt: body.lastDigestAt },
        event: { type: 'project.wizard.created', payload: { alias: body.alias, sessionId, idempotencyKey: body.idempotencyKey, sourceType: body.sourceType } },
      })
      const status = getProjectStatus({ alias: binding.alias })
      return json({ roadmap: compactRoadmap(roadmap), tasks: tasks.map(compactTask), supervisor, binding, status, text: formatProjectStatus(status), idempotencyStatus })
    }

    if (req.method === 'GET' && url.pathname === '/projects/summary') {
      const status = getProjectStatus(projectContextFromUrl(url))
      return json({ status, text: formatProjectStatus(status) })
    }

    if (req.method === 'GET' && url.pathname === '/projects/digest') {
      const digest = getProjectDigest(projectContextFromUrl(url), undefined, Number(url.searchParams.get('limit') || 20))
      return json({ digest, text: formatProjectDigest(digest) })
    }

    if (req.method === 'POST' && url.pathname === '/projects/review-now') {
      const body = await readJsonBodyAs(req, zProjectReviewBody)
      return json(requestProjectReview(projectContextFromBody(body)))
    }

    if (req.method === 'POST' && url.pathname === '/projects/completion-decision') {
      const body = await readJsonBodyAs(req, zProjectCompletionDecisionBody)
      let proposalId = body.proposalId
      if (!proposalId) {
        const resolution = projectBindings.resolveProjectContext(projectContextFromBody(body))
        if (resolution.status !== 'resolved' || !resolution.roadmap) return json({ resolution, error: resolution.reason })
        const proposals = listRoadmapCompletionProposals({ roadmapId: resolution.roadmap.id, status: 'open' })
        if (proposals.length !== 1) return json({ resolution, proposals, error: proposals.length ? 'multiple completion proposals match; specify proposalId' : 'no pending completion proposal for project' })
        proposalId = proposals[0]!.id
      }
      const identity = httpCallerIdentity(req)
      const result = decideRoadmapCompletionProposal(proposalId, { decision: body.decision, actor: identity.actor, source: identity.source, note: body.note })
      if (!result) throw new HttpError(404, 'roadmap completion proposal not found')
      return json(result)
    }

    if (req.method === 'POST' && url.pathname === '/projects/supervisor-action') {
      const body = await readJsonBodyAs(req, zProjectSupervisorActionBody)
      const resolution = projectBindings.resolveProjectContext(projectContextFromBody(body))
      if (resolution.status !== 'resolved' || !resolution.supervisor) return json({ resolution, error: resolution.reason || 'No active supervisor for this project.' })
      const supervisor = updateRoadmapSupervisor(resolution.supervisor.supervisorId, { status: body.action === 'pause' ? 'paused' : 'active', note: body.note })
      return json({ resolution, supervisor })
    }

    if (req.method === 'POST' && url.pathname === '/roadmaps') {
      const body = await readJsonBodyAs(req, zRoadmapCreateBody)
      return json({ roadmap: compactRoadmap(createRoadmap(body as any)) })
    }

    if (req.method === 'POST' && url.pathname === '/roadmaps/with-tasks') {
      const body = await readJsonBodyAs(req, zRoadmapWithTasksBody)
      const result = createRoadmapWithTasks(body as any)
      return json({ roadmap: compactRoadmap(result.roadmap), tasks: result.tasks.map(exposeTask) })
    }

    if (req.method === 'POST' && url.pathname === '/workflows/plan-initiative') {
      const body = await readJsonBodyAs(req, zPlanInitiativeBody)
      let result: ReturnType<typeof planInitiative>
      try {
        result = planInitiative(body as any)
      } catch (err: any) {
        throw new HttpError(422, redactSensitiveText(err?.message || String(err)))
      }
      return json({
        roadmap: compactRoadmap(result.roadmap),
        tasks: result.tasks.map(exposeTask),
        dependencies: result.dependencies,
        supervisor: result.supervisor,
      })
    }

    if (req.method === 'POST' && url.pathname === '/workflows/dispatch-now') {
      const body = await readJsonBodyAs(req, zDispatchNowBody)
      const taskId = body.taskId ? String(body.taskId) : undefined
      const roadmapId = body.roadmapId ? String(body.roadmapId) : undefined
      const pre = loadWorkState()
      if (taskId && !pre.tasks.some(task => task.id === taskId)) throw new HttpError(404, 'task not found')
      if (roadmapId && !pre.roadmaps.some(roadmap => roadmap.id === roadmapId)) throw new HttpError(404, 'roadmap not found')
      // dispatch_now HONORS the durable scheduler.enabled state: it never
      // globally un-pauses a scheduler an operator paused for maintenance. The
      // scheduler cycle itself does not gate on scheduler.enabled (that gating
      // lives in the daemon/heartbeat callers), so when paused this is a truthful
      // no-op — no cycle runs, nothing dispatches, and no durable config changes.
      const schedulerPaused = !getConfig().scheduler.enabled
      // The per-TASK resume is the caller's explicit intent for the named target
      // and stays scoped to that one task; it never touches global scheduler
      // config. Skipped when paused so the response is a genuine no-op.
      let resumedTask = false
      if (taskId && !schedulerPaused) {
        const target = pre.tasks.find(task => task.id === taskId)
        if (target?.status === 'paused') { applyWorkTaskAction(taskId, 'resume', {}); resumedTask = true }
      }
      const snapshots = schedulerPaused ? undefined : await schedulerCycleSnapshots(client)
      const after = snapshots?.after || pre
      const beforeRunIds = new Set((snapshots?.before || pre).runs.map(run => run.id))
      const taskRoadmap = new Map(after.tasks.map(task => [task.id, task.roadmapId]))
      // Report the FULL set actually dispatched this cycle. A taskId/roadmapId
      // scope does NOT hide the rest of the cycle's dispatches (the cycle is
      // unscoped and dispatches all ready work up to maxConcurrent); it only
      // ensures the named target is eligible and highlights whether it dispatched.
      const dispatched = after.runs.filter(run => !beforeRunIds.has(run.id)).map(compactRun)
      const requested = taskId || roadmapId ? { taskId, roadmapId } : undefined
      const requestedDispatched = requested
        ? dispatched.some(run => (!taskId || run.taskId === taskId) && (!roadmapId || taskRoadmap.get(run.taskId) === roadmapId))
        : undefined
      const tasks = listWorkTaskViews(after)
      return json({
        scope: { taskId, roadmapId },
        schedulerPaused,
        schedulerEnabled: getConfig().scheduler.enabled,
        resumedTask,
        requested,
        requestedDispatched,
        guidance: schedulerPaused ? 'Scheduler is paused; nothing was dispatched. Resume it explicitly with scheduler_resume (or POST /scheduler {action:"resume"}) before dispatching.' : undefined,
        dispatched,
        dispatchedTotal: dispatched.length,
        counts: summarizeWorkTasks(tasks),
        leases: getSchedulerLeaseSummary(after),
      })
    }

    const roadmapMatch = pathMatch(url.pathname, /^\/roadmaps\/([^/]+)$/)
    if (req.method === 'GET' && roadmapMatch) {
      const roadmap = loadWorkState().roadmaps.find(row => row.id === roadmapMatch[0])
      if (!roadmap) throw new HttpError(404, 'roadmap not found')
      return json({ roadmap: compactRoadmap(roadmap) })
    }

    if (req.method === 'PATCH' && roadmapMatch) {
      const roadmap = updateRoadmap(roadmapMatch[0], await readJsonBodyAs(req, zRoadmapUpdateBody) as any)
      if (!roadmap) throw new HttpError(404, 'roadmap not found')
      return json({ roadmap: compactRoadmap(roadmap) })
    }

    if (req.method === 'DELETE' && roadmapMatch) {
      const body = await readJsonBodyAs(req, zDestructiveActionBody)
      if (wantsDryRun(url, body)) return json({ preview: previewRoadmapDelete(roadmapMatch[0], loadWorkState()) })
      const approval = requireDestructiveHttpApproval(req, body, 'roadmap.delete', roadmapMatch[0])
      if (approval) return approval
      const result = deleteRoadmap(roadmapMatch[0])
      if (!result.deleted) throw new HttpError(404, 'roadmap not found')
      await abortSessions(client, result.abortedSessionIds)
      consumeDestructiveHttpApproval(req, body, 'roadmap.delete')
      auditHttp(req, 'roadmap.delete', roadmapMatch[0], 'ok', { abortedSessionIds: result.abortedSessionIds })
      return json(result)
    }

    const roadmapArchiveMatch = pathMatch(url.pathname, /^\/roadmaps\/([^/]+)\/archive$/)
    if (req.method === 'POST' && roadmapArchiveMatch) {
      const body = await readJsonBodyAs(req, zArchiveBody)
      const result = archiveRoadmap(roadmapArchiveMatch[0], { note: body.note })
      if (!result) throw new HttpError(404, 'roadmap not found')
      await abortSessions(client, result.abortedSessionIds)
      return json(result)
    }

    const roadmapRecomputeMatch = pathMatch(url.pathname, /^\/roadmaps\/([^/]+)\/recompute$/)
    if (req.method === 'POST' && roadmapRecomputeMatch) {
      const roadmap = recomputeRoadmapStatus(roadmapRecomputeMatch[0])
      if (!roadmap) throw new HttpError(404, 'roadmap not found')
      return json({ roadmap })
    }

    const roadmapMemoryMatch = pathMatch(url.pathname, /^\/roadmaps\/([^/]+)\/memory$/)
    if (req.method === 'GET' && roadmapMemoryMatch) {
      const memory = buildRoadmapMemory(roadmapMemoryMatch[0])
      if (!memory) throw new HttpError(404, 'roadmap not found')
      return json({ memory })
    }

    if (req.method === 'GET' && url.pathname === '/roadmap-completion-proposals') {
      return json({ proposals: listRoadmapCompletionProposals({ roadmapId: url.searchParams.get('roadmapId') || undefined, status: url.searchParams.get('status') as any || undefined }) })
    }

    if (req.method === 'POST' && url.pathname === '/roadmap-completion-proposals') {
      const body = await readJsonBodyAs(req, zCompletionProposalBody)
      return json(proposeRoadmapCompletion(body))
    }

    const completionProposalMatch = pathMatch(url.pathname, /^\/roadmap-completion-proposals\/([^/]+)$/)
    if (req.method === 'GET' && completionProposalMatch) {
      const proposal = getRoadmapCompletionProposal(completionProposalMatch[0])
      if (!proposal) throw new HttpError(404, 'roadmap completion proposal not found')
      return json({ proposal })
    }

    const completionProposalDecisionMatch = pathMatch(url.pathname, /^\/roadmap-completion-proposals\/([^/]+)\/decision$/)
    if (req.method === 'POST' && completionProposalDecisionMatch) {
      const body = await readJsonBodyAs(req, zCompletionProposalDecisionBody)
      const identity = httpCallerIdentity(req)
      const result = decideRoadmapCompletionProposal(completionProposalDecisionMatch[0], { decision: body.decision, actor: identity.actor, source: identity.source, note: body.note })
      if (!result) throw new HttpError(404, 'roadmap completion proposal not found')
      return json(result)
    }

    if (req.method === 'GET' && url.pathname === '/roadmap-supervisors') {
      return json({ supervisors: listRoadmapSupervisors({ roadmapId: url.searchParams.get('roadmapId') || undefined, status: url.searchParams.get('status') as any || undefined, includeArchived: url.searchParams.get('includeArchived') === 'true' }) })
    }

    if (req.method === 'POST' && url.pathname === '/roadmap-supervisors') {
      const body = await readJsonBodyAs(req, zRoadmapSupervisorCreateBody)
      if (!body.roadmapId || !body.sessionId) throw new HttpError(400, 'roadmapId and sessionId required')
      return json({ supervisor: createRoadmapSupervisor(body) })
    }

    const supervisorMatch = pathMatch(url.pathname, /^\/roadmap-supervisors\/([^/]+)$/)
    if (req.method === 'GET' && supervisorMatch) {
      const supervisor = getRoadmapSupervisor(supervisorMatch[0])
      if (!supervisor) throw new HttpError(404, 'roadmap supervisor not found')
      return json({ supervisor })
    }

    if (req.method === 'PATCH' && supervisorMatch) {
      const supervisor = updateRoadmapSupervisor(supervisorMatch[0], await readJsonBodyAs(req, zRoadmapSupervisorUpdateBody))
      if (!supervisor) throw new HttpError(404, 'roadmap supervisor not found')
      return json({ supervisor })
    }

    const supervisorArchiveMatch = pathMatch(url.pathname, /^\/roadmap-supervisors\/([^/]+)\/archive$/)
    if (req.method === 'POST' && supervisorArchiveMatch) {
      const body = await readJsonBodyAs(req, zArchiveBody)
      const supervisor = archiveRoadmapSupervisor(supervisorArchiveMatch[0], { note: body.note })
      if (!supervisor) throw new HttpError(404, 'roadmap supervisor not found')
      return json({ supervisor })
    }

    if (req.method === 'GET' && url.pathname === '/project-bindings/resolve') {
      return json({ resolution: projectBindings.resolveProjectContext({ alias: url.searchParams.get('alias') || undefined, roadmapId: url.searchParams.get('roadmapId') || undefined, provider: url.searchParams.get('provider') || undefined, chatId: url.searchParams.get('chatId') || undefined, threadId: url.searchParams.has('threadId') ? url.searchParams.get('threadId') || '' : undefined, sessionId: url.searchParams.get('sessionId') || undefined }) })
    }

    if (req.method === 'GET' && url.pathname === '/project-bindings') {
      return json({ bindings: projectBindings.listProjectBindings({ alias: url.searchParams.get('alias') || undefined, roadmapId: url.searchParams.get('roadmapId') || undefined, sessionId: url.searchParams.get('sessionId') || undefined, scope: url.searchParams.get('scope') as any || undefined, provider: url.searchParams.get('provider') || undefined, chatId: url.searchParams.get('chatId') || undefined, threadId: url.searchParams.has('threadId') ? url.searchParams.get('threadId') || '' : undefined }) })
    }

    if (req.method === 'POST' && url.pathname === '/project-bindings') {
      const body = await readJsonBodyAs(req, zProjectBindingBody)
      validateProjectBindingSurfaceBody(body, projectBindingScopeFromBody(body))
      return json({ binding: projectBindings.upsertProjectBinding(body) })
    }

    const projectBindingMatch = pathMatch(url.pathname, /^\/project-bindings\/([^/]+)$/)
    if (req.method === 'GET' && projectBindingMatch) {
      const binding = projectBindings.getProjectBinding(projectBindingMatch[0])
      if (!binding) throw new HttpError(404, 'project binding not found')
      return json({ binding })
    }

    if (req.method === 'PATCH' && projectBindingMatch) {
      const current = projectBindings.getProjectBinding(projectBindingMatch[0])
      if (!current) throw new HttpError(404, 'project binding not found')
      const body = await readJsonBodyAs(req, zProjectBindingPatchBody)
      const next = { ...current, ...body }
      validateProjectBindingSurfaceBody(next, projectBindingScopeFromBody(next))
      const binding = projectBindings.updateProjectBinding(projectBindingMatch[0], body)
      if (!binding) throw new HttpError(404, 'project binding not found')
      return json({ binding })
    }

    if (req.method === 'DELETE' && projectBindingMatch) {
      return json({ deleted: projectBindings.deleteProjectBinding(projectBindingMatch[0]) })
    }

    if (req.method === 'GET' && url.pathname === '/dispatch-acquisitions') {
      const kind = optionalTaskDispatchAcquisitionKind(url.searchParams.get('kind'))
      const status = url.searchParams.get('status') || undefined
      const taskId = url.searchParams.get('taskId') || undefined
      const dispatchId = url.searchParams.get('dispatchId') || undefined
      const acquisitions = listTaskDispatchAcquisitions()
        .filter(row => !kind || row.kind === kind)
        .filter(row => !status || row.status === status)
        .filter(row => !taskId || row.taskId === taskId)
        .filter(row => !dispatchId || row.dispatchId === dispatchId)
        .map(compactTaskDispatchAcquisition)
      const unsettled = acquisitions.filter(row => row.status === 'intent' || row.status === 'acquired').length
      return json({ acquisitions, counts: { total: acquisitions.length, unsettled } })
    }

    const dispatchAcquisitionSettleMatch = pathMatch(url.pathname, /^\/dispatch-acquisitions\/([^/]+)\/([^/]+)\/settle$/)
    if (req.method === 'POST' && dispatchAcquisitionSettleMatch) {
      const dispatchId = dispatchAcquisitionSettleMatch[0]
      const kind = taskDispatchAcquisitionKind(dispatchAcquisitionSettleMatch[1])
      const body = await readJsonBodyAs(req, zDispatchAcquisitionSettleBody)
      const existing = listTaskDispatchAcquisitions().find(row => row.dispatchId === dispatchId && row.kind === kind)
      if (!existing) throw new HttpError(404, 'dispatch acquisition not found')
      const identity = httpCallerIdentity(req)
      const status = body.status || 'failed'
      const reason = body.reason || body.note || `force-settled by ${identity.actor}`
      const acquisition = markTaskDispatchAcquisitionSettled(dispatchId, kind, { status, error: reason })
      if (!acquisition) throw new HttpError(404, 'dispatch acquisition not found')
      auditHttp(req, 'dispatch_acquisition.force_settle', `${dispatchId}:${kind}`, 'ok', {
        actor: identity.actor,
        status,
        previousStatus: existing.status,
        reason,
      })
      return json({ acquisition: compactTaskDispatchAcquisition(acquisition), previous: compactTaskDispatchAcquisition(existing) })
    }

    if (req.method === 'GET' && url.pathname === '/runs') {
      const snapshot = getWorkQueueSnapshot()
      return json({ runs: snapshot.state.runs.slice(-100).map(compactRun) })
    }

    if (req.method === 'GET' && url.pathname === '/environments') {
      return json({ environments: listWorkEnvironments({ status: url.searchParams.get('status') || undefined, backend: url.searchParams.get('backend') || undefined, runId: url.searchParams.get('runId') || undefined }).map(compactEnvironment) })
    }

    if (req.method === 'POST' && url.pathname === '/environments/reconcile') {
      return json({ reconciliation: reconcileWorkEnvironments() })
    }

    const environmentMatch = pathMatch(url.pathname, /^\/environments\/([^/]+)$/)
    if (req.method === 'GET' && environmentMatch) {
      const environment = getWorkEnvironment(environmentMatch[0])
      if (!environment) throw new HttpError(404, 'environment not found')
      return json({ environment: compactEnvironment(environment) })
    }

    const environmentActionMatch = pathMatch(url.pathname, /^\/environments\/([^/]+)\/action$/)
    if (req.method === 'POST' && environmentActionMatch) {
      const body = await readJsonBodyAs(req, zEnvironmentActionBody)
      const action = normalizeEnvironmentAction(body.action)
      const identity = httpCallerIdentity(req)
      const result = applyWorkEnvironmentAction(environmentActionMatch[0], action, { actor: identity.actor, note: body.note })
      if (!result) throw new HttpError(404, 'environment not found')
      if (result.abortedSessionId) await abortSessions(client, [result.abortedSessionId])
      return json({ ...result, environment: compactEnvironment(result.environment), run: compactRun(result.run) })
    }

    const runMatch = pathMatch(url.pathname, /^\/runs\/([^/]+)$/)
    if (req.method === 'GET' && runMatch) {
      const run = getRun(runMatch[0])
      if (!run) throw new HttpError(404, 'run not found')
      const raw = url.searchParams.get('raw') === 'true' || url.searchParams.get('unredacted') === 'true'
      const limited = guardUnredactedExport(req, {
        operation: 'runs.read.unredacted',
        target: runMatch[0],
        unredacted: raw,
        url,
      })
      if (limited) return limited
      return json({ run: raw ? { ...run, environment: redactEnvironmentValue(run.environment) } : compactRun(run) })
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const limit = Number(url.searchParams.get('limit') || 100)
      const raw = url.searchParams.get('raw') === 'true' || url.searchParams.get('unredacted') === 'true'
      const limited = guardUnredactedExport(req, {
        operation: 'events.read.unredacted',
        target: 'events',
        unredacted: raw,
        url,
      })
      if (limited) return limited
      const events = listWorkEvents(limit)
      return json({ events: raw ? events : redactSensitiveObject(events, getConfig()) })
    }

    if (req.method === 'GET' && url.pathname === '/team-assignments') {
      return json({ assignments: listTeamTaskAssignments({
        receiptId: url.searchParams.get('receiptId') || undefined,
        taskId: url.searchParams.get('taskId') || undefined,
        roadmapId: url.searchParams.get('roadmapId') || undefined,
        runId: url.searchParams.get('runId') || undefined,
        sessionId: url.searchParams.get('sessionId') || undefined,
        memberId: url.searchParams.get('memberId') || undefined,
        limit: Number(url.searchParams.get('limit') || 100),
      }) })
    }

    if (req.method === 'POST' && url.pathname === '/team-assignments') {
      const body = await readJsonBodyAs(req, zTeamAssignmentBody)
      const result = createTeamTaskAssignments(body)
      const identity = httpCallerIdentity(req)
      appendAuditEvent({
        actor: identity.actor,
        source: httpRequestSource(req),
        operation: 'team_assignment.create',
        target: result.receipt.id,
        result: result.ok ? 'ok' : 'error',
        details: { receiptId: result.receipt.id, assignmentIds: result.receipt.assignments.map(assignment => assignment.id), rejectionReasons: result.receipt.rejectionReasons, ...(identity.claimedActor ? { claimedActor: identity.claimedActor } : {}) },
      })
      return json(result, result.ok ? 200 : 422)
    }

    const teamAssignmentReceiptMatch = pathMatch(url.pathname, /^\/team-assignments\/([^/]+)\/receipts$/)
    if (req.method === 'POST' && teamAssignmentReceiptMatch) {
      const body = await readJsonBodyAs(req, zTeamAssignmentReceiptBody)
      const result = recordTeamAssignmentReceipt({ ...body, assignmentId: teamAssignmentReceiptMatch[0] })
      if (!result.ok) return json(result, 422)
      return json(result)
    }

    const teamAssignmentMatch = pathMatch(url.pathname, /^\/team-assignments\/([^/]+)$/)
    if (req.method === 'GET' && teamAssignmentMatch) {
      const assignment = getTeamTaskAssignment(teamAssignmentMatch[0])
      if (!assignment) throw new HttpError(404, 'team assignment not found')
      return json({ assignment })
    }

    if (req.method === 'GET' && url.pathname === '/human-gates') {
      const status = url.searchParams.get('status') as any || 'open'
      return json({ gates: listHumanGates({ status }) })
    }

    if (req.method === 'POST' && url.pathname === '/human-gates') {
      const body = await readJsonBodyAs(req, zHumanGateBody)
      return json({ gate: createHumanGate(body) })
    }

    const gateMatch = pathMatch(url.pathname, /^\/human-gates\/([^/]+)$/)
    if (req.method === 'GET' && gateMatch) {
      const gate = getHumanGate(gateMatch[0])
      if (!gate) throw new HttpError(404, 'human gate not found')
      return json({ gate })
    }

    const gateDecisionMatch = pathMatch(url.pathname, /^\/human-gates\/([^/]+)\/decision$/)
    if (req.method === 'POST' && gateDecisionMatch) {
      const body = await readJsonBodyAs(req, zHumanGateDecisionBody)
      const approverSurface = gateApproverSurface(req, body)
      const rejection = rejectMcpExternalAuthorityGateApproval(gateDecisionMatch[0], body, approverSurface)
      if (rejection) return rejection
      const approver = gateApproverIdentity(req, approverSurface)
      const result = decideHumanGate(gateDecisionMatch[0], { decision: body.decision, scope: body.scope, actor: approver.actor, source: approver.source, note: body.note })
      if (!result) throw new HttpError(404, 'human gate not found')
      return json(result)
    }

    if (req.method === 'GET' && url.pathname === '/scheduler') {
      const current = getConfig()
      const snapshot = getWorkQueueSnapshot()
      return json({ scheduler: current.scheduler, counts: snapshot.counts, leases: getSchedulerLeaseSummary(snapshot.state) })
    }

    const schedulerActionMatch = pathMatch(url.pathname, /^\/scheduler\/(pause|resume|run)$/)
    if (req.method === 'POST' && schedulerActionMatch) {
      return handleSchedulerAction(schedulerActionMatch[0] as 'pause' | 'resume' | 'run', client)
    }

    if (req.method === 'POST' && url.pathname === '/scheduler') {
      const body = await readJsonBodyAs(req, zSchedulerBody)
      if (body.action === 'pause' || body.action === 'resume' || body.action === 'run') return handleSchedulerAction(body.action, client)
      return json({ scheduler: updateSchedulerConfig(body as any) })
    }

    if (req.method === 'GET' && url.pathname === '/agent-teams') {
      return json({ agentTeams: projectAgentTeams(listAgentTeams()) })
    }

    if (req.method === 'GET' && url.pathname === '/agent-factory/catalog') {
      const snapshot = getWorkQueueSnapshot()
      return json({ catalog: buildAgentCatalog({ config: getConfig(), workState: snapshot.state }) })
    }

    if (req.method === 'POST' && url.pathname === '/agent-factory/teams/assemble') {
      const body = await readJsonBodyAs(req, zTeamAssemblyBody)
      const result = assembleBoundedTeam(body)
      const identity = httpCallerIdentity(req)
      const actor = identity.actor
      const source = httpRequestSource(req)
      const auditEventId = appendAuditEvent({
        actor,
        source,
        operation: 'team.assemble',
        target: result.receipt.selectedTeam.name,
        result: result.ok ? 'ok' : 'error',
        details: { receipt: result.receipt, ...(identity.claimedActor ? { claimedActor: identity.claimedActor } : {}) },
      })
      return json({ ...result, receipt: { ...result.receipt, auditEventId } }, result.ok ? 200 : 422)
    }

    if (req.method === 'POST' && url.pathname === '/agent-teams/validate') {
      const body = await readJsonBodyAs(req, zAgentTeamNamedBody)
      return json(validateAgentTeamBody(body), 200)
    }

    if (req.method === 'POST' && url.pathname === '/agent-teams/propose') {
      const body = await readJsonBodyAs(req, zAgentTeamNamedBody)
      const name = normalizeAgentTeamRouteName(body.name)
      const validation = validateAgentTeamBody({ name, team: agentTeamDefinitionFromBody(body) })
      const gate = createHumanGate(agentTeamGateInput('apply', name, req, { revision: validation.agentTeam.revision }))
      return json({ proposal: { name, agentTeam: validation.agentTeam }, gate, pending: true }, 202)
    }

    if (req.method === 'POST' && url.pathname === '/blueprints/preview') {
      const body = await readJsonBodyAs(req, zBlueprintBody)
      return json({ preview: previewBlueprint(blueprintDefinitionFromBody(body)) })
    }

    if (req.method === 'GET' && url.pathname === '/blueprints') {
      return json({ blueprints: buildAgentCatalog({ config: getConfig() }).blueprints })
    }

    if (req.method === 'POST' && url.pathname === '/blueprints/apply') {
      const body = await readJsonBodyAs(req, zBlueprintBody)
      const blueprint = blueprintDefinitionFromBody(body)
      const preview = previewBlueprint(blueprint)
      if (!preview.ok) throw new HttpError(422, preview.validation.errors[0]?.message || 'blueprint validation failed')
      const gate = requireApprovedBlueprintGate(req, preview, body)
      if (gate) return json({ pending: true, gate, preview }, 202)
      const approvedGate = getHumanGate(String(body.gateId || body.approvedGateId || ''))
      const guardedBlueprint = blueprintWithExpectedStateFromGate(blueprint, approvedGate)
      const guardedPreview = previewBlueprint(guardedBlueprint)
      if (!guardedPreview.ok) {
        const first = guardedPreview.validation.errors[0]
        throw new HttpError(first?.code === 'version_conflict' ? 409 : 422, first?.message || 'blueprint validation failed')
      }
      const identity = httpCallerIdentity(req)
      const actor = identity.actor
      const source = httpRequestSource(req)
      const result = applyBlueprint(guardedBlueprint, getConfig(), {
        actor,
        source,
        gateId: String(body.gateId || body.approvedGateId || '') || undefined,
        recordAudit: receipt => appendAuditEvent({
          actor,
          source,
          operation: 'blueprint.apply',
          target: `${preview.blueprint.name}@${preview.blueprint.version}`,
          result: 'ok',
          details: {
            receiptId: receipt.id,
            blueprint: receipt.blueprint,
            gateId: receipt.gateId,
            changed: receipt.changed,
            validation: receipt.validation,
          },
        }),
      })
      return json(result)
    }

    const agentTeamInspectionMatch = pathMatch(url.pathname, /^\/agent-teams\/([^/]+)\/inspection$/)
    if (req.method === 'GET' && agentTeamInspectionMatch) {
      const name = agentTeamInspectionMatch[0]
      const agentTeam = getAgentTeam(name)
      if (!agentTeam) throw new HttpError(404, 'agent team not found')
      return json({ name, inspection: inspectTeamAccess(name, agentTeam, { config: getConfig() }) })
    }

    const agentTeamApplyMatch = pathMatch(url.pathname, /^\/agent-teams\/([^/]+)\/(apply|bind)$/)
    const agentTeamMatch = pathMatch(url.pathname, /^\/agent-teams\/([^/]+)$/)

    if (req.method === 'GET' && agentTeamMatch) {
      const name = agentTeamMatch[0]
      const agentTeam = getAgentTeam(name)
      if (!agentTeam) throw new HttpError(404, 'agent team not found')
      return json({ name, agentTeam: projectAgentTeam(name, agentTeam), references: agentTeamReferences(name) })
    }

    if ((req.method === 'PUT' && agentTeamMatch) || (req.method === 'POST' && agentTeamApplyMatch?.[1] === 'apply')) {
      const name = normalizeAgentTeamRouteName(agentTeamMatch?.[0] || agentTeamApplyMatch![0])
      const body = await readJsonBodyAs(req, zAgentTeamBody)
      const validation = validateAgentTeamBody({ name, team: agentTeamDefinitionFromBody(body) })
      const gate = requireApprovedAgentTeamGate(req, 'apply', name, body, { revision: validation.agentTeam.revision })
      if (gate) return json({ pending: true, gate, proposal: { name, agentTeam: validation.agentTeam } }, 202)
      const agentTeam = upsertAgentTeam(name, validation.agentTeam)
      auditAgentTeam(req, 'agent_team.apply', name, 'ok', { revision: agentTeam.revision })
      return json({ name, agentTeam: projectAgentTeam(name, agentTeam) })
    }

    if (req.method === 'DELETE' && agentTeamMatch) {
      const name = normalizeAgentTeamRouteName(agentTeamMatch[0])
      if (!getAgentTeam(name)) throw new HttpError(404, 'agent team not found')
      const references = agentTeamReferences(name)
      if (references.roadmapIds.length || references.taskIds.length) throw new HttpError(409, `agent team is still referenced: ${name}`)
      const body = await readJsonBodyAs(req, zAgentTeamGateBody)
      const gate = requireApprovedAgentTeamGate(req, 'delete', name, body, {})
      if (gate) return json({ pending: true, gate, references }, 202)
      const deleted = deleteAgentTeam(name)
      auditAgentTeam(req, 'agent_team.delete', name, deleted ? 'ok' : 'error')
      return json({ deleted })
    }

    if (req.method === 'POST' && agentTeamApplyMatch?.[1] === 'bind') {
      const name = normalizeAgentTeamRouteName(agentTeamApplyMatch[0])
      if (!getAgentTeam(name)) throw new HttpError(404, 'agent team not found')
      const body = await readJsonBodyAs(req, zAgentTeamBindBody)
      const target = agentTeamBindTarget(body)
      const gate = requireApprovedAgentTeamGate(req, 'bind', `${name}:${target.kind}:${target.id}`, body, { agentTeam: name, target })
      if (gate) return json({ pending: true, gate, target }, 202)
      const result = target.kind === 'roadmap' ? updateRoadmap(target.id, { agentTeam: name }) : updateWorkTask(target.id, { agentTeam: name })
      if (!result) throw new HttpError(404, `${target.kind} not found`)
      auditAgentTeam(req, 'agent_team.bind', `${name}:${target.kind}:${target.id}`, 'ok')
      return json({ [target.kind]: result, agentTeam: name })
    }

    if (req.method === 'GET' && url.pathname === '/profiles') {
      return json({ profiles: projectProfiles(listProfiles()) })
    }

    const profileInspectionMatch = pathMatch(url.pathname, /^\/profiles\/([^/]+)\/inspection$/)
    if (req.method === 'GET' && profileInspectionMatch) {
      const name = profileInspectionMatch[0]
      const profile = getConfig().profiles[name]
      if (!profile) throw new HttpError(404, 'profile not found')
      return json({ name, inspection: inspectProfileAccess(name, profile, { config: getConfig() }) })
    }

    const profileMatch = pathMatch(url.pathname, /^\/profiles\/([^/]+)$/)
    if (req.method === 'GET' && profileMatch) {
      const profile = getConfig().profiles[profileMatch[0]]
      if (!profile) throw new HttpError(404, 'profile not found')
      return json({ name: profileMatch[0], profile: projectProfile(profileMatch[0], profile) })
    }
    if ((req.method === 'PUT' || req.method === 'POST') && profileMatch) {
      const name = profileMatch[0]
      const profile = validateProfileForRoute(name, await readJsonBodyAs(req, zAgentProfileBody))
      return json({ profile: projectProfile(name, upsertProfile(name, profile)) })
    }
    if (req.method === 'DELETE' && profileMatch) {
      return json({ deleted: deleteProfile(profileMatch[0]) })
    }

    if (req.method === 'GET' && url.pathname === '/promotion/scorecards') {
      return json({ scorecards: listPromotionScorecards({ subjectKind: promotionSubjectKindFromValue(url.searchParams.get('subjectKind')), subjectName: url.searchParams.get('subjectName') || undefined, status: url.searchParams.get('status') as any || undefined }) })
    }

    if (req.method === 'POST' && url.pathname === '/promotion/scorecards') {
      const body = await readJsonBodyAs(req, zPromotionScorecardBody)
      const scorecard = createPromotionScorecard(body as any)
      return json({ scorecard }, 201)
    }

    const scorecardMatch = pathMatch(url.pathname, /^\/promotion\/scorecards\/([^/]+)$/)
    if (req.method === 'GET' && scorecardMatch) {
      const scorecard = getPromotionScorecard(scorecardMatch[0])
      if (!scorecard) throw new HttpError(404, 'promotion scorecard not found')
      return json({ scorecard })
    }

    if (req.method === 'GET' && url.pathname === '/promotion/state') {
      const subjectKind = promotionSubjectKindFromValue(url.searchParams.get('subjectKind'))
      const subjectName = url.searchParams.get('subjectName') || ''
      if (!subjectKind || !subjectName) throw new HttpError(400, 'subjectKind and subjectName required')
      return json({ promotion: getPromotionState(subjectKind, subjectName), decisions: listPromotionDecisions({ subjectKind, subjectName }) })
    }

    if (req.method === 'POST' && url.pathname === '/promotion/decisions') {
      const body = await readJsonBodyAs(req, zPromotionDecisionBody)
      const identity = httpCallerIdentity(req)
      const decision = applyPromotionDecision({ ...body, actor: identity.actor, source: identity.source })
      if (!decision) throw new HttpError(404, 'promotion decision not found')
      const status = decision.status === 'pending' ? 202 : 200
      return json({ decision, pending: decision.status === 'pending', gateId: decision.gateId }, status)
    }

    return undefined
  }]
}
