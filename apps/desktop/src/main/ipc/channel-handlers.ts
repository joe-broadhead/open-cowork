import { createCoordinationWatch, deleteCoordinationWatch, getCoordinationWatchDetail, listCoordinationWatches, pauseCoordinationWatch, resumeCoordinationWatch, updateCoordinationWatch } from '@open-cowork/runtime-host/coordination/coordination-service'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildChannelProviderStatuses,
  isCoordinationWatchStatus,
  isCoordinationWatchTarget,
  type ChannelAgentInput,
  type ChannelAgentListOptions,
  type ChannelBindingConnectInput,
  type ChannelBindingListOptions,
  type ChannelBindingUpdateInput,
  type ChannelDeliveryDeadLetterInput,
  type ChannelDeliveryListOptions,
  type ChannelPeopleListOptions,
  type ChannelPersonResolveInput,
  type ChannelWatchListOptions,
  type CoordinationTarget,
  type CoordinationWatchInput,
  type CoordinationWatchStatus,
  type CoordinationWatchUpdateInput,
  type WorkspaceOptions,
} from '@open-cowork/shared'
import type { IpcMainInvokeEvent } from 'electron'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { getAppConfig } from '@open-cowork/runtime-host/config'
import { createUnavailableRuntimeAdapter } from '@open-cowork/cloud-server/unavailable-runtime-adapter'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore, type InMemoryChannelStateSnapshot } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { normalizeChannelProviderId } from '@open-cowork/cloud-server/channel-provider-utils'
import { publicChannelIdentity } from '@open-cowork/cloud-server/public-channel-records'
import { CloudSessionService, type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { getAppDataDir } from '@open-cowork/runtime-host/config'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'
import type { IpcHandlerContext } from './context.ts'
import {
  objectArg,
  optionalObjectArg,
  stringAndObjectArgs,
  stringAndOptionalObjectArgs,
  stringArg,
  registerIpcInvoke,
} from './schema.ts'

const LOCAL_CHANNEL_TENANT_ID = 'desktop-local'
const LOCAL_CHANNEL_ORG_ID = 'desktop-local'
const LOCAL_CHANNEL_ACCOUNT_ID = 'desktop-local-owner'

let channelService: CloudSessionService | null = null
let channelStore: InMemoryControlPlaneStore | null = null

type DesktopChannelAgentUpdateInput = {
  name?: string
  profileName?: string
  status?: 'active' | 'disabled'
  managed?: boolean
}

function getDesktopChannelService() {
  if (!channelService) {
    const config = getAppConfig()
    const store = new InMemoryControlPlaneStore()
    seedDesktopChannelPrincipal(store)
    restoreDesktopChannelSnapshot(store)
    channelStore = store
    channelService = new CloudSessionService(
      store,
      createUnavailableRuntimeAdapter('Desktop channel IPC does not execute Cloud runtime sessions.'),
      resolveCloudRuntimePolicy(config),
      undefined,
      { randomUUID },
      undefined,
      null,
      {},
      config.cloud?.abuse || DEFAULT_CONFIG.cloud.abuse,
      config.cloud?.billing || DEFAULT_CONFIG.cloud.billing,
    )
  }
  return channelService
}

function desktopChannelSnapshotPath() {
  return join(getAppDataDir(), 'desktop-channels.json')
}

function seedDesktopChannelPrincipal(store: InMemoryControlPlaneStore) {
  store.ensureOrgForTenant({
    tenantId: LOCAL_CHANNEL_TENANT_ID,
    name: 'Desktop Local',
    orgId: LOCAL_CHANNEL_ORG_ID,
  })
  if (!store.accountExists(LOCAL_CHANNEL_ACCOUNT_ID)) {
    store.createAccount({
      accountId: LOCAL_CHANNEL_ACCOUNT_ID,
      idpSubject: LOCAL_CHANNEL_ACCOUNT_ID,
      email: 'desktop-local@open-cowork.local',
    })
  }
}

function isChannelSnapshot(value: unknown): value is InMemoryChannelStateSnapshot {
  const record = value as Partial<InMemoryChannelStateSnapshot> | null
  return Boolean(
    record
      && record.version === 1
      && typeof record.orgId === 'string'
      && Array.isArray(record.headlessAgents)
      && Array.isArray(record.channelBindings)
      && Array.isArray(record.channelIdentities)
      && Array.isArray(record.channelDeliveries),
  )
}

function restoreDesktopChannelSnapshot(store: InMemoryControlPlaneStore) {
  const path = desktopChannelSnapshotPath()
  if (!existsSync(path)) return
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (isChannelSnapshot(parsed)) store.restoreChannelState(parsed)
  } catch {
    // A corrupt local snapshot must not block opening the desktop Channels page.
  }
}

