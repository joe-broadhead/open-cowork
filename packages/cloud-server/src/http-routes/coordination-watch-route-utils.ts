import type {
  CoordinationTask,
  CoordinationTarget,
  CoordinationWatch,
  CoordinationWatchChannel,
  CoordinationWatchEvent,
  CoordinationWatchInput,
  CoordinationWatchStatus,
  CoordinationWatchUpdateInput,
} from '@open-cowork/shared'
import {
  isCoordinationWatchStatus,
  isCoordinationWatchTarget,
} from '@open-cowork/shared'
import { CloudServiceError } from '../cloud-service-error.ts'
import { normalizeChannelProviderId } from '../channel-provider-utils.ts'
import {
  principalHasOrgAdminRole,
  principalHasPrivilegedTokenScope,
} from '../principal-access.ts'
import type { CloudApiRouteInput } from './types.ts'

export function hasOwnField(body: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(body, field)
}

export function assertImplementedWatchTarget(target: CoordinationTarget) {
  if (
    target.kind !== 'project'
    && target.kind !== 'task'
    && target.kind !== 'session'
    && target.kind !== 'conversation'
  ) {
    throw new Error(`Watch target kind "${target.kind}" is not supported until ${target.kind} watch events are implemented.`)
  }
}

export function watchTargetFromQuery(url: URL): CoordinationTarget | null {
  const targetKind = url.searchParams.get('targetKind')?.trim() || null
  const targetId = url.searchParams.get('targetId')?.trim() || null
  if (!targetKind && !targetId) return null
  if (!targetKind || !targetId || !isCoordinationWatchTarget(targetKind)) {
    throw new Error('Watch target kind and target id must be valid when filtering watches.')
  }
  const target = { kind: targetKind, id: targetId }
  assertImplementedWatchTarget(target)
  return target
}

export function watchStatusFromQuery(url: URL): CoordinationWatchStatus | null {
  const status = url.searchParams.get('status')?.trim() || null
  if (!status) return null
  if (!isCoordinationWatchStatus(status)) throw new Error('Watch status is invalid.')
  return status
}

export function watchTargetFromBody(body: Record<string, unknown>): CoordinationTarget | null {
  const target = body.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null
  const record = target as Record<string, unknown>
  if (!isCoordinationWatchTarget(record.kind) || typeof record.id !== 'string' || !record.id.trim()) return null
  return { kind: record.kind, id: record.id.trim() }
}

export function watchCreateInputFromBody(body: Record<string, unknown>, target: CoordinationTarget): CoordinationWatchInput {
  return {
    target,
    events: body.events as CoordinationWatchInput['events'],
    channel: body.channel as CoordinationWatchInput['channel'],
    recipient: hasOwnField(body, 'recipient') ? body.recipient as CoordinationWatchInput['recipient'] : undefined,
    status: hasOwnField(body, 'status') ? body.status as CoordinationWatchInput['status'] : undefined,
    deliverySurface: hasOwnField(body, 'deliverySurface') ? body.deliverySurface as CoordinationWatchInput['deliverySurface'] : undefined,
    verbosity: hasOwnField(body, 'verbosity') ? body.verbosity as CoordinationWatchInput['verbosity'] : undefined,
    cursor: hasOwnField(body, 'cursor') ? body.cursor as CoordinationWatchInput['cursor'] : undefined,
  }
}

export function watchUpdateInputFromBody(body: Record<string, unknown>, target: CoordinationTarget | null): CoordinationWatchUpdateInput {
  const input: CoordinationWatchUpdateInput = {}
  if (target) input.target = target
  if (hasOwnField(body, 'events')) input.events = body.events as CoordinationWatchUpdateInput['events']
  if (hasOwnField(body, 'channel')) input.channel = body.channel as CoordinationWatchUpdateInput['channel']
  if (hasOwnField(body, 'recipient')) input.recipient = body.recipient as CoordinationWatchUpdateInput['recipient']
  if (hasOwnField(body, 'status')) input.status = body.status as CoordinationWatchUpdateInput['status']
  if (hasOwnField(body, 'deliverySurface')) input.deliverySurface = body.deliverySurface as CoordinationWatchUpdateInput['deliverySurface']
  if (hasOwnField(body, 'verbosity')) input.verbosity = body.verbosity as CoordinationWatchUpdateInput['verbosity']
  if (hasOwnField(body, 'cursor')) input.cursor = body.cursor as CoordinationWatchUpdateInput['cursor']
  return input
}

export async function validateWatchChannel(input: CloudApiRouteInput, body: Record<string, unknown>) {
  const channel = body.channel
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
    throw new Error('Watch channel is required.')
  }
  await validateWatchChannelAuthority(input, channel as Record<string, unknown>)
  return normalizeCloudWatchRecipient(input, body)
}

