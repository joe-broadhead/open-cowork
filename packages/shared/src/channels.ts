import type {
  CoordinationWatch,
  CoordinationWatchInput,
  CoordinationWatchUpdateInput,
} from './coordination.js'
import type { WorkspaceOptions } from './workspace.js'

export const CHANNEL_PROVIDER_KINDS = [
  'telegram',
  'slack',
  'email',
  'discord',
  'whatsapp',
  'signal',
  'webhook',
  'cli',
] as const

export type ChannelProviderKind = typeof CHANNEL_PROVIDER_KINDS[number]
export type ChannelProviderId = ChannelProviderKind | `${ChannelProviderKind}-${string}` | `${string}-${string}`
export type ChannelIdentityRole = 'owner' | 'admin' | 'member' | 'approver' | 'viewer'
export type ChannelIdentityStatus = 'active' | 'disabled' | 'pending'
export type ChannelBindingStatus = 'active' | 'disabled' | 'auth_required' | 'error'
export type ChannelDeliveryStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'dead'

export type ChannelProviderStatus = {
  id: ChannelProviderKind
  provider: ChannelProviderKind
  label: string
  available: boolean
  connected: boolean
  bindingCount: number
  activeBindingCount: number
  status: 'connected' | 'available'
}

export type ChannelAgentRecord = {
  agentId: string
  orgId: string
  tenantId: string
  profileName: string
  name: string
  status: 'active' | 'disabled'
  managed: boolean
  createdByAccountId: string | null
  createdAt: string
  updatedAt: string
}