function persistDesktopChannelSnapshot() {
  if (!channelStore) return
  const dir = getAppDataDir()
  const path = desktopChannelSnapshotPath()
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const snapshot = channelStore.snapshotChannelState(LOCAL_CHANNEL_ORG_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmpPath, path)
}

export function resetDesktopChannelServiceForTests() {
  channelService = null
  channelStore = null
}

function localPrincipal(): CloudPrincipal {
  return {
    tenantId: LOCAL_CHANNEL_TENANT_ID,
    tenantName: 'Desktop Local',
    orgId: LOCAL_CHANNEL_ORG_ID,
    userId: LOCAL_CHANNEL_ACCOUNT_ID,
    accountId: LOCAL_CHANNEL_ACCOUNT_ID,
    email: 'desktop-local@open-cowork.local',
    role: 'owner',
    authSource: 'local',
  }
}

function readString(value: unknown, label: string, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) {
    if (required) throw new Error(`${label} is required.`)
    return null
  }
  if (trimmed.length > 512) throw new Error(`${label} exceeds 512 characters.`)
  return trimmed
}

function requireString(value: unknown, label: string) {
  return readString(value, label, true) as string
}

function readRecord(value: unknown, label: string) {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function readLimit(value: unknown, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0 ? Math.min(Number(value), 500) : fallback
}

function readProvider(value: unknown, label = 'Channel provider') {
  if (value === undefined || value === null || value === '') return undefined
  return normalizeChannelProviderId(requireString(value, label))
}

function requireProvider(value: unknown, label = 'Channel provider') {
  const provider = readProvider(value, label)
  if (!provider) throw new Error(`${label} is required.`)
  return provider
}

function readBindingStatus(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'active' || value === 'disabled' || value === 'auth_required' || value === 'error') return value
  throw new Error('Channel binding status is invalid.')
}

function readAgentStatus(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'active' || value === 'disabled') return value
  throw new Error('Channel agent status is invalid.')
}

function readIdentityRole(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'owner' || value === 'admin' || value === 'member' || value === 'approver' || value === 'viewer') return value
  throw new Error('Channel identity role is invalid.')
}

function readIdentityStatus(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'active' || value === 'disabled' || value === 'pending') return value
  throw new Error('Channel identity status is invalid.')
}

function readDeliveryStatus(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'pending' || value === 'claimed' || value === 'sent' || value === 'failed' || value === 'dead') return value
  throw new Error('Channel delivery status is invalid.')
}

function normalizeAgentInput(value: Record<string, unknown>): ChannelAgentInput {
  return {
    agentId: readString(value.agentId, 'Channel agent id') || undefined,
    name: requireString(value.name, 'Channel agent name'),
    profileName: readString(value.profileName, 'Channel agent profile'),
    status: readAgentStatus(value.status),
    managed: value.managed === undefined ? undefined : value.managed === true,
  }
}

function normalizeAgentUpdateInput(value: Record<string, unknown>): DesktopChannelAgentUpdateInput {
  return {
    name: value.name === undefined ? undefined : requireString(value.name, 'Channel agent name'),
    profileName: value.profileName === undefined ? undefined : requireString(value.profileName, 'Channel agent profile'),
    status: readAgentStatus(value.status),
    managed: value.managed === undefined ? undefined : value.managed === true,
  }
}

