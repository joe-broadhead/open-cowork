import type { CrewDefinitionDraft, CrewRunDraft } from '@open-cowork/shared'
import {
  createCrewFromDraft,
  deleteCrew,
  evaluateCrewRunWithOpenCode,
  exportCrewRunTraceNdjson,
  getCrewDetail,
  getCrewRunDetail,
  listCrewCatalog,
  pauseCrew,
  retireCrew,
  startCrewRunWithOpenCode,
  updateCrewFromDraft,
} from '../crew-service.ts'
import { createOpenCodeCrewRuntimeDriver } from '../crew-runtime-execution.ts'
import { log } from '../logger.ts'
import type { IpcHandlerContext } from './context.ts'

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
}

function assertString(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  if (Buffer.byteLength(value, 'utf8') > 16 * 1024) throw new Error(`${label} is too large.`)
}

function assertOptionalString(value: unknown, label: string) {
  if (value === undefined || value === null) return
  assertString(value, label)
}

function assertCrewDraftPayload(value: unknown): asserts value is CrewDefinitionDraft {
  assertObject(value, 'Crew draft')
  assertString(value.name, 'Crew name')
  assertString(value.description, 'Crew description')
  if (!Array.isArray(value.members)) throw new Error('Crew members must be an array.')
  if (value.members.length > 25) throw new Error('Crew has too many members.')
  for (const member of value.members) {
    assertObject(member, 'Crew member')
    assertString(member.agentName, 'Crew member agent name')
    assertOptionalString(member.displayName, 'Crew member display name')
    assertOptionalString(member.description, 'Crew member description')
    if (member.role !== 'lead' && member.role !== 'specialist' && member.role !== 'evaluator') {
      throw new Error('Crew member role is invalid.')
    }
    if (member.required !== undefined && typeof member.required !== 'boolean') {
      throw new Error('Crew member required must be a boolean.')
    }
  }
  assertOptionalString(value.workspaceProfileId, 'Crew workspace profile id')
  assertOptionalString(value.outcomeRubricId, 'Crew outcome rubric id')
  assertOptionalString(value.evalSuiteId, 'Crew eval suite id')
  if (value.budgetCapUsd !== undefined && value.budgetCapUsd !== null && typeof value.budgetCapUsd !== 'number') {
    throw new Error('Crew budget cap must be a number.')
  }
  if (
    value.approvalPolicy !== undefined
    && value.approvalPolicy !== null
    && value.approvalPolicy !== 'review-before-delivery'
    && value.approvalPolicy !== 'auto-deliver-after-evaluation'
  ) {
    throw new Error('Crew approval policy is invalid.')
  }
}

function assertCrewRunDraftPayload(value: unknown): asserts value is CrewRunDraft {
  assertObject(value, 'Crew run draft')
  assertString(value.crewId, 'Crew id')
  assertString(value.title, 'Crew run title')
  assertOptionalString(value.workItemTitle, 'Crew work item title')
  assertOptionalString(value.workItemDescription, 'Crew work item description')
  assertOptionalString(value.expectedDeliverable, 'Crew expected deliverable')
  assertOptionalString(value.constraints, 'Crew run constraints')
  assertOptionalString(value.dueAt, 'Crew run due date')
  assertOptionalString(value.approvalRequirements, 'Crew approval requirements')
  assertOptionalString(value.sourceContext, 'Crew source context')
  if (
    value.urgency !== undefined
    && value.urgency !== null
    && value.urgency !== 'low'
    && value.urgency !== 'normal'
    && value.urgency !== 'high'
    && value.urgency !== 'urgent'
  ) {
    throw new Error('Crew run urgency is invalid.')
  }
  if (value.budgetCapUsd !== undefined && value.budgetCapUsd !== null && typeof value.budgetCapUsd !== 'number') {
    throw new Error('Crew run budget cap must be a number.')
  }
}

export function registerCrewHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('crews:list', async () => {
    return listCrewCatalog()
  })

  context.ipcMain.handle('crews:get', async (_event, crewId: string) => {
    assertString(crewId, 'Crew id')
    return getCrewDetail(crewId)
  })

  context.ipcMain.handle('crews:create', async (_event, draft: CrewDefinitionDraft) => {
    assertCrewDraftPayload(draft)
    return createCrewFromDraft(draft)
  })

  context.ipcMain.handle('crews:update', async (_event, crewId: string, draft: CrewDefinitionDraft) => {
    assertString(crewId, 'Crew id')
    assertCrewDraftPayload(draft)
    return updateCrewFromDraft(crewId, draft)
  })

  context.ipcMain.handle('crews:pause', async (_event, crewId: string) => {
    assertString(crewId, 'Crew id')
    return pauseCrew(crewId)
  })

  context.ipcMain.handle('crews:retire', async (_event, crewId: string, confirmationToken?: string | null) => {
    assertString(crewId, 'Crew id')
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'crew.retire', crewId }, confirmationToken)) {
        throw new Error('Confirmation required before retiring a crew.')
      }
      const detail = retireCrew(crewId)
      log('audit', `crew.retire completed ${context.describeDestructiveRequest({ action: 'crew.retire', crewId })}`)
      return detail
    } catch (err) {
      context.logHandlerError(`crews:retire ${crewId}`, err)
      return null
    }
  })

  context.ipcMain.handle('crews:delete', async (_event, crewId: string, confirmationToken?: string | null) => {
    assertString(crewId, 'Crew id')
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'crew.delete', crewId }, confirmationToken)) {
        throw new Error('Confirmation required before deleting a crew.')
      }
      const deleted = deleteCrew(crewId)
      if (deleted) log('audit', `crew.delete completed ${context.describeDestructiveRequest({ action: 'crew.delete', crewId })}`)
      return deleted
    } catch (err) {
      context.logHandlerError(`crews:delete ${crewId}`, err)
      return false
    }
  })

  context.ipcMain.handle('crews:run', async (_event, draft: CrewRunDraft) => {
    assertCrewRunDraftPayload(draft)
    return startCrewRunWithOpenCode(draft, createOpenCodeCrewRuntimeDriver())
  })

  context.ipcMain.handle('crews:run-detail', async (_event, runId: string) => {
    assertString(runId, 'Crew run id')
    return getCrewRunDetail(runId)
  })

  context.ipcMain.handle('crews:evaluate', async (_event, runId: string) => {
    assertString(runId, 'Crew run id')
    return evaluateCrewRunWithOpenCode(runId, createOpenCodeCrewRuntimeDriver())
  })

  context.ipcMain.handle('crews:export-trace', async (_event, runId: string) => {
    assertString(runId, 'Crew run id')
    return exportCrewRunTraceNdjson(runId)
  })
}
