import { clone, normalizeNullableText, normalizeText, nowIso, stableJson } from './store-helpers.ts'
import { normalizeChannelProviderId as normalizeProvider } from '../channel-provider-utils.ts'
import { quotaExceeded } from '../control-plane-errors.ts'
import type {
  AuditEventRecord,
  ChannelBindingRecord,
  CreateChannelBindingInput,
  HeadlessAgentRecord,
  RecordAuditEventInput,
  UpdateChannelBindingInput,
} from '../control-plane-store.ts'

// Channel-binding domain extracted from in-memory-control-plane-store.ts. Owns the
// channel-binding records (an agent's connection to a provider channel) and the
// create / update / get / list lifecycle. Headless-agent existence + audit recording
// arrive via the injected host; the binding/session/interaction methods that read a
// binding go through the store's getChannelBinding delegate. Behaviour-preserving;
// covered by the cloud-http-server channel suites.

const CHANNEL_TEXT_MAX_LENGTH = 256
const CHANNEL_METADATA_MAX_BYTES = 16_384

type InMemoryChannelBindingsHost = {
  getHeadlessAgent(orgId: string, agentId: string): HeadlessAgentRecord | null
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

export class InMemoryChannelBindingsDomain {
  private readonly channelBindings = new Map<string, ChannelBindingRecord>()
  private readonly host: InMemoryChannelBindingsHost

  constructor(host: InMemoryChannelBindingsHost) {
    this.host = host
  }

  createChannelBinding(input: CreateChannelBindingInput): ChannelBindingRecord {
    const agent = this.host.getHeadlessAgent(input.orgId, input.agentId)
    if (!agent) throw new Error(`Unknown headless agent ${input.agentId}.`)
    const existing = this.channelBindings.get(input.bindingId)
    if (existing) return clone(existing)
    const bindingLimit = input.quota?.maxGatewayChannelBindingsPerOrg
    if (bindingLimit && bindingLimit > 0) {
      const activeBindings = Array.from(this.channelBindings.values())
        .filter((binding) => binding.orgId === input.orgId && binding.status !== 'disabled')
        .length
      if (activeBindings >= bindingLimit) {
        quotaExceeded({
          message: 'Gateway channel binding quota exceeded.',
          policyCode: input.quota?.policyCode || 'quota.gateway_channel_bindings_exceeded',
          retryAfterMs: 60_000,
          limit: bindingLimit,
          used: activeBindings,
          resetAt: new Date(Date.now() + 60_000).toISOString(),
        })
      }
    }
    const now = nowIso(input.createdAt)
    const record: ChannelBindingRecord = {
      bindingId: normalizeText(input.bindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding id'),
      orgId: input.orgId,
      agentId: input.agentId,
      provider: normalizeProvider(input.provider),
      externalWorkspaceId: normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id'),
      displayName: normalizeText(input.displayName, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding name'),
      status: input.status || 'active',
      credentialRef: normalizeNullableText(input.credentialRef, CHANNEL_TEXT_MAX_LENGTH, 'Credential ref'),
      settings: normalizeRecord(input.settings, 'Channel binding settings'),
      createdAt: now,
      updatedAt: now,
    }
    this.channelBindings.set(record.bindingId, record)
    this.host.recordAuditEvent({
      orgId: record.orgId,
      actorType: 'system',
      actorId: 'channel_binding.create',
      eventType: 'channel_binding.created',
      targetType: 'channel_binding',
      targetId: record.bindingId,
      metadata: { provider: record.provider, displayName: record.displayName, credentialRefConfigured: Boolean(record.credentialRef) },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  updateChannelBinding(input: UpdateChannelBindingInput): ChannelBindingRecord | null {
    const existing = this.channelBindings.get(input.bindingId)
    if (!existing || existing.orgId !== input.orgId) return null
    existing.displayName = input.displayName === undefined ? existing.displayName : normalizeText(input.displayName, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding name')
    existing.status = input.status || existing.status
    existing.credentialRef = input.credentialRef === undefined ? existing.credentialRef : normalizeNullableText(input.credentialRef, CHANNEL_TEXT_MAX_LENGTH, 'Credential ref')
    existing.settings = input.settings === undefined ? existing.settings : normalizeRecord(input.settings, 'Channel binding settings')
    existing.updatedAt = nowIso(input.updatedAt)
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'channel_binding.updated',
      targetType: 'channel_binding',
      targetId: existing.bindingId,
      metadata: {
        provider: existing.provider,
        displayName: existing.displayName,
        status: existing.status,
        credentialRefConfigured: Boolean(existing.credentialRef),
        settingsChanged: input.settings !== undefined,
      },
      createdAt: input.updatedAt,
    })
    return clone(existing)
  }

  getChannelBinding(orgId: string, bindingId: string): ChannelBindingRecord | null {
    const binding = this.channelBindings.get(bindingId)
    return binding && binding.orgId === orgId ? clone(binding) : null
  }

  listChannelBindings(orgId: string, agentId?: string | null): ChannelBindingRecord[] {
    return Array.from(this.channelBindings.values())
      .filter((binding) => binding.orgId === orgId && (!agentId || binding.agentId === agentId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.bindingId.localeCompare(right.bindingId))
      .map((binding) => clone(binding))
  }
}

function normalizeRecord(value: unknown, label: string, maxBytes = CHANNEL_METADATA_MAX_BYTES): Record<string, unknown> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? clone(value as Record<string, unknown>)
    : {}
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
}
