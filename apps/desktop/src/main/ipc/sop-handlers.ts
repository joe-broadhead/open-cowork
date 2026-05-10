import type { SopDraft } from '@open-cowork/shared'
import {
  getSop,
  getSopRunDetail,
  listSopDefinitions,
  runSopNow,
  saveAutomationRunAsSop,
  updateSop,
} from '../sop-service.ts'
import type { IpcHandlerContext } from './context.ts'

const MAX_SOP_DRAFT_BYTES = 128 * 1024
const MAX_SOP_INPUT_BYTES = 64 * 1024
const MAX_SOP_STRING_BYTES = 16 * 1024
const MAX_SOP_ARRAY_LENGTH = 100
const TRIGGERS = new Set(['manual', 'schedule', 'inbox', 'webhook'])
const STEP_KINDS = new Set(['plan', 'execute', 'approval', 'evaluate', 'deliver'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function assertJsonPayloadSize(value: unknown, label: string, maxBytes: number) {
  const raw = JSON.stringify(value)
  if (raw === undefined) throw new Error(`${label} must be JSON-serializable.`)
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
}

function assertString(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  if (Buffer.byteLength(value, 'utf8') > MAX_SOP_STRING_BYTES) throw new Error(`${label} is too large.`)
}

function assertOptionalString(value: unknown, label: string) {
  if (value === undefined || value === null) return
  assertString(value, label)
}

function assertSopDraftPayload(value: unknown): asserts value is SopDraft {
  if (!isRecord(value)) throw new Error('SOP draft must be an object.')
  assertJsonPayloadSize(value, 'SOP draft', MAX_SOP_DRAFT_BYTES)
  assertString(value.name, 'SOP name')
  assertString(value.description, 'SOP description')
  if (!Array.isArray(value.triggerTypes) || value.triggerTypes.length < 1) throw new Error('SOP triggerTypes must be a non-empty array.')
  if (value.triggerTypes.length > 4) throw new Error('SOP triggerTypes has too many entries.')
  for (const trigger of value.triggerTypes) {
    if (!TRIGGERS.has(String(trigger))) throw new Error('SOP trigger type is invalid.')
  }
  if (!isRecord(value.retryPolicy)) throw new Error('SOP retryPolicy is required.')
  if (!isRecord(value.runPolicy)) throw new Error('SOP runPolicy is required.')
  if (value.requiredInputs !== undefined) {
    if (!Array.isArray(value.requiredInputs) || value.requiredInputs.length > MAX_SOP_ARRAY_LENGTH) {
      throw new Error('SOP requiredInputs is invalid.')
    }
    for (const input of value.requiredInputs) {
      if (!isRecord(input)) throw new Error('SOP required input must be an object.')
      assertString(input.id, 'SOP required input id')
      assertString(input.label, 'SOP required input label')
      assertOptionalString(input.description, 'SOP required input description')
      if (input.required !== undefined && typeof input.required !== 'boolean') {
        throw new Error('SOP required input flag must be a boolean.')
      }
    }
  }
  if (value.workflow !== undefined) {
    if (!Array.isArray(value.workflow) || value.workflow.length > MAX_SOP_ARRAY_LENGTH) throw new Error('SOP workflow is invalid.')
    for (const step of value.workflow) {
      if (!isRecord(step)) throw new Error('SOP workflow step must be an object.')
      assertString(step.id, 'SOP workflow step id')
      assertString(step.title, 'SOP workflow step title')
      if (!STEP_KINDS.has(String(step.kind))) throw new Error('SOP workflow step kind is invalid.')
      assertOptionalString(step.agentName, 'SOP workflow step agent name')
      if (step.approvalRequired !== undefined && typeof step.approvalRequired !== 'boolean') {
        throw new Error('SOP workflow approval flag must be a boolean.')
      }
    }
  }
  if (value.approvalPolicy !== undefined && !isRecord(value.approvalPolicy)) throw new Error('SOP approvalPolicy must be an object.')
  if (value.deliveryPolicy !== undefined && !isRecord(value.deliveryPolicy)) throw new Error('SOP deliveryPolicy must be an object.')
  assertOptionalString(value.outcomeRubricId, 'SOP outcome rubric id')
}

function assertInputPayload(value: unknown): asserts value is Record<string, unknown> {
  if (value === undefined || value === null) return
  if (!isRecord(value)) throw new Error('SOP inputs must be an object.')
  assertJsonPayloadSize(value, 'SOP inputs', MAX_SOP_INPUT_BYTES)
}

export function registerSopHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('sops:list', async () => {
    return listSopDefinitions()
  })

  context.ipcMain.handle('sops:get', async (_event, sopId: string) => {
    assertString(sopId, 'SOP id')
    return getSop(sopId)
  })

  context.ipcMain.handle('sops:save-from-automation-run', async (_event, runId: string) => {
    assertString(runId, 'Automation run id')
    return saveAutomationRunAsSop(runId)
  })

  context.ipcMain.handle('sops:update', async (_event, sopId: string, draft: SopDraft) => {
    assertString(sopId, 'SOP id')
    assertSopDraftPayload(draft)
    return updateSop(sopId, draft)
  })

  context.ipcMain.handle('sops:run-now', async (_event, sopId: string, inputs?: Record<string, unknown>) => {
    assertString(sopId, 'SOP id')
    assertInputPayload(inputs)
    return runSopNow(sopId, inputs || {})
  })

  context.ipcMain.handle('sops:run-detail', async (_event, automationRunId: string) => {
    assertString(automationRunId, 'Automation run id')
    return getSopRunDetail(automationRunId)
  })
}
