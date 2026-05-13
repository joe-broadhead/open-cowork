import type { IpcHandlerContext } from './context.ts'
import type {
  GovernanceCrewIncidentControlRequest,
  GovernanceMemoryIncidentControlRequest,
  GovernanceToolIncidentControlRequest,
} from '@open-cowork/shared'
import {
  buildOperationalQueueAlerts,
  listOperationalQueueItems,
  listWorkspaceProfiles,
  recoverInterruptedOperationalQueueItems,
} from '../operational-queue-store.ts'
import { getOperationsSummary } from '../operation-command-center.ts'
import { listCapabilityRiskMetadata } from '../operation-capability-risk.ts'
import { getGovernanceRegistry } from '../governance-registry.ts'
import { exportGovernanceAuditEvents } from '../governance-audit-export.ts'
import { listGovernanceAuditEvents } from '../governance-audit-store.ts'
import {
  pauseGovernanceAgent,
  retireGovernanceAgent,
  type GovernanceAgentIncidentControlRequest,
} from '../governance-agent-controls.ts'
import {
  quarantineGovernanceMemory,
} from '../governance-memory-controls.ts'
import {
  revokeGovernanceTool,
} from '../governance-tool-controls.ts'
import {
  pauseCrew,
  retireCrew,
} from '../crew-service.ts'

function assertOptionalGovernanceAuditOptions(value: unknown): asserts value is Parameters<typeof listGovernanceAuditEvents>[0] {
  if (value === undefined) return
  if (value === null) throw new Error('Governance audit options must be an object.')
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Governance audit options must be an object.')
  const options = value as Record<string, unknown>
  if (
    options.subjectKind !== undefined
    && options.subjectKind !== 'agent'
    && options.subjectKind !== 'crew'
    && options.subjectKind !== 'memory'
    && options.subjectKind !== 'tool'
  ) {
    throw new Error('Governance audit subject kind is invalid.')
  }
  if (options.subjectId !== undefined && typeof options.subjectId !== 'string') {
    throw new Error('Governance audit subject id must be a string.')
  }
  if ((options.subjectKind && !options.subjectId) || (!options.subjectKind && options.subjectId)) {
    throw new Error('Governance audit subject filters require both kind and id.')
  }
  if (options.limit !== undefined && (typeof options.limit !== 'number' || !Number.isFinite(options.limit))) {
    throw new Error('Governance audit limit must be a finite number.')
  }
}

function assertToolIncidentControlRequest(value: unknown): asserts value is GovernanceToolIncidentControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool incident request must be an object.')
  }
  const request = value as Record<string, unknown>
  if (typeof request.toolId !== 'string' || request.toolId.trim().length === 0) {
    throw new Error('Tool incident id is required.')
  }
  if (request.reason !== undefined && request.reason !== null && typeof request.reason !== 'string') {
    throw new Error('Tool incident reason must be a string.')
  }
  if (request.context !== undefined) {
    if (!request.context || typeof request.context !== 'object' || Array.isArray(request.context)) {
      throw new Error('Tool incident context must be an object.')
    }
    const context = request.context as Record<string, unknown>
    if (context.directory !== undefined && context.directory !== null && typeof context.directory !== 'string') {
      throw new Error('Tool incident context directory must be a string.')
    }
  }
}

function assertOptionalGovernanceAuditExportOptions(value: unknown): asserts value is Parameters<typeof exportGovernanceAuditEvents>[0] {
  assertOptionalGovernanceAuditOptions(value)
  if (value === undefined) return
  const options = value as Record<string, unknown>
  if (options.format !== undefined && options.format !== 'ndjson' && options.format !== 'otel-json') {
    throw new Error('Governance audit export format is invalid.')
  }
}

function assertAgentIncidentControlRequest(value: unknown): asserts value is GovernanceAgentIncidentControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent incident request must be an object.')
  }
  const request = value as Record<string, unknown>
  if (typeof request.subjectId !== 'string' || request.subjectId.trim().length === 0) {
    throw new Error('Agent incident subject id is required.')
  }
  if (request.reason !== undefined && request.reason !== null && typeof request.reason !== 'string') {
    throw new Error('Agent incident reason must be a string.')
  }
  if (request.context !== undefined) {
    if (!request.context || typeof request.context !== 'object' || Array.isArray(request.context)) {
      throw new Error('Agent incident context must be an object.')
    }
    const context = request.context as Record<string, unknown>
    if (context.sessionId !== undefined && context.sessionId !== null && typeof context.sessionId !== 'string') {
      throw new Error('Agent incident context session id must be a string.')
    }
    if (context.directory !== undefined && context.directory !== null && typeof context.directory !== 'string') {
      throw new Error('Agent incident context directory must be a string.')
    }
  }
}

function assertCrewIncidentControlRequest(value: unknown): asserts value is GovernanceCrewIncidentControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Crew incident request must be an object.')
  }
  const request = value as Record<string, unknown>
  if (typeof request.crewId !== 'string' || request.crewId.trim().length === 0) {
    throw new Error('Crew incident id is required.')
  }
  if (request.reason !== undefined && request.reason !== null && typeof request.reason !== 'string') {
    throw new Error('Crew incident reason must be a string.')
  }
  if (request.confirmationToken !== undefined && request.confirmationToken !== null && typeof request.confirmationToken !== 'string') {
    throw new Error('Crew incident confirmation token must be a string.')
  }
}

