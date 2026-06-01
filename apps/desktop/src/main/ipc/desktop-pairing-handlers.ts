import type {
  DesktopPairingCreateInput,
  DesktopPairingPolicy,
  DesktopPairingPublicRecord,
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

function brokerOrigin(value: string | null | undefined) {
  if (!value) return 'No broker URL'
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}

function scopeSummary(input: Pick<DesktopPairingCreateInput, 'allowedWorkspaceIds' | 'allowedSessionIds'>) {
  const workspaces = input.allowedWorkspaceIds?.length ? input.allowedWorkspaceIds.join(', ') : 'local'
  const sessions = input.allowedSessionIds === null
    ? 'all sessions'
    : input.allowedSessionIds?.length
      ? input.allowedSessionIds.join(', ')
      : 'all sessions'
  return `Workspaces: ${workspaces}\nSessions: ${sessions}`
}

function policySummary(policy: Partial<DesktopPairingPolicy> | undefined) {
  if (!policy) return 'Default policy'
  const entries = Object.entries(policy)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`)
  return entries.length > 0 ? entries.join('\n') : 'Default policy'
}

async function confirmDesktopPairingCreate(context: IpcHandlerContext, input: DesktopPairingCreateInput) {
  const confirmed = await context.requestNativeConfirmation({
    title: 'Create desktop pairing?',
    message: 'Allow this desktop pairing and show its token?',
    detail: [
      `Broker: ${brokerOrigin(input.brokerUrl)}`,
      scopeSummary(input),
      policySummary(input.policy),
      'The token can connect a remote broker to this desktop until the pairing is revoked.',
    ].join('\n'),
    confirmLabel: 'Create Pairing',
  })
  if (!confirmed) throw new Error('Desktop pairing creation cancelled.')
}

function requiresPairingUpdateConfirmation(existing: DesktopPairingPublicRecord, input: DesktopPairingUpdateInput) {
  return (input.enabled === true && !existing.enabled)
    || (input.brokerUrl !== undefined && input.brokerUrl !== existing.brokerUrl)
    || input.policy !== undefined
}

async function confirmDesktopPairingUpdate(
  context: IpcHandlerContext,
  existing: DesktopPairingPublicRecord,
  input: DesktopPairingUpdateInput,
) {
  if (!requiresPairingUpdateConfirmation(existing, input)) return
  const confirmed = await context.requestNativeConfirmation({
    title: 'Change desktop pairing authority?',
    message: 'Allow this desktop pairing change?',
    detail: [
      `Pairing: ${existing.label}`,
      `Broker: ${brokerOrigin(input.brokerUrl !== undefined ? input.brokerUrl : existing.brokerUrl)}`,
      input.enabled === true && !existing.enabled ? 'Change: enable remote connection' : null,
      input.brokerUrl !== undefined && input.brokerUrl !== existing.brokerUrl ? 'Change: broker URL' : null,
      input.policy !== undefined ? `Policy change:\n${policySummary(input.policy)}` : null,
      'Remote prompts and session control remain available according to this policy until the pairing is disabled or revoked.',
    ].filter(Boolean).join('\n'),
    confirmLabel: 'Allow Change',
  })
  if (!confirmed) throw new Error('Desktop pairing update cancelled.')
}

async function confirmDesktopPairingConnect(context: IpcHandlerContext, existing: DesktopPairingPublicRecord) {
  if (existing.enabled) return
  const confirmed = await context.requestNativeConfirmation({
    title: 'Enable desktop pairing?',
    message: 'Allow this remote desktop pairing to connect?',
    detail: [
      `Pairing: ${existing.label}`,
      `Broker: ${brokerOrigin(existing.brokerUrl)}`,
      scopeSummary(existing),
      policySummary(existing.policy),
    ].join('\n'),
    confirmLabel: 'Enable Pairing',
  })
  if (!confirmed) throw new Error('Desktop pairing enable cancelled.')
}

export function registerDesktopPairingHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'desktop-pairing:list', noIpcArgs, async () => {
    return context.desktopPairingService.list()
  })

  registerIpcInvoke(context, 'desktop-pairing:create', objectArg<DesktopPairingCreateInput>('desktop pairing input', validateCreateInput), async (_event, input) => {
    await confirmDesktopPairingCreate(context, input)
    return context.desktopPairingService.create(input)
  })

  registerIpcInvoke(context, 'desktop-pairing:update', stringAndObjectArgs<DesktopPairingUpdateInput>('desktop pairing id', 'desktop pairing update', { maxBytes: 512 }, validateUpdateInput), async (_event, pairingId, input) => {
    const existing = context.desktopPairingService.get(pairingId)
    if (!existing) throw new Error('Desktop pairing not found.')
    await confirmDesktopPairingUpdate(context, existing, input)
    return context.desktopPairingService.update(pairingId, input)
  })

  registerIpcInvoke(context, 'desktop-pairing:connect', stringArg('desktop pairing id'), async (_event, pairingId) => {
    const existing = context.desktopPairingService.get(pairingId)
    if (!existing) throw new Error('Desktop pairing not found.')
    await confirmDesktopPairingConnect(context, existing)
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
