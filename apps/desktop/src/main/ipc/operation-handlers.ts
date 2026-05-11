import type { IpcHandlerContext } from './context.ts'
import {
  buildOperationalQueueAlerts,
  listOperationalQueueItems,
  listWorkspaceProfiles,
  recoverInterruptedOperationalQueueItems,
} from '../operational-queue-store.ts'
import { listCapabilityRiskMetadata } from '../operation-capability-risk.ts'
import { getGovernanceRegistry } from '../governance-registry.ts'
import { listGovernanceAuditEvents } from '../governance-audit-store.ts'

function assertOptionalGovernanceAuditOptions(value: unknown): asserts value is Parameters<typeof listGovernanceAuditEvents>[0] {
  if (value === undefined) return
  if (value === null) throw new Error('Governance audit options must be an object.')
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Governance audit options must be an object.')
  const options = value as Record<string, unknown>
  if (options.subjectKind !== undefined && options.subjectKind !== 'agent' && options.subjectKind !== 'crew') {
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
}