function normalizeAgentListOptions(value: Record<string, unknown> = {}): ChannelAgentListOptions {
  return {
    ...(readWorkspaceIdOption(value) ? { workspaceId: readWorkspaceIdOption(value) as string } : {}),
    limit: readLimit(value.limit, 100),
  }
}

function normalizeBindingListOptions(value: Record<string, unknown> = {}): ChannelBindingListOptions {
  return {
    ...(readWorkspaceIdOption(value) ? { workspaceId: readWorkspaceIdOption(value) as string } : {}),
    agentId: readString(value.agentId, 'Channel agent id'),
    limit: readLimit(value.limit, 100),
  }
}

function normalizeBindingInput(value: Record<string, unknown>): ChannelBindingConnectInput {
  return {
    bindingId: readString(value.bindingId, 'Channel binding id') || undefined,
    agentId: requireString(value.agentId, 'Channel agent id'),
    provider: requireProvider(value.provider),
    displayName: requireString(value.displayName, 'Channel binding name'),
    externalWorkspaceId: readString(value.externalWorkspaceId, 'External workspace id'),
    status: readBindingStatus(value.status),
    credentialRef: readString(value.credentialRef, 'Credential ref'),
    settings: readRecord(value.settings, 'Channel binding settings') || {},
  }
}

function normalizeBindingUpdateInput(value: Record<string, unknown>): ChannelBindingUpdateInput {
  return {
    displayName: value.displayName === undefined ? undefined : requireString(value.displayName, 'Channel binding name'),
    status: readBindingStatus(value.status),
    credentialRef: value.credentialRef === undefined ? undefined : readString(value.credentialRef, 'Credential ref'),
    settings: value.settings === undefined ? undefined : readRecord(value.settings, 'Channel binding settings') || {},
  }
}

function normalizePeopleListOptions(value: Record<string, unknown> = {}): ChannelPeopleListOptions {
  return {
    ...(readWorkspaceIdOption(value) ? { workspaceId: readWorkspaceIdOption(value) as string } : {}),
    provider: readProvider(value.provider),
    externalWorkspaceId: value.externalWorkspaceId === undefined ? undefined : readString(value.externalWorkspaceId, 'External workspace id'),
    role: readIdentityRole(value.role),
    status: readIdentityStatus(value.status),
    limit: readLimit(value.limit, 100),
  }
}

function normalizePersonResolveInput(value: Record<string, unknown>): ChannelPersonResolveInput {
  return {
    identityId: readString(value.identityId, 'Channel identity id') || undefined,
    provider: requireProvider(value.provider),
    channelBindingId: readString(value.channelBindingId, 'Channel binding id'),
    externalWorkspaceId: value.externalWorkspaceId === undefined ? undefined : readString(value.externalWorkspaceId, 'External workspace id'),
    externalUserId: requireString(value.externalUserId, 'External user id'),
    accountId: readString(value.accountId, 'Account id'),
    role: readIdentityRole(value.role),
    status: readIdentityStatus(value.status),
    metadata: readRecord(value.metadata, 'Channel identity metadata') || {},
  }
}

function normalizeDeliveryListOptions(value: Record<string, unknown> = {}): ChannelDeliveryListOptions {
  return {
    ...(readWorkspaceIdOption(value) ? { workspaceId: readWorkspaceIdOption(value) as string } : {}),
    deliveryId: readString(value.deliveryId, 'Channel delivery id'),
    status: readDeliveryStatus(value.status),
    channelBindingId: readString(value.channelBindingId, 'Channel binding id'),
    limit: readLimit(value.limit, 50),
  }
}

function normalizeDeadLetterInput(value: Record<string, unknown> = {}): ChannelDeliveryDeadLetterInput {
  return {
    lastError: readString(value.lastError, 'Delivery error'),
  }
}

function normalizeWorkspaceOptions(value: Record<string, unknown> = {}): WorkspaceOptions {
  const workspaceId = readWorkspaceIdOption(value)
  return workspaceId ? { workspaceId } : {}
}

