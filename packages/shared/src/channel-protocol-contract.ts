/**
 * JOE-994 Phase 1: dual-stack channel **protocol** contract vocabulary.
 *
 * Shared, non-security types/keys so Durable Gateway capability matrices and
 * monorepo `gateway-channel` provider capabilities can be compared without
 * migrating adapters. Security kernels stay in `@open-cowork/shared/node`.
 *
 * Freeze remains: protocol implementations are still two stacks until later
 * JOE-994 phases compose Durable onto gateway-provider-*.
 */

/** Production providers that exist on both Durable and monorepo stacks. */
export const DUAL_STACK_OVERLAP_PROVIDERS = ['telegram', 'whatsapp', 'discord'] as const
export type DualStackOverlapProvider = (typeof DUAL_STACK_OVERLAP_PROVIDERS)[number]

/**
 * Durable adapter capability categories (product surface matrix).
 * Source of truth for completeCategory matrices on Durable channels.
 */
export const CHANNEL_ADAPTER_CAPABILITY_KEYS = [
  'richText',
  'richCards',
  'inlineActions',
  'callbacks',
  'filesMedia',
  'threading',
  'identityBinding',
  'deepLinks',
  'notifications',
  'edits',
  'deletes',
  'fallbackBehavior',
] as const

export type ChannelAdapterCapabilityKey = (typeof CHANNEL_ADAPTER_CAPABILITY_KEYS)[number]

export const CHANNEL_CAPABILITY_STATUS_VALUES = ['supported', 'partial', 'planned', 'unsupported'] as const
export type ChannelCapabilityStatusValue = (typeof CHANNEL_CAPABILITY_STATUS_VALUES)[number]

/**
 * Monorepo `@open-cowork/gateway-channel` ChannelCapabilities boolean / numeric
 * fields that every production provider must declare (after normalize).
 */
export const MONOREPO_CAPABILITY_REQUIRED_KEYS = [
  'threads',
  'messageEditing',
  'inlineButtons',
  'fileUploads',
  'fileDownloads',
  'typingIndicator',
  'maxTextLength',
  'preferredParseMode',
] as const

export type MonorepoCapabilityRequiredKey = (typeof MONOREPO_CAPABILITY_REQUIRED_KEYS)[number]

export type MonorepoCapabilitySnapshot = {
  threads?: boolean
  messageEditing?: boolean
  inlineButtons?: boolean
  fileUploads?: boolean
  fileDownloads?: boolean
  typingIndicator?: boolean
  maxTextLength?: number
  preferredParseMode?: string
  parseModes?: string[]
  editSemantics?: string
  [key: string]: unknown
}

export type AdapterCategoryStatusMap = Record<ChannelAdapterCapabilityKey, ChannelCapabilityStatusValue>

function boolStatus(value: boolean | undefined, whenTrue: ChannelCapabilityStatusValue = 'supported'): ChannelCapabilityStatusValue {
  return value ? whenTrue : 'unsupported'
}

/**
 * Map monorepo boolean-style capabilities onto Durable adapter category statuses.
 * This is a comparison aid only — not a runtime behavior change.
 */
export function mapMonorepoCapabilitiesToAdapterCategories(
  caps: MonorepoCapabilitySnapshot,
): AdapterCategoryStatusMap {
  const files = Boolean(caps.fileUploads || caps.fileDownloads)
  const edits = Boolean(caps.messageEditing) && caps.editSemantics !== 'none'
  return {
    richText: boolStatus(caps.preferredParseMode === 'markdown' || caps.preferredParseMode === 'html' || (Array.isArray(caps.parseModes) && caps.parseModes.some((m) => m === 'markdown' || m === 'html'))),
    richCards: 'unsupported',
    inlineActions: boolStatus(caps.inlineButtons, 'partial'),
    callbacks: boolStatus(caps.inlineButtons, 'partial'),
    filesMedia: boolStatus(files),
    threading: boolStatus(caps.threads),
    identityBinding: 'partial',
    deepLinks: 'unsupported',
    notifications: 'supported',
    edits: boolStatus(edits),
    deletes: 'unsupported',
    fallbackBehavior: 'supported',
  }
}

/** Durable-style matrix: each key → { status }. */
export function isCompleteAdapterCategoryMatrix(
  matrix: Partial<Record<string, { status?: string }>> | null | undefined,
): matrix is Record<ChannelAdapterCapabilityKey, { status: ChannelCapabilityStatusValue }> {
  if (!matrix || typeof matrix !== 'object') return false
  for (const key of CHANNEL_ADAPTER_CAPABILITY_KEYS) {
    const entry = matrix[key]
    if (!entry || typeof entry !== 'object') return false
    if (!CHANNEL_CAPABILITY_STATUS_VALUES.includes(entry.status as ChannelCapabilityStatusValue)) return false
  }
  return true
}

/** Mapped monorepo snapshot: each key → status string. */
export function isCompleteAdapterCategoryStatusMap(
  map: Partial<Record<string, string>> | null | undefined,
): map is AdapterCategoryStatusMap {
  if (!map || typeof map !== 'object') return false
  for (const key of CHANNEL_ADAPTER_CAPABILITY_KEYS) {
    if (!CHANNEL_CAPABILITY_STATUS_VALUES.includes(map[key] as ChannelCapabilityStatusValue)) return false
  }
  return true
}

export function monorepoCapabilitiesMissingKeys(caps: MonorepoCapabilitySnapshot | null | undefined): string[] {
  if (!caps || typeof caps !== 'object') return [...MONOREPO_CAPABILITY_REQUIRED_KEYS]
  const missing: string[] = []
  for (const key of MONOREPO_CAPABILITY_REQUIRED_KEYS) {
    if (caps[key] === undefined || caps[key] === null) missing.push(key)
  }
  if (typeof caps.maxTextLength === 'number' && !(caps.maxTextLength > 0)) {
    missing.push('maxTextLength(positive)')
  }
  return missing
}

export function isDualStackOverlapProvider(value: string): value is DualStackOverlapProvider {
  return (DUAL_STACK_OVERLAP_PROVIDERS as readonly string[]).includes(value)
}
