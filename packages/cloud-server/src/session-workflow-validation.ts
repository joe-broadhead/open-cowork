// Workflow-draft validation + normalization, carved out of the CloudSessionService
// god class (ARCH god-class, P2). These are pure functions over a draft plus the two
// collaborators they need — a UUID factory and the runtime policy — so the behavior is
// byte-identical to the former private methods; CloudSessionService now delegates to
// them. Mirrors the existing session-input-validation.ts / session-import-validation.ts
// split so the session service stays a coordinator rather than owning every validator.
import { validateWorkflowSchedule } from '@open-cowork/runtime-host/workflow/workflow-schedule'
import type { WorkflowDraft, WorkflowTrigger, WorkflowTriggerType } from '@open-cowork/shared'
import { normalizeWorkflowSteps } from '@open-cowork/shared'
import { evaluateCloudProjectDirectoryPolicy, type CloudRuntimePolicy } from './cloud-config.ts'
import {
  asRecord,
  boundedOptionalText,
  boundedText,
  includesAllowed,
  readNullableString,
  readString,
} from './session-input-validation.ts'

const WORKFLOW_MAX_TEXT = 50_000
const WORKFLOW_TITLE_MAX_LENGTH = 512
const WORKFLOW_FIELD_MAX_LENGTH = 4096
const WORKFLOW_MAX_LIST_VALUES = 100
export const WORKFLOW_VALID_TRIGGER_TYPES = new Set<WorkflowTriggerType>(['manual', 'schedule', 'webhook'])

type WorkflowIdFactory = { randomUUID: () => string }

export function normalizeWorkflowStringList(value: unknown, label: string) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return [...new Set(value.slice(0, WORKFLOW_MAX_LIST_VALUES).map((entry) => boundedText(entry, label, 256)))]
}

export function normalizeWorkflowDraft(draft: WorkflowDraft, ids: WorkflowIdFactory, now = new Date()): WorkflowDraft {
  const triggers = normalizeWorkflowTriggers(draft.triggers, ids, now)
  if (!triggers.some((trigger) => trigger.type === 'manual')) {
    triggers.unshift({ id: ids.randomUUID(), type: 'manual', enabled: true })
  }
  const title = boundedText(draft.title, 'Workflow title', WORKFLOW_TITLE_MAX_LENGTH)
  const instructions = boundedText(draft.instructions, 'Workflow instructions', WORKFLOW_MAX_TEXT)
  const agentName = boundedText(draft.agentName || 'build', 'Workflow agent', 256)
  const skillNames = normalizeWorkflowStringList(draft.skillNames, 'Workflow skillNames')
  const toolIds = normalizeWorkflowStringList(draft.toolIds, 'Workflow toolIds')
  return {
    title,
    instructions,
    agentName,
    skillNames,
    toolIds,
    steps: normalizeWorkflowSteps(draft.steps, {
      instructions,
      agentName,
      skillNames,
      toolIds,
    }),
    projectDirectory: boundedOptionalText(draft.projectDirectory, 'Workflow projectDirectory', WORKFLOW_FIELD_MAX_LENGTH),
    draftSessionId: boundedOptionalText(draft.draftSessionId, 'Workflow draftSessionId', 256),
    triggers,
  }
}

export function normalizeWorkflowTriggers(value: unknown, ids: WorkflowIdFactory, now: Date): WorkflowTrigger[] {
  // Empty/missing triggers are allowed here so normalizeWorkflowDraft can inject a
  // default manual trigger. Non-array values remain invalid.
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error('Workflow triggers must be an array.')
  }
  if (value.length === 0) return []
  return value.slice(0, 8).map((entry) => {
    const trigger = asRecord(entry)
    const type = readString(trigger.type) as WorkflowTriggerType
    if (!WORKFLOW_VALID_TRIGGER_TYPES.has(type)) throw new Error('Workflow trigger type is invalid.')
    const normalized: WorkflowTrigger = {
      id: readString(trigger.id, ids.randomUUID()),
      type,
      enabled: trigger.enabled !== false,
      schedule: null,
      webhookSecret: null,
    }
    if (type === 'schedule') {
      const schedule = asRecord(trigger.schedule) as unknown as WorkflowTrigger['schedule']
      if (!schedule) throw new Error('Scheduled workflow trigger requires a schedule.')
      const scheduleError = validateWorkflowSchedule(schedule, now)
      if (scheduleError) throw new Error(scheduleError)
      normalized.schedule = schedule
    }
    if (type === 'webhook') {
      normalized.webhookSecret = readNullableString(trigger.webhookSecret) || ids.randomUUID()
    }
    return normalized
  })
}

export function assertWorkflowDraftAllowed(draft: WorkflowDraft, policy: CloudRuntimePolicy) {
  if (!includesAllowed(draft.agentName, policy.allowedAgents)) {
    throw new Error(`Agent "${draft.agentName}" is not enabled for cloud profile "${policy.profileName}".`)
  }
  for (const toolId of draft.toolIds || []) {
    if (!includesAllowed(toolId, policy.allowedTools)) {
      throw new Error(`Tool "${toolId}" is not enabled for cloud profile "${policy.profileName}".`)
    }
  }
  if (draft.projectDirectory) {
    const verdict = evaluateCloudProjectDirectoryPolicy(draft.projectDirectory, policy)
    if (!verdict.allowed) throw new Error(verdict.reason || 'Workflow project directory is not allowed.')
  }
}