function normalizeWatchListOptions(value: Record<string, unknown> = {}): ChannelWatchListOptions {
  const workspaceId = readWorkspaceIdOption(value)
  const targetKind = readString(value.targetKind, 'Watch target kind')
  const targetId = readString(value.targetId, 'Watch target id')
  if ((targetKind && !targetId) || (!targetKind && targetId)) {
    throw new Error('Watch target kind and target id must be provided together.')
  }
  if (targetKind && !isCoordinationWatchTarget(targetKind)) {
    throw new Error('Watch target kind is invalid.')
  }
  const status = readString(value.status, 'Watch status')
  if (status && !isCoordinationWatchStatus(status)) {
    throw new Error('Watch status is invalid.')
  }
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(targetKind ? { targetKind, targetId } : {}),
    ...(status ? { status } : {}),
    limit: readLimit(value.limit, 500),
  }
}

function watchTargetFromOptions(options: ChannelWatchListOptions): CoordinationTarget | null {
  if (!options.targetKind || !options.targetId) return null
  return { kind: options.targetKind, id: options.targetId } as CoordinationTarget
}

function assertLocalWorkspace(context: IpcHandlerContext, event: IpcMainInvokeEvent, options?: unknown) {
  context.workspaceGateway.assertLocalWorkspace(event, readWorkspaceIdOption(options))
}

function isLocalWatch(watchId: string) {
  return getCoordinationWatchDetail(watchId)?.workspaceId === 'local'
}

