import { validateAutomationDraft } from '../automation-validation.ts'
import {
  approveAutomationBrief,
  archiveAutomationRecord,
  cancelAutomationRun,
  createAutomationRecord,
  dismissAutomationInbox,
  getAutomation,
  listAutomations,
  pauseAutomationRecord,
  previewAutomationBrief,
  retryAutomationRun,
  respondToAutomationInbox,
  resumeAutomationRecord,
  runAutomationNow,
  updateAutomationRecord,
} from '../automation-service.ts'
import type { IpcHandlerContext } from './context.ts'
import type { AutomationDraft } from '@open-cowork/shared'

const MAX_AUTOMATION_DRAFT_BYTES = 128 * 1024
const MAX_AUTOMATION_STRING_BYTES = 32 * 1024
const MAX_AUTOMATION_AGENT_NAMES = 25
const MAX_AUTOMATION_AGENT_NAME_BYTES = 256
const MAX_AUTOMATION_PAYLOAD_DEPTH = 32
const MAX_AUTOMATION_PAYLOAD_ENTRIES = 1_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function assertJsonPayloadSize(value: unknown, label: string, maxBytes: number) {
  const seen = new WeakSet<object>()
  let total = 0
  let entries = 0
  const add = (bytes: number) => {
    total += bytes
    if (total > maxBytes) throw new Error(`${label} is too large.`)
  }
  const countEntry = () => {
    entries += 1
    if (entries > MAX_AUTOMATION_PAYLOAD_ENTRIES) throw new Error(`${label} has too many entries.`)
  }
  const visit = (current: unknown, depth = 0) => {
    if (depth > MAX_AUTOMATION_PAYLOAD_DEPTH) throw new Error(`${label} is too deeply nested.`)
    if (current === null || current === undefined) {
      add(4)
      return
    }
    switch (typeof current) {
      case 'string':
        add(Buffer.byteLength(current, 'utf8') + 2)
        return
      case 'number':
        if (!Number.isFinite(current)) throw new Error(`${label} must be JSON-serializable.`)
        add(String(current).length)
        return
      case 'boolean':
        add(String(current).length)
        return
      case 'bigint':
        throw new Error(`${label} must be JSON-serializable.`)
      case 'object':
        if (seen.has(current)) throw new Error(`${label} must be JSON-serializable.`)
        seen.add(current)
        if (Array.isArray(current)) {
          add(2)
          for (const item of current) {
            countEntry()
            visit(item, depth + 1)
          }
          return
        }
        add(2)
        for (const [key, item] of Object.entries(current)) {
          countEntry()
          add(Buffer.byteLength(key, 'utf8') + 2)
          visit(item, depth + 1)
        }
        return
      default:
        throw new Error(`${label} must be JSON-serializable.`)
    }
  }
  visit(value)
}

function assertBoundedOptionalString(record: Record<string, unknown>, key: string) {
  if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === null || record[key] === undefined) return
  if (typeof record[key] !== 'string') throw new Error(`Automation ${key} must be a string.`)
  if (Buffer.byteLength(record[key], 'utf8') > MAX_AUTOMATION_STRING_BYTES) {
    throw new Error(`Automation ${key} is too large.`)
  }
}

function assertPreferredAgentNames(value: unknown) {
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) throw new Error('Automation preferredAgentNames must be an array.')
  if (value.length > MAX_AUTOMATION_AGENT_NAMES) throw new Error('Automation preferredAgentNames has too many entries.')
  for (const agentName of value) {
    if (typeof agentName !== 'string') throw new Error('Automation preferredAgentNames entries must be strings.')
    if (Buffer.byteLength(agentName, 'utf8') > MAX_AUTOMATION_AGENT_NAME_BYTES) {
      throw new Error('Automation preferredAgentNames entry is too large.')
    }
  }
}

function assertObjectField(record: Record<string, unknown>, key: string, required: boolean) {
  if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === null || record[key] === undefined) {
    if (required) throw new Error(`Automation ${key} is required.`)
    return null
  }
  if (!isRecord(record[key])) throw new Error(`Automation ${key} must be an object.`)
  return record[key]
}

function assertFiniteOptionalNumber(record: Record<string, unknown>, key: string) {
  if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === null || record[key] === undefined) return
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    throw new Error(`Automation ${key} must be a finite number.`)
  }
}

