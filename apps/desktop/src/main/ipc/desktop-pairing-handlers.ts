import type {
  DesktopPairingCreateInput,
  DesktopPairingPolicy,
  DesktopPairingUpdateInput,
} from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import {
  noIpcArgs,
  objectArg,
  optionalStringArg,
  registerIpcInvoke,
  stringArg,
  stringAndObjectArgs,
} from './schema.ts'

function asRecord(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function stringArray(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error(`${label} must contain strings.`)
    return entry
  })
}

function decisionPolicy(value: unknown, label: string): DesktopPairingPolicy['remoteApprovals'] | undefined {
  if (value === undefined) return undefined
  if (value === 'disabled' || value === 'local_confirmation' || value === 'remote_allowed') return value
  throw new Error(`${label} must be disabled, local_confirmation, or remote_allowed.`)
}

function validatePolicy(value: unknown) {
  if (value === undefined) return undefined
  const record = asRecord(value, 'Desktop pairing policy')
  return {
    ...(typeof record.allowRemotePrompts === 'boolean' ? { allowRemotePrompts: record.allowRemotePrompts } : {}),
    ...(typeof record.allowRemoteAbort === 'boolean' ? { allowRemoteAbort: record.allowRemoteAbort } : {}),
    ...(record.remoteApprovals !== undefined ? { remoteApprovals: decisionPolicy(record.remoteApprovals, 'remoteApprovals') } : {}),
    ...(record.remoteQuestions !== undefined ? { remoteQuestions: decisionPolicy(record.remoteQuestions, 'remoteQuestions') } : {}),
    ...(typeof record.exposeArtifactBodies === 'boolean' ? { exposeArtifactBodies: record.exposeArtifactBodies } : {}),
    ...(typeof record.exposeLocalPaths === 'boolean' ? { exposeLocalPaths: record.exposeLocalPaths } : {}),
    ...(typeof record.exposeLocalMcpDetails === 'boolean' ? { exposeLocalMcpDetails: record.exposeLocalMcpDetails } : {}),
    ...(typeof record.allowRemoteAttachments === 'boolean' ? { allowRemoteAttachments: record.allowRemoteAttachments } : {}),
  } satisfies Partial<DesktopPairingPolicy>
}

function validateCreateInput(value: Record<string, unknown>): DesktopPairingCreateInput {
  if (typeof value.label !== 'string' || !value.label.trim()) {
    throw new Error('desktop-pairing:create requires a label.')
  }
  return {
    label: value.label,
    ...(typeof value.deviceName === 'string' ? { deviceName: value.deviceName } : {}),
    ...(value.brokerUrl === null || typeof value.brokerUrl === 'string' ? { brokerUrl: value.brokerUrl } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(value.allowedWorkspaceIds !== undefined ? { allowedWorkspaceIds: stringArray(value.allowedWorkspaceIds, 'allowedWorkspaceIds') || undefined } : {}),
    ...(value.allowedSessionIds !== undefined ? { allowedSessionIds: stringArray(value.allowedSessionIds, 'allowedSessionIds') } : {}),
    ...(value.policy !== undefined ? { policy: validatePolicy(value.policy) } : {}),
  }
}

function validateUpdateInput(value: Record<string, unknown>): DesktopPairingUpdateInput {
  return {
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.deviceName === 'string' ? { deviceName: value.deviceName } : {}),
    ...(value.brokerUrl === null || typeof value.brokerUrl === 'string' ? { brokerUrl: value.brokerUrl } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(value.allowedWorkspaceIds !== undefined ? { allowedWorkspaceIds: stringArray(value.allowedWorkspaceIds, 'allowedWorkspaceIds') || undefined } : {}),
    ...(value.allowedSessionIds !== undefined ? { allowedSessionIds: stringArray(value.allowedSessionIds, 'allowedSessionIds') } : {}),
    ...(value.policy !== undefined ? { policy: validatePolicy(value.policy) } : {}),
  }
}

export function registerDesktopPairingHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'desktop-pairing:list', noIpcArgs, async () => {
    return context.desktopPairingService.list()
  })

  registerIpcInvoke(context, 'desktop-pairing:create', objectArg<DesktopPairingCreateInput>('desktop pairing input', validateCreateInput), async (_event, input) => {
    return context.desktopPairingService.create(input)
  })

  registerIpcInvoke(context, 'desktop-pairing:update', stringAndObjectArgs<DesktopPairingUpdateInput>('desktop pairing id', 'desktop pairing update', { maxBytes: 512 }, validateUpdateInput), async (_event, pairingId, input) => {
    return context.desktopPairingService.update(pairingId, input)
  })

  registerIpcInvoke(context, 'desktop-pairing:connect', stringArg('desktop pairing id'), async (_event, pairingId) => {
    return context.desktopPairingService.connect(pairingId)
  })

  registerIpcInvoke(context, 'desktop-pairing:disconnect', stringArg('desktop pairing id'), async (_event, pairingId) => {
    return context.desktopPairingService.disconnect(pairingId)
  })

  registerIpcInvoke(context, 'desktop-pairing:revoke', stringArg('desktop pairing id'), async (_event, pairingId) => {
    return context.desktopPairingService.revoke(pairingId)
  })

  registerIpcInvoke(context, 'desktop-pairing:sync', stringArg('desktop pairing id'), async (_event, pairingId) => {
    return context.desktopPairingService.pollOnce(pairingId)
  })

  registerIpcInvoke(context, 'desktop-pairing:audit', optionalStringArg('desktop pairing id'), async (_event, pairingId) => {
    return context.desktopPairingService.auditLog(pairingId)
  })
}