export function registerChannelHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'channels:providers', optionalObjectArg<WorkspaceOptions>('channel provider options', normalizeWorkspaceOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    const bindings = await getDesktopChannelService().domains.channels.listChannelBindings(localPrincipal(), null, { limit: 500 })
    return buildChannelProviderStatuses(bindings)
  })

  registerIpcInvoke(context, 'channels:agents:list', optionalObjectArg<ChannelAgentListOptions>('channel agent options', normalizeAgentListOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return getDesktopChannelService().domains.channels.listHeadlessAgents(localPrincipal(), { limit: options?.limit })
  })

  registerIpcInvoke(context, 'channels:agents:create', objectArg<ChannelAgentInput>('channel agent', normalizeAgentInput), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    const agent = await getDesktopChannelService().domains.channels.createHeadlessAgent(localPrincipal(), input)
    persistDesktopChannelSnapshot()
    return agent
  })

  registerIpcInvoke(context, 'channels:agents:update', stringAndObjectArgs<DesktopChannelAgentUpdateInput>('channel agent id', 'channel agent update', {}, normalizeAgentUpdateInput), async (event, agentId, input) => {
    assertLocalWorkspace(context, event)
    const agent = await getDesktopChannelService().domains.channels.updateHeadlessAgent(localPrincipal(), agentId, input)
    persistDesktopChannelSnapshot()
    return agent
  })

  registerIpcInvoke(context, 'channels:bindings:list', optionalObjectArg<ChannelBindingListOptions>('channel binding options', normalizeBindingListOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return getDesktopChannelService().domains.channels.listChannelBindings(localPrincipal(), options?.agentId, { limit: options?.limit })
  })

  registerIpcInvoke(context, 'channels:bindings:connect', objectArg<ChannelBindingConnectInput>('channel binding', normalizeBindingInput), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    const binding = await getDesktopChannelService().domains.channels.createChannelBinding(localPrincipal(), input)
    persistDesktopChannelSnapshot()
    return binding
  })

  registerIpcInvoke(context, 'channels:bindings:update', stringAndObjectArgs<ChannelBindingUpdateInput>('channel binding id', 'channel binding update', {}, normalizeBindingUpdateInput), async (event, bindingId, input) => {
    assertLocalWorkspace(context, event)
    const binding = await getDesktopChannelService().domains.channels.updateChannelBinding(localPrincipal(), bindingId, input)
    persistDesktopChannelSnapshot()
    return binding
  })

  registerIpcInvoke(context, 'channels:bindings:disconnect', stringAndOptionalObjectArgs<WorkspaceOptions>('channel binding id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, bindingId, options) => {
    assertLocalWorkspace(context, event, options)
    const binding = await getDesktopChannelService().domains.channels.updateChannelBinding(localPrincipal(), bindingId, { status: 'disabled' })
    persistDesktopChannelSnapshot()
    return binding
  })

  registerIpcInvoke(context, 'channels:people:list', optionalObjectArg<ChannelPeopleListOptions>('channel people options', normalizePeopleListOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return getDesktopChannelService().domains.channels.listChannelIdentities(localPrincipal(), options)
  })

  registerIpcInvoke(context, 'channels:people:resolve', objectArg<ChannelPersonResolveInput>('channel person', normalizePersonResolveInput), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    const identity = await getDesktopChannelService().domains.channels.resolveChannelIdentity(localPrincipal(), input)
    persistDesktopChannelSnapshot()
    return publicChannelIdentity(identity)
  })

  registerIpcInvoke(context, 'channels:deliveries:list', optionalObjectArg<ChannelDeliveryListOptions>('channel delivery options', normalizeDeliveryListOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return getDesktopChannelService().domains.channels.listChannelDeliveries(localPrincipal(), options)
  })

  registerIpcInvoke(context, 'channels:deliveries:retry', stringArg('channel delivery id'), async (event, deliveryId) => {
    assertLocalWorkspace(context, event)
    const delivery = await getDesktopChannelService().domains.channels.retryChannelDelivery(localPrincipal(), deliveryId)
    persistDesktopChannelSnapshot()
    return delivery
  })

  registerIpcInvoke(context, 'channels:deliveries:dead-letter', stringAndOptionalObjectArgs<ChannelDeliveryDeadLetterInput>('channel delivery id', 'channel delivery dead-letter input', {}, normalizeDeadLetterInput), async (event, deliveryId, input) => {
    assertLocalWorkspace(context, event, input)
    const delivery = await getDesktopChannelService().domains.channels.deadLetterChannelDelivery(localPrincipal(), { deliveryId, lastError: input?.lastError })
    persistDesktopChannelSnapshot()
    return delivery
  })

  registerIpcInvoke(context, 'channels:watches:list', optionalObjectArg<ChannelWatchListOptions>('channel watch options', normalizeWatchListOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return listCoordinationWatches({
      workspaceId: 'local',
      target: options ? watchTargetFromOptions(options) : null,
      status: options?.status as CoordinationWatchStatus | undefined,
      limit: options?.limit ?? undefined,
    })
  })

  registerIpcInvoke(context, 'channels:watches:create', objectArg<CoordinationWatchInput>('channel watch'), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    return createCoordinationWatch(input)
  })

  registerIpcInvoke(context, 'channels:watches:update', stringAndObjectArgs<CoordinationWatchUpdateInput>('channel watch id', 'channel watch update'), async (event, watchId, input) => {
    assertLocalWorkspace(context, event)
    if (!isLocalWatch(watchId)) return null
    return updateCoordinationWatch(watchId, input)
  })

  registerIpcInvoke(context, 'channels:watches:pause', stringAndOptionalObjectArgs<WorkspaceOptions>('channel watch id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, watchId, options) => {
    assertLocalWorkspace(context, event, options)
    if (!isLocalWatch(watchId)) return null
    return pauseCoordinationWatch(watchId)
  })

  registerIpcInvoke(context, 'channels:watches:resume', stringAndOptionalObjectArgs<WorkspaceOptions>('channel watch id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, watchId, options) => {
    assertLocalWorkspace(context, event, options)
    if (!isLocalWatch(watchId)) return null
    return resumeCoordinationWatch(watchId)
  })

  registerIpcInvoke(context, 'channels:watches:delete', stringAndOptionalObjectArgs<WorkspaceOptions>('channel watch id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, watchId, options) => {
    assertLocalWorkspace(context, event, options)
    if (!isLocalWatch(watchId)) return false
    return deleteCoordinationWatch(watchId)
  })
}
