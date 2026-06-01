import type { AddCloudWorkspaceInput, AddGatewayWorkspaceInput } from '@open-cowork/shared'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcHandlerContext } from './context.ts'
import {
  noIpcArgs,
  objectArg,
  optionalStringArg,
  registerIpcInvoke,
  stringArg,
} from './schema.ts'

async function subscribeWorkspaceUpdates(context: IpcHandlerContext, event: IpcMainInvokeEvent, workspaceId: string) {
  const workspace = context.workspaceGateway.list(event).find((entry) => entry.id === workspaceId)
  if (!workspace || workspace.kind !== 'cloud' || workspace.status !== 'online') return
  await context.workspaceGateway.subscribeCloudWorkspaceEvents(event, {
    workspaceId,
    onEvent: (cloudEvent) => {
      void context.workspaceGateway.listCloudSessions(event, workspaceId)
        .then((sessions) => {
          const sender = event.sender as { isDestroyed?: () => boolean, send?: (channel: string, payload: unknown) => void }
          if (sender.isDestroyed?.()) return
          sender.send?.('workspace:sessions-updated', {
            workspaceId,
            sessions,
            lastEventSequence: Number.isFinite(cloudEvent.sequence) ? cloudEvent.sequence : null,
            syncedAt: new Date().toISOString(),
          })
        })
        .catch((error) => context.logHandlerError('workspace:sessions-updated', error))
    },
    onError: (error) => context.logHandlerError('workspace:events', error),
  })
}

function validateAddCloudWorkspaceInput(value: Record<string, unknown>): AddCloudWorkspaceInput {
  if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) {
    throw new Error('workspace:add-cloud requires baseUrl.')
  }
  const input: AddCloudWorkspaceInput = {
    baseUrl: value.baseUrl.trim(),
  }
  if (value.label !== undefined && value.label !== null) {
    if (typeof value.label !== 'string') throw new Error('workspace:add-cloud label must be a string.')
    const label = value.label.trim()
    if (label) input.label = label
  }
  return input
}

function validateAddGatewayWorkspaceInput(value: Record<string, unknown>): AddGatewayWorkspaceInput {
  if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) {
    throw new Error('workspace:add-gateway requires baseUrl.')
  }
  const input: AddGatewayWorkspaceInput = {
    baseUrl: value.baseUrl.trim(),
  }
  if (value.label !== undefined && value.label !== null) {
    if (typeof value.label !== 'string') throw new Error('workspace:add-gateway label must be a string.')
    const label = value.label.trim()
    if (label) input.label = label
  }
  if (value.token !== undefined && value.token !== null) {
    if (typeof value.token !== 'string') throw new Error('workspace:add-gateway token must be a string.')
    const token = value.token.trim()
    if (token) input.token = token
  }
  return input
}

export function registerWorkspaceHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'workspace:list', noIpcArgs, async (event) => {
    return context.workspaceGateway.list(event)
  })

  registerIpcInvoke(context, 'workspace:activate', stringArg('workspace id'), async (event, workspaceId) => {
    const activated = context.workspaceGateway.activate(event, workspaceId)
    await subscribeWorkspaceUpdates(context, event, activated.id)
    return activated
  })

  registerIpcInvoke(context, 'workspace:add-cloud', objectArg<AddCloudWorkspaceInput>('cloud workspace input', validateAddCloudWorkspaceInput), async (event, input) => {
    return context.workspaceGateway.addCloud(event, input)
  })

  registerIpcInvoke(context, 'workspace:add-gateway', objectArg<AddGatewayWorkspaceInput>('gateway workspace input', validateAddGatewayWorkspaceInput), async (event, input) => {
    return context.workspaceGateway.addGateway(event, input)
  })

  registerIpcInvoke(context, 'workspace:remove', stringArg('workspace id'), async (event, workspaceId) => {
    return context.workspaceGateway.remove(event, workspaceId)
  })

  registerIpcInvoke(context, 'workspace:login', stringArg('workspace id'), async (event, workspaceId) => {
    const loggedIn = await context.workspaceGateway.login(event, workspaceId)
    await subscribeWorkspaceUpdates(context, event, loggedIn.id)
    return loggedIn
  })

  registerIpcInvoke(context, 'workspace:logout', stringArg('workspace id'), async (event, workspaceId) => {
    return context.workspaceGateway.logout(event, workspaceId)
  })

  registerIpcInvoke(context, 'workspace:policy', optionalStringArg('workspace id'), async (event, workspaceId) => {
    return context.workspaceGateway.cloudPolicy(event, workspaceId)
  })

  registerIpcInvoke(context, 'workspace:support', optionalStringArg('workspace id'), async (event, workspaceId) => {
    return context.workspaceGateway.supportMatrix(event, workspaceId)
  })

  registerIpcInvoke(context, 'workspace:sync', optionalStringArg('workspace id'), async (event, workspaceId) => {
    const result = await context.workspaceGateway.sync(event, workspaceId)
    const activeWorkspaceId = workspaceId || context.workspaceGateway.activeWorkspaceId(event)
    await subscribeWorkspaceUpdates(context, event, activeWorkspaceId)
    const workspace = context.workspaceGateway.list(event).find((entry) => entry.id === activeWorkspaceId)
    if (workspace?.kind === 'cloud' && workspace.status === 'online') {
      const sessions = await context.workspaceGateway.listCloudSessions(event, activeWorkspaceId)
      const sender = event.sender as { isDestroyed?: () => boolean, send?: (channel: string, payload: unknown) => void }
      if (!sender.isDestroyed?.()) {
        sender.send?.('workspace:sessions-updated', {
          workspaceId: activeWorkspaceId,
          sessions,
          lastEventSequence: null,
          syncedAt: result.syncedAt,
        })
      }
    }
    return result
  })
}