function assertMemoryIncidentControlRequest(value: unknown): asserts value is GovernanceMemoryIncidentControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Memory incident request must be an object.')
  }
  const request = value as Record<string, unknown>
  if (typeof request.memoryId !== 'string' || request.memoryId.trim().length === 0) {
    throw new Error('Memory incident id is required.')
  }
  if (request.reason !== undefined && request.reason !== null && typeof request.reason !== 'string') {
    throw new Error('Memory incident reason must be a string.')
  }
}

function resolveAgentIncidentControlRequest(
  context: IpcHandlerContext,
  request: GovernanceAgentIncidentControlRequest,
): GovernanceAgentIncidentControlRequest {
  if (!request.context) return request
  const hasContext = Boolean(request.context.sessionId?.trim()) || Boolean(request.context.directory?.trim())
  if (!hasContext) return { ...request, context: undefined }
  const directory = context.resolveContextDirectory(request.context)
  if (!directory) {
    throw new Error('Agent incident context requires an active project directory.')
  }
  return {
    ...request,
    context: { directory },
  }
}

function resolveToolIncidentControlRequest(
  context: IpcHandlerContext,
  request: GovernanceToolIncidentControlRequest,
): GovernanceToolIncidentControlRequest {
  if (!request.context) return request
  const hasContext = Boolean(request.context.directory?.trim())
  if (!hasContext) return { ...request, context: undefined }
  const directory = context.resolveContextDirectory(request.context)
  if (!directory) {
    throw new Error('Tool incident context requires an active project directory.')
  }
  return {
    ...request,
    context: { directory },
  }
}

async function rebootRuntimeForIncidentControl() {
  const { rebootRuntime } = await import('../index.ts')
  await rebootRuntime()
}

export function registerOperationHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('operations:workspace-profiles', async () => {
    return listWorkspaceProfiles()
  })

  context.ipcMain.handle('operations:queue-items', async () => {
    recoverInterruptedOperationalQueueItems()
    return listOperationalQueueItems()
  })

  context.ipcMain.handle('operations:queue-alerts', async () => {
    recoverInterruptedOperationalQueueItems()
    return buildOperationalQueueAlerts()
  })

  context.ipcMain.handle('operations:summary', async () => {
    return getOperationsSummary()
  })

  context.ipcMain.handle('operations:capability-risks', async () => {
    return listCapabilityRiskMetadata()
  })

  context.ipcMain.handle('operations:governance-registry', async () => {
    return getGovernanceRegistry()
  })

  context.ipcMain.handle('operations:governance-audit-events', async (_event, options?: unknown) => {
    assertOptionalGovernanceAuditOptions(options)
    return listGovernanceAuditEvents(options)
  })

  context.ipcMain.handle('operations:export-governance-audit', async (_event, options?: unknown) => {
    assertOptionalGovernanceAuditExportOptions(options)
    return exportGovernanceAuditEvents(options)
  })

  context.ipcMain.handle('operations:pause-agent', async (_event, request: unknown) => {
    assertAgentIncidentControlRequest(request)
    return pauseGovernanceAgent(resolveAgentIncidentControlRequest(context, request), {
      buildCustomAgentPermission: context.buildCustomAgentPermission,
      rebootRuntime: rebootRuntimeForIncidentControl,
    })
  })

  context.ipcMain.handle('operations:retire-agent', async (_event, request: unknown) => {
    assertAgentIncidentControlRequest(request)
    return retireGovernanceAgent(resolveAgentIncidentControlRequest(context, request), {
      buildCustomAgentPermission: context.buildCustomAgentPermission,
      rebootRuntime: rebootRuntimeForIncidentControl,
    })
  })

  context.ipcMain.handle('operations:pause-crew', async (_event, request: unknown) => {
    assertCrewIncidentControlRequest(request)
    return pauseCrew(request.crewId, { reason: request.reason })
  })

  context.ipcMain.handle('operations:retire-crew', async (_event, request: unknown) => {
    assertCrewIncidentControlRequest(request)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'crew.retire', crewId: request.crewId }, request.confirmationToken)) {
        throw new Error('Confirmation required before retiring a crew.')
      }
      return retireCrew(request.crewId, { reason: request.reason })
    } catch (err) {
      context.logHandlerError(`operations:retire-crew ${request.crewId}`, err)
      return null
    }
  })

  context.ipcMain.handle('operations:quarantine-memory', async (_event, request: unknown) => {
    assertMemoryIncidentControlRequest(request)
    return quarantineGovernanceMemory(request)
  })

  context.ipcMain.handle('operations:revoke-tool', async (_event, request: unknown) => {
    assertToolIncidentControlRequest(request)
    return revokeGovernanceTool(resolveToolIncidentControlRequest(context, request), {
      rebootRuntime: rebootRuntimeForIncidentControl,
    })
  })
}
