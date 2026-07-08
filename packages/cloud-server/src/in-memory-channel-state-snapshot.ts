import type {
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  HeadlessAgentRecord,
} from './control-plane-store.ts'
import type {
  CreateAccountInput,
} from './control-plane-account-inputs.ts'
import type {
  CreateChannelBindingInput,
  CreateChannelDeliveryInput,
  ListChannelDeliveriesInput,
  ListChannelIdentitiesInput,
  UpdateChannelBindingInput,
  UpsertChannelIdentityInput,
} from './control-plane-channel-inputs.ts'
import type {
  CreateHeadlessAgentInput,
  UpdateHeadlessAgentInput,
} from './control-plane-workflow-inputs.ts'

export type InMemoryChannelStateSnapshot = {
  version: 1
  savedAt: string
  orgId: string
  headlessAgents: HeadlessAgentRecord[]
  channelBindings: ChannelBindingRecord[]
  channelIdentities: ChannelIdentityRecord[]
  channelDeliveries: ChannelDeliveryRecord[]
}

type ChannelStateStore = {
  listHeadlessAgents(orgId: string): HeadlessAgentRecord[]
  listChannelBindings(orgId: string, agentId?: string | null): ChannelBindingRecord[]
  listChannelIdentities(orgId: string, input: ListChannelIdentitiesInput): ChannelIdentityRecord[]
  listChannelDeliveries(input: ListChannelDeliveriesInput): ChannelDeliveryRecord[]
  createTenant(input: { tenantId: string, name: string, orgId?: string, createdAt?: Date }): unknown
  accountExists(accountId: string): boolean
  createAccount(input: CreateAccountInput): unknown
  getHeadlessAgent(orgId: string, agentId: string): HeadlessAgentRecord | null
  createHeadlessAgent(input: CreateHeadlessAgentInput): unknown
  updateHeadlessAgent(input: UpdateHeadlessAgentInput): unknown
  getChannelBinding(orgId: string, bindingId: string): ChannelBindingRecord | null
  createChannelBinding(input: CreateChannelBindingInput): unknown
  updateChannelBinding(input: UpdateChannelBindingInput): unknown
  upsertChannelIdentity(input: UpsertChannelIdentityInput): unknown
  createChannelDelivery(input: CreateChannelDeliveryInput): unknown
}

function snapshotDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function snapshotChannelState(store: ChannelStateStore, orgId: string): InMemoryChannelStateSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    orgId,
    headlessAgents: store.listHeadlessAgents(orgId),
    channelBindings: store.listChannelBindings(orgId),
    channelIdentities: store.listChannelIdentities(orgId, { limit: 500 }),
    channelDeliveries: store.listChannelDeliveries({ orgId, limit: 500 }),
  }
}

export function restoreChannelState(store: ChannelStateStore, snapshot: InMemoryChannelStateSnapshot): void {
  store.createTenant({
    tenantId: snapshot.orgId,
    name: snapshot.orgId,
    orgId: snapshot.orgId,
    createdAt: snapshotDate(snapshot.savedAt),
  })
  for (const agent of snapshot.headlessAgents || []) {
    store.createTenant({
      tenantId: agent.tenantId,
      name: agent.tenantId,
      orgId: agent.orgId,
      createdAt: snapshotDate(agent.createdAt),
    })
    if (agent.createdByAccountId && !store.accountExists(agent.createdByAccountId)) {
      store.createAccount({
        accountId: agent.createdByAccountId,
        idpSubject: agent.createdByAccountId,
        email: `${agent.createdByAccountId}@open-cowork.local`,
        createdAt: snapshotDate(agent.createdAt),
      })
    }
    if (!store.getHeadlessAgent(agent.orgId, agent.agentId)) {
      store.createHeadlessAgent({
        agentId: agent.agentId,
        orgId: agent.orgId,
        tenantId: agent.tenantId,
        profileName: agent.profileName,
        name: agent.name,
        status: agent.status,
        managed: agent.managed,
        createdByAccountId: agent.createdByAccountId,
        createdAt: snapshotDate(agent.createdAt),
      })
    }
    store.updateHeadlessAgent({
      orgId: agent.orgId,
      agentId: agent.agentId,
      profileName: agent.profileName,
      name: agent.name,
      status: agent.status,
      managed: agent.managed,
      updatedAt: snapshotDate(agent.updatedAt),
    })
  }

  for (const binding of snapshot.channelBindings || []) {
    if (!store.getHeadlessAgent(binding.orgId, binding.agentId)) continue
    if (!store.getChannelBinding(binding.orgId, binding.bindingId)) {
      store.createChannelBinding({
        bindingId: binding.bindingId,
        orgId: binding.orgId,
        agentId: binding.agentId,
        provider: binding.provider,
        externalWorkspaceId: binding.externalWorkspaceId,
        displayName: binding.displayName,
        status: binding.status,
        credentialRef: binding.credentialRef,
        settings: binding.settings,
        createdAt: snapshotDate(binding.createdAt),
      })
    }
    store.updateChannelBinding({
      orgId: binding.orgId,
      bindingId: binding.bindingId,
      displayName: binding.displayName,
      status: binding.status,
      credentialRef: binding.credentialRef,
      settings: binding.settings,
      updatedAt: snapshotDate(binding.updatedAt),
    })
  }

  for (const identity of snapshot.channelIdentities || []) {
    store.createTenant({ tenantId: snapshot.orgId, name: snapshot.orgId, orgId: identity.orgId })
    store.upsertChannelIdentity({
      identityId: identity.identityId,
      orgId: identity.orgId,
      provider: identity.provider,
      externalWorkspaceId: identity.externalWorkspaceId,
      externalUserId: identity.externalUserId,
      accountId: identity.accountId,
      role: identity.role,
      status: identity.status,
      metadata: identity.metadata,
      updatedAt: snapshotDate(identity.updatedAt),
    })
  }

  for (const delivery of snapshot.channelDeliveries || []) {
    if (!store.getHeadlessAgent(delivery.orgId, delivery.agentId)) continue
    if (!store.getChannelBinding(delivery.orgId, delivery.channelBindingId)) continue
    if (store.listChannelDeliveries({ orgId: delivery.orgId, deliveryId: delivery.deliveryId, limit: 1 }).length > 0) continue
    store.createChannelDelivery({
      deliveryId: delivery.deliveryId,
      orgId: delivery.orgId,
      agentId: delivery.agentId,
      channelBindingId: delivery.channelBindingId,
      sessionBindingId: delivery.sessionBindingId,
      provider: delivery.provider,
      target: delivery.target,
      eventType: delivery.eventType,
      payload: delivery.payload,
      status: delivery.status,
      nextAttemptAt: snapshotDate(delivery.nextAttemptAt),
      createdAt: snapshotDate(delivery.createdAt),
    })
  }
}