export async function validateExistingWatchMutation(input: CloudApiRouteInput, watch: CoordinationWatch) {
  if (!principalCanSetPrivilegedWatchRecipient(input)) {
    await validateWatchChannelAuthority(input, watch.channel)
  }
  assertPrivilegedWatchRecipientAllowed(input, watch.recipient?.role || null)
}

export function normalizeCloudWatchRecipient(input: CloudApiRouteInput, body: Record<string, unknown>) {
  const recipient = body.recipient
  if (recipient === undefined || recipient === null) {
    return principalCanSetPrivilegedWatchRecipient(input)
      ? body
      : { ...body, recipient: { role: 'viewer' } }
  }
  if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) {
    throw new Error('Watch recipient must be an object.')
  }
  const role = (recipient as Record<string, unknown>).role || null
  if (!role && !principalCanSetPrivilegedWatchRecipient(input)) {
    return {
      ...body,
      recipient: {
        ...(recipient as Record<string, unknown>),
        role: 'viewer',
      },
    }
  }
  assertPrivilegedWatchRecipientAllowed(input, role)
  return body
}

export async function requireCloudWatchInWorkspace(input: CloudApiRouteInput, watchId: string, workspaceId: string) {
  const watch = await input.options.service.getCloudCoordinationWatch(input.context.principal, workspaceId, watchId)
  if (!watch || watch.workspaceId !== workspaceId) {
    input.tools.writeError(input.res, 404, 'Coordination watch was not found.', input.options.corsOrigin)
    return null
  }
  return watch
}

export async function filterAuthorizedWatches(input: CloudApiRouteInput, watches: CoordinationWatch[]) {
  const authorized: CoordinationWatch[] = []
  for (const watch of watches) {
    try {
      await validateExistingWatchMutation(input, watch)
      authorized.push(watch)
    } catch (error) {
      if (coordinationErrorStatus(error) >= 500) throw error
    }
  }
  return authorized
}

export async function emitCloudTaskWatchEvents(
  input: CloudApiRouteInput,
  before: CoordinationTask | null,
  task: CoordinationTask,
) {
  if (!before || before.column === task.column) return
  const events: CoordinationWatchEvent[] = [{
    eventType: 'task.moved',
    workspaceId: task.workspaceId,
    target: { kind: 'task', id: task.id },
    relatedTargets: [{ kind: 'project', id: task.projectId }],
    title: 'Task moved',
    message: `${task.title} moved to ${task.column}.`,
    metadata: { taskId: task.id, projectId: task.projectId, previousColumn: before.column, column: task.column },
  }]
  if (task.column === 'review') {
    events.push({
      eventType: 'task.review_ready',
      workspaceId: task.workspaceId,
      target: { kind: 'task', id: task.id },
      relatedTargets: [{ kind: 'project', id: task.projectId }],
      title: 'Task ready for review',
      message: task.title,
      metadata: { taskId: task.id, projectId: task.projectId, column: task.column, status: task.status },
    })
  }
  for (const event of events) {
    await input.options.service.emitCloudCoordinationWatchEvent(input.context.principal, event)
  }
}

function principalCanSetPrivilegedWatchRecipient(input: CloudApiRouteInput) {
  const principal = input.context.principal
  if (principal.authSource === 'local') return true
  if (principal.authSource === 'api_token') return principalHasPrivilegedTokenScope(principal, 'admin')
  return principalHasOrgAdminRole(principal)
}

function assertPrivilegedWatchRecipientAllowed(input: CloudApiRouteInput, role: unknown) {
  if (role === 'viewer') return
  if (principalCanSetPrivilegedWatchRecipient(input)) return
  throw new CloudServiceError(403, 'Privileged watch recipient roles require channel administration access.')
}

async function validateWatchChannelAuthority(
  input: CloudApiRouteInput,
  channel: CoordinationWatchChannel | Record<string, unknown>,
) {
  const provider = normalizeChannelProviderId(channel.provider)
  const agentId = input.tools.readString(channel.agentId)
  const channelBindingId = input.tools.readString(channel.channelBindingId)
  if (!provider || !agentId || !channelBindingId) {
    throw new Error('Watch channel provider, agent id, and channel binding id are required.')
  }
  await input.options.service.validateChannelDeliveryTarget(input.context.principal, {
    agentId,
    channelBindingId,
    sessionBindingId: input.tools.readString(channel.sessionBindingId),
    provider,
  })
}

function coordinationErrorStatus(error: unknown) {
  const status = Number((error as { status?: unknown } | null)?.status)
  if (Number.isInteger(status) && status >= 400 && status < 600) return status
  return error instanceof Error ? 500 : 500
}
