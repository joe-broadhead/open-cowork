import type {
  WorkflowDraft,
  WorkflowToolPreview,
  WorkflowTrigger,
  WorkflowTriggerType,
  WorkflowValidationGap,
} from '@open-cowork/shared'
import { validateWorkflowSchedule } from './workflow-schedule.ts'

const MAX_TEXT = 32 * 1024
export const MAX_WORKFLOW_LIST_ITEMS = 50
const VALID_TRIGGER_TYPES = new Set<WorkflowTriggerType>(['manual', 'schedule', 'webhook'])

export type WorkflowCapabilityValidationContext = {
  agentNames?: readonly string[]
  skillNames?: readonly string[]
  toolIds?: readonly string[]
}

export type WorkflowDraftNormalizationOptions = {
  now?: Date
  capabilities?: WorkflowCapabilityValidationContext
  idGenerator?: () => string
  secretGenerator?: () => string
  projectDirectoryExists?: (directory: string) => boolean
}

export function isWorkflowTriggerType(value: unknown): value is WorkflowTriggerType {
  return typeof value === 'string' && VALID_TRIGGER_TYPES.has(value as WorkflowTriggerType)
}

function boundedText(value: unknown, label: string, max = MAX_TEXT) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  if (Buffer.byteLength(trimmed, 'utf8') > max) throw new Error(`${label} is too large.`)
  return trimmed
}

function boundedOptionalText(value: unknown, label: string, max = MAX_TEXT) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (Buffer.byteLength(trimmed, 'utf8') > max) throw new Error(`${label} is too large.`)
  return trimmed
}

function normalizeStringList(value: unknown, label: string) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return Array.from(new Set(value.map((item) => boundedText(item, `${label} entry`, 256)))).slice(0, MAX_WORKFLOW_LIST_ITEMS)
}

function randomWorkflowSecret() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
}

function hasCapabilityReference(value: string, available?: readonly string[]) {
  if (!available) return true
  return available.includes(value)
}

export function validateWorkflowDraftCapabilities(
  draft: WorkflowDraft,
  options?: Pick<WorkflowDraftNormalizationOptions, 'capabilities' | 'projectDirectoryExists'>,
): WorkflowValidationGap[] {
  const capabilities = options?.capabilities
  const gaps: WorkflowValidationGap[] = []

  if (!hasCapabilityReference(draft.agentName, capabilities?.agentNames)) {
    gaps.push({
      severity: 'required',
      field: 'agentName',
      value: draft.agentName,
      message: `Workflow agent "${draft.agentName}" is not available.`,
    })
  }

  for (const skillName of draft.skillNames || []) {
    if (hasCapabilityReference(skillName, capabilities?.skillNames)) continue
    gaps.push({
      severity: 'optional',
      field: 'skillNames',
      value: skillName,
      message: `Workflow skill "${skillName}" is not available.`,
    })
  }

  for (const toolId of draft.toolIds || []) {
    if (hasCapabilityReference(toolId, capabilities?.toolIds)) continue
    gaps.push({
      severity: 'optional',
      field: 'toolIds',
      value: toolId,
      message: `Workflow tool "${toolId}" is not available.`,
    })
  }

  if (draft.projectDirectory && options?.projectDirectoryExists && !options.projectDirectoryExists(draft.projectDirectory)) {
    gaps.push({
      severity: 'required',
      field: 'projectDirectory',
      value: draft.projectDirectory,
      message: `Workflow project directory "${draft.projectDirectory}" is not available.`,
    })
  }

  return gaps
}

export function requiredWorkflowGaps(gaps: WorkflowValidationGap[]) {
  return gaps.filter((gap) => gap.severity === 'required')
}

export function assertWorkflowCapabilities(draft: WorkflowDraft, options?: Pick<WorkflowDraftNormalizationOptions, 'capabilities' | 'projectDirectoryExists'>) {
  const gaps = validateWorkflowDraftCapabilities(draft, options)
  const required = requiredWorkflowGaps(gaps)
  if (required.length > 0) throw new Error(required[0]!.message)
  return gaps
}

export function normalizeWorkflowDraft(draft: WorkflowDraft, options?: WorkflowDraftNormalizationOptions): WorkflowDraft {
  const title = boundedText(draft.title, 'Workflow title', 512)
  const instructions = boundedText(draft.instructions, 'Workflow instructions', MAX_TEXT)
  const agentName = boundedText(draft.agentName || 'build', 'Workflow agent', 256)
  const idGenerator = options?.idGenerator ?? (() => crypto.randomUUID())
  const triggers = normalizeWorkflowTriggers(draft.triggers, {
    now: options?.now ?? new Date(),
    idGenerator,
    secretGenerator: options?.secretGenerator ?? randomWorkflowSecret,
  })
  if (!triggers.some((trigger) => trigger.type === 'manual')) {
    triggers.unshift({ id: idGenerator(), type: 'manual', enabled: true })
  }
  return {
    title,
    instructions,
    agentName,
    skillNames: normalizeStringList(draft.skillNames, 'Workflow skillNames'),
    toolIds: normalizeStringList(draft.toolIds, 'Workflow toolIds'),
    projectDirectory: boundedOptionalText(draft.projectDirectory, 'Workflow projectDirectory', 4096),
    draftSessionId: boundedOptionalText(draft.draftSessionId, 'Workflow draftSessionId', 256),
    triggers,
  }
}

function normalizeWorkflowTriggers(
  value: unknown,
  options: {
    now: Date
    idGenerator: () => string
    secretGenerator: () => string
  },
): WorkflowTrigger[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Workflow requires at least one trigger.')
  }
  return value.slice(0, 8).map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Workflow trigger must be an object.')
    const trigger = raw as Partial<WorkflowTrigger>
    const type = String(trigger.type || '')
    if (!isWorkflowTriggerType(type)) throw new Error('Workflow trigger type is invalid.')
    const normalized: WorkflowTrigger = {
      id: typeof trigger.id === 'string' && trigger.id.trim() ? trigger.id.trim() : options.idGenerator(),
      type,
      enabled: trigger.enabled !== false,
      schedule: null,
      webhookSecret: null,
    }
    if (normalized.type === 'schedule') {
      if (!trigger.schedule) throw new Error('Scheduled workflow trigger requires a schedule.')
      const scheduleError = validateWorkflowSchedule(trigger.schedule, options.now)
      if (scheduleError) throw new Error(scheduleError)
      normalized.schedule = trigger.schedule
    }
    if (normalized.type === 'webhook') {
      normalized.webhookSecret = typeof trigger.webhookSecret === 'string' && trigger.webhookSecret.trim()
        ? trigger.webhookSecret.trim()
        : options.secretGenerator()
    }
    return normalized
  })
}

export function previewWorkflowDraft(draft: WorkflowDraft, options?: WorkflowDraftNormalizationOptions): WorkflowToolPreview {
  try {
    const now = options?.now ?? new Date()
    const normalizedDraft = normalizeWorkflowDraft(draft, { ...options, now })
    const gaps = validateWorkflowDraftCapabilities(normalizedDraft, options)
    const missing = requiredWorkflowGaps(gaps).map((gap) => gap.message)
    return {
      ok: missing.length === 0,
      title: normalizedDraft.title,
      summary: normalizedDraft.instructions.slice(0, 500),
      missing,
      gaps,
      normalizedDraft,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workflow draft is invalid.'
    return {
      ok: false,
      title: typeof draft.title === 'string' ? draft.title : 'Workflow draft',
      summary: message,
      missing: [message],
      gaps: [{
        severity: 'required',
        field: 'draft',
        value: '',
        message,
      }],
    }
  }
}
