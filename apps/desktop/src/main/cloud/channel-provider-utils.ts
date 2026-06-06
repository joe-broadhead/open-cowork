import type { ChannelProviderId } from './channel-provider-types.ts'

export function normalizeChannelProviderId(value: unknown): ChannelProviderId {
  const provider = normalizeText(value, 64, 'Channel provider') as ChannelProviderId
  if (isChannelProviderId(provider)) return provider
  throw new Error(`Unsupported channel provider ${provider}.`)
}

export function channelScopeKey(provider: ChannelProviderId, externalWorkspaceId: string | null, externalId: string) {
  return key(provider, externalWorkspaceId || '', externalId)
}

export function channelThreadKey(provider: ChannelProviderId, externalWorkspaceId: string | null, externalChatId: string, externalThreadId: string) {
  return key(provider, externalWorkspaceId || '', externalChatId, externalThreadId)
}

function isChannelProviderId(value: string): value is ChannelProviderId {
  return ['telegram', 'slack', 'email', 'discord', 'whatsapp', 'signal', 'webhook', 'cli'].includes(value)
    || (/^[a-z][a-z0-9_-]{1,63}$/.test(value) && value.includes('-'))
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters.`)
  }
  return normalized
}

function key(...parts: string[]) {
  return parts.join('\0')
}
