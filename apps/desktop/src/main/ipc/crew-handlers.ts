import type { CrewDefinitionDraft, CrewRunDraft } from '@open-cowork/shared'
import {
  createCrewFromDraft,
  evaluateCrewRunWithOpenCode,
  exportCrewRunTraceNdjson,
  getCrewDetail,
  getCrewRunDetail,
  listCrewCatalog,
  startCrewRunWithOpenCode,
} from '../crew-service.ts'
import { createOpenCodeCrewRuntimeDriver } from '../crew-runtime-execution.ts'
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
  if (value.budgetCapUsd !== undefined && value.budgetCapUsd !== null && typeof value.budgetCapUsd !== 'number') {
    throw new Error('Crew budget cap must be a number.')
  }
}

function assertCrewRunDraftPayload(value: unknown): asserts value is CrewRunDraft {
  assertObject(value, 'Crew run draft')
  assertString(value.crewId, 'Crew id')
  assertString(value.title, 'Crew run title')
  assertOptionalString(value.workItemTitle, 'Crew work item title')
  assertOptionalString(value.workItemDescription, 'Crew work item description')
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