function assertAutomationPayload(value: unknown, label: string, options: { complete?: boolean } = {}) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  assertJsonPayloadSize(value, label, MAX_AUTOMATION_DRAFT_BYTES)
  assertBoundedOptionalString(value, 'title')
  assertBoundedOptionalString(value, 'goal')
  assertBoundedOptionalString(value, 'projectDirectory')
  const schedule = assertObjectField(value, 'schedule', Boolean(options.complete))
  const retryPolicy = assertObjectField(value, 'retryPolicy', Boolean(options.complete))
  const runPolicy = assertObjectField(value, 'runPolicy', Boolean(options.complete))
  assertFiniteOptionalNumber(value, 'heartbeatMinutes')
  if (schedule) {
    assertBoundedOptionalString(schedule, 'timezone')
    assertBoundedOptionalString(schedule, 'startAt')
    assertFiniteOptionalNumber(schedule, 'runAtHour')
    assertFiniteOptionalNumber(schedule, 'runAtMinute')
    assertFiniteOptionalNumber(schedule, 'dayOfWeek')
    assertFiniteOptionalNumber(schedule, 'dayOfMonth')
  }
  if (retryPolicy) {
    assertFiniteOptionalNumber(retryPolicy, 'maxRetries')
    assertFiniteOptionalNumber(retryPolicy, 'baseDelayMinutes')
    assertFiniteOptionalNumber(retryPolicy, 'maxDelayMinutes')
  }
  if (runPolicy) {
    assertFiniteOptionalNumber(runPolicy, 'dailyRunCap')
    assertFiniteOptionalNumber(runPolicy, 'maxRunDurationMinutes')
  }
  assertPreferredAgentNames(value.preferredAgentNames)
}

function resolveAutomationProjectDirectory(context: IpcHandlerContext, directory: string | null | undefined) {
  const trimmed = typeof directory === 'string' ? directory.trim() : ''
  return trimmed ? context.resolveGrantedProjectDirectory(trimmed) : null
}

function normalizeAutomationDraft(context: IpcHandlerContext, draft: AutomationDraft): AutomationDraft {
  return {
    ...draft,
    projectDirectory: resolveAutomationProjectDirectory(context, draft.projectDirectory),
  }
}

function normalizeAutomationPatch(context: IpcHandlerContext, patch: Partial<AutomationDraft>): Partial<AutomationDraft> {
  if (!Object.prototype.hasOwnProperty.call(patch, 'projectDirectory')) return patch
  return {
    ...patch,
    projectDirectory: resolveAutomationProjectDirectory(context, patch.projectDirectory),
  }
}

export function registerAutomationHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('automation:list', async () => {
    return listAutomations()
  })

  context.ipcMain.handle('automation:get', async (_event, automationId: string) => {
    return getAutomation(automationId)
  })

  context.ipcMain.handle('automation:create', async (_event, draft: AutomationDraft) => {
    assertAutomationPayload(draft, 'Automation draft', { complete: true })
    const normalizedDraft = normalizeAutomationDraft(context, draft)
    const error = validateAutomationDraft(normalizedDraft)
    if (error) throw new Error(error)
    return createAutomationRecord(normalizedDraft)
  })

  context.ipcMain.handle('automation:update', async (_event, automationId: string, draft: Partial<AutomationDraft>) => {
    assertAutomationPayload(draft, 'Automation update')
    const current = getAutomation(automationId)
    if (!current) throw new Error('Automation not found.')
    const normalizedPatch = normalizeAutomationPatch(context, draft)
    const mergedDraft: AutomationDraft = {
      title: normalizedPatch.title ?? current.title,
      goal: normalizedPatch.goal ?? current.goal,
      kind: normalizedPatch.kind ?? current.kind,
      schedule: normalizedPatch.schedule ?? current.schedule,
      heartbeatMinutes: normalizedPatch.heartbeatMinutes ?? current.heartbeatMinutes,
      retryPolicy: normalizedPatch.retryPolicy ?? current.retryPolicy,
      runPolicy: normalizedPatch.runPolicy ?? current.runPolicy,
      executionMode: normalizedPatch.executionMode ?? current.executionMode,
      autonomyPolicy: normalizedPatch.autonomyPolicy ?? current.autonomyPolicy,
      projectDirectory: normalizedPatch.projectDirectory === undefined ? current.projectDirectory : normalizedPatch.projectDirectory,
      preferredAgentNames: normalizedPatch.preferredAgentNames ?? current.preferredAgentNames,
    }
    const error = validateAutomationDraft(mergedDraft)
    if (error) throw new Error(error)
    return updateAutomationRecord(automationId, normalizedPatch)
  })

  context.ipcMain.handle('automation:pause', async (_event, automationId: string) => {
    return pauseAutomationRecord(automationId)
  })

  context.ipcMain.handle('automation:resume', async (_event, automationId: string) => {
    return resumeAutomationRecord(automationId)
  })

  context.ipcMain.handle('automation:archive', async (_event, automationId: string) => {
    return archiveAutomationRecord(automationId)
  })

  context.ipcMain.handle('automation:run-now', async (_event, automationId: string) => {
    return runAutomationNow(automationId)
  })

  context.ipcMain.handle('automation:retry-run', async (_event, runId: string) => {
    return retryAutomationRun(runId)
  })

  context.ipcMain.handle('automation:cancel-run', async (_event, runId: string) => {
    return cancelAutomationRun(runId)
  })

  context.ipcMain.handle('automation:preview-brief', async (_event, automationId: string) => {
    return previewAutomationBrief(automationId)
  })

  context.ipcMain.handle('automation:approve-brief', async (_event, automationId: string) => {
    return approveAutomationBrief(automationId)
  })

  context.ipcMain.handle('automation:inbox-respond', async (_event, itemId: string, response: string) => {
    return respondToAutomationInbox(itemId, response)
  })

  context.ipcMain.handle('automation:inbox-dismiss', async (_event, itemId: string) => {
    return dismissAutomationInbox(itemId)
  })
}