export type ChannelBindingPublicRecord = {
  bindingId: string
  orgId: string
  agentId: string
  provider: ChannelProviderId
  externalWorkspaceId: string | null
  displayName: string
  status: ChannelBindingStatus
  credentialRefConfigured: boolean
  credentialRefKind: 'env' | 'gcp-secret-manager' | 'aws-secrets-manager' | 'azure-key-vault' | 'secret-ref' | null
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ChannelIdentityPublicRecord = {
  identityId: string
  orgId: string
  provider: ChannelProviderId
  externalWorkspaceId: string | null
  externalUserId: string
  accountId: string | null
  role: ChannelIdentityRole
  status: ChannelIdentityStatus
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ChannelDeliveryPublicRecord = {
  deliveryId: string
  orgId: string
  agentId: string
  channelBindingId: string
  sessionBindingId: string | null
  provider: ChannelProviderId
  target: Record<string, unknown>
  eventType: string
  payload: Record<string, unknown>
  status: ChannelDeliveryStatus
  attemptCount: number
  claimedBy: string | null
  lastClaimedBy: string | null
  claimExpiresAt: string | null
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type ChannelProviderListOptions = WorkspaceOptions

export type ChannelAgentListOptions = WorkspaceOptions & {
  limit?: number | null
}

export type ChannelAgentInput = {
  name: string
  profileName?: string | null
  status?: ChannelAgentRecord['status']
  managed?: boolean
  agentId?: string | null
}

export type ChannelAgentUpdateInput = Partial<Omit<ChannelAgentInput, 'agentId'>>

export type ChannelBindingListOptions = WorkspaceOptions & {
  agentId?: string | null
  limit?: number | null
}

export type ChannelBindingConnectInput = {
  agentId: string
  provider: ChannelProviderId
  displayName: string
  externalWorkspaceId?: string | null
  status?: ChannelBindingStatus
  credentialRef?: string | null
  settings?: Record<string, unknown>
  bindingId?: string | null
}

export type ChannelBindingUpdateInput = {
  displayName?: string
  status?: ChannelBindingStatus
  credentialRef?: string | null
  settings?: Record<string, unknown>
}

export type ChannelPeopleListOptions = WorkspaceOptions & {
  provider?: ChannelProviderId | null
  externalWorkspaceId?: string | null
  role?: ChannelIdentityRole | null
  status?: ChannelIdentityStatus | null
  limit?: number | null
}

export type ChannelPersonResolveInput = {
  provider: ChannelProviderId
  externalUserId: string
  channelBindingId?: string | null
  externalWorkspaceId?: string | null
  identityId?: string | null
  accountId?: string | null
  role?: ChannelIdentityRole
  status?: ChannelIdentityStatus
  metadata?: Record<string, unknown>
}

export type ChannelDeliveryListOptions = WorkspaceOptions & {
  deliveryId?: string | null
  status?: ChannelDeliveryStatus | null
  channelBindingId?: string | null
  limit?: number | null
}

export type ChannelDeliveryDeadLetterInput = {
  lastError?: string | null
}

export type ChannelWatchListOptions = WorkspaceOptions & {
  targetKind?: string | null
  targetId?: string | null
  status?: string | null
  limit?: number | null
}

export type ChannelApiSurface = {
  providers: (options?: ChannelProviderListOptions) => Promise<ChannelProviderStatus[]>
  agents: (options?: ChannelAgentListOptions) => Promise<ChannelAgentRecord[]>
  createAgent: (input: ChannelAgentInput) => Promise<ChannelAgentRecord>
  updateAgent: (agentId: string, input: ChannelAgentUpdateInput) => Promise<ChannelAgentRecord | null>
  bindings: (options?: ChannelBindingListOptions) => Promise<ChannelBindingPublicRecord[]>
  connectBinding: (input: ChannelBindingConnectInput) => Promise<ChannelBindingPublicRecord>
  updateBinding: (bindingId: string, input: ChannelBindingUpdateInput) => Promise<ChannelBindingPublicRecord | null>
  disconnectBinding: (bindingId: string, options?: WorkspaceOptions) => Promise<ChannelBindingPublicRecord | null>
  people: (options?: ChannelPeopleListOptions) => Promise<ChannelIdentityPublicRecord[]>
  resolvePerson: (input: ChannelPersonResolveInput) => Promise<ChannelIdentityPublicRecord>
  deliveries: (options?: ChannelDeliveryListOptions) => Promise<ChannelDeliveryPublicRecord[]>
  retryDelivery: (deliveryId: string) => Promise<ChannelDeliveryPublicRecord | null>
  deadLetterDelivery: (deliveryId: string, input?: ChannelDeliveryDeadLetterInput) => Promise<ChannelDeliveryPublicRecord | null>
  watches: (options?: ChannelWatchListOptions) => Promise<CoordinationWatch[]>
  createWatch: (input: CoordinationWatchInput) => Promise<CoordinationWatch>
  updateWatch: (watchId: string, input: CoordinationWatchUpdateInput) => Promise<CoordinationWatch | null>
  pauseWatch: (watchId: string, options?: WorkspaceOptions) => Promise<CoordinationWatch | null>
  resumeWatch: (watchId: string, options?: WorkspaceOptions) => Promise<CoordinationWatch | null>
  deleteWatch: (watchId: string, options?: WorkspaceOptions) => Promise<boolean>
}

const CHANNEL_PROVIDER_LABELS: Record<ChannelProviderKind, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  email: 'Email',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  webhook: 'Webhook',
  cli: 'CLI',
}

export function isChannelProviderKind(value: unknown): value is ChannelProviderKind {
  return typeof value === 'string' && CHANNEL_PROVIDER_KINDS.includes(value as ChannelProviderKind)
}

export function channelProviderKindFromId(value: string): ChannelProviderKind | null {
  const direct = CHANNEL_PROVIDER_KINDS.find((kind) => value === kind)
  if (direct) return direct
  return CHANNEL_PROVIDER_KINDS.find((kind) => value.startsWith(`${kind}-`)) || null
}

export function channelProviderLabel(provider: ChannelProviderKind) {
  return CHANNEL_PROVIDER_LABELS[provider]
}

export function buildChannelProviderStatuses(
  bindings: ReadonlyArray<Pick<ChannelBindingPublicRecord, 'provider' | 'status'>>,
): ChannelProviderStatus[] {
  return CHANNEL_PROVIDER_KINDS.map((provider) => {
    const providerBindings = bindings.filter((binding) => channelProviderKindFromId(binding.provider) === provider)
    const activeBindingCount = providerBindings.filter((binding) => binding.status === 'active').length
    const connected = activeBindingCount > 0
    return {
      id: provider,
      provider,
      label: channelProviderLabel(provider),
      available: true,
      connected,
      bindingCount: providerBindings.length,
      activeBindingCount,
      status: connected ? 'connected' : 'available',
    }
  })
}
