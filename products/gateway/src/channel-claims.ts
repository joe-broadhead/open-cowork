import { createHash, randomBytes } from 'node:crypto'
import { getConfig, updateConfig, type ChannelAllowlistRule, type GatewayConfig } from './config.js'
import {
  appendAuditEvent,
  appendWorkEvent,
  createChannelClaimCodeRecord,
  findChannelClaimCodeByHash,
  listChannelClaimCodes,
  listChannelClaimCodesReadOnly,
  updateChannelClaimCodeStatus,
  withWorkDbLeadershipEpoch,
  workStatePath,
  type ChannelClaimAction,
  type ChannelClaimCodeRecord,
  type WorkDbLeadershipEpoch,
} from './work-store.js'
import { channelTargetFingerprint, redactedChannelTargetLabel } from './security.js'
import type { ChannelMessage } from './channels/provider.js'
import { captureCurrentDaemonLeadershipEpoch, getCurrentDaemonLeadershipStatus } from './daemon-leadership.js'

export type ChannelClaimDenyReason = 'wrong_code' | 'wrong_provider' | 'wrong_action' | 'expired' | 'replay' | 'manual_trust_required'
export type ChannelClaimAcceptStatus = 'no_claim' | 'accepted' | 'denied'

export interface ChannelClaimCreateOptions {
  provider: string
  action?: ChannelClaimAction
  ttlMs?: number
  createdBy?: string
  now?: Date
}

export interface ChannelClaimCreateResult {
  claim: ChannelClaimCodeRecord
  code: string
  normalizedCode: string
  instructions: string
}

export interface ChannelClaimAcceptResult {
  status: ChannelClaimAcceptStatus
  reason?: ChannelClaimDenyReason
  claim?: ChannelClaimCodeRecord
  target?: string
}

const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CLAIM_CODE_LENGTH = 10
const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000
const MAX_CLAIM_TTL_MS = 30 * 60 * 1000
const CLAIM_CODE_PATTERN = /\b(?:GW[-\s]?)?([A-HJ-NP-Z2-9]{4})[-\s]?([A-HJ-NP-Z2-9]{4})[-\s]?([A-HJ-NP-Z2-9]{2})\b/i
const CLAIM_ALLOWLIST_KEYS = ['telegram', 'whatsapp', 'discord'] as const
type ClaimAllowlistProvider = typeof CLAIM_ALLOWLIST_KEYS[number]

export function createChannelClaimCode(options: ChannelClaimCreateOptions): ChannelClaimCreateResult {
  const provider = normalizeProvider(options.provider)
  const action = options.action || 'trust_target'
  if (action !== 'trust_target' && action !== 'prove_denial') throw new Error('claim action is not supported')
  assertProviderClaimSupported(provider)

  const filePath = workStatePath()
  const now = options.now || new Date()
  const ttlMs = Math.max(60_000, Math.min(MAX_CLAIM_TTL_MS, Math.floor(options.ttlMs || DEFAULT_CLAIM_TTL_MS)))
  const expiresAt = new Date(now.getTime() + ttlMs)
  const normalizedCode = generateClaimCode()
  const code = formatClaimCode(normalizedCode)
  const claim = createChannelClaimCodeRecord({
    id: `claim_${randomBytes(12).toString('hex')}`,
    provider,
    action,
    codeHash: claimCodeHash(normalizedCode),
    codeFingerprint: claimCodeFingerprint(normalizedCode),
    createdBy: options.createdBy || 'operator',
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }, filePath)

  recordClaimEvent('channel.claim.created', claim, 'ok', {
    expiresAt: claim.expiresAt,
    ttlMs,
  }, filePath)

  return {
    claim,
    code,
    normalizedCode,
    instructions: action === 'prove_denial'
      ? `Send ${code} from the ${provider} channel target you want to use for a denial proof before ${claim.expiresAt}. Gateway will reject this one message, record a redacted provider-native denied inbound audit, and will not change trusted targets.`
      : `Send ${code} from the ${provider} channel target you want to trust before ${claim.expiresAt}.`,
  }
}

export function acceptChannelDenialProbeFromMessage(msg: ChannelMessage, options: { now?: Date } = {}): ChannelClaimAcceptResult {
  const extracted = extractClaimCode(msg.text)
  if (!extracted) return { status: 'no_claim' }
  const filePath = workStatePath()
  const provider = normalizeProvider(msg.provider)
  const now = options.now || new Date()
  const target = redactedChannelTargetLabel(provider, msg.chatId, msg.threadId)
  const targetHash = channelTargetFingerprint(provider, msg.chatId, msg.threadId)
  const codeHash = claimCodeHash(extracted.normalized)
  const codeFingerprint = claimCodeFingerprint(extracted.normalized)
  const claim = findChannelClaimCodeByHash(codeHash, filePath)

  if (!claim || claim.action !== 'prove_denial') return { status: 'no_claim' }
  if (claim.provider !== provider) {
    recordClaimEvent('channel.claim.denied', claim, 'denied', { reason: 'wrong_provider', attemptedProvider: provider, target, targetHash }, filePath)
    return { status: 'denied', reason: 'wrong_provider', claim, target }
  }
  if (claim.status === 'accepted') {
    recordClaimEvent('channel.claim.replayed', claim, 'denied', { reason: 'replay', target, targetHash }, filePath)
    return { status: 'denied', reason: 'replay', claim, target }
  }
  if (claim.status !== 'pending') {
    recordClaimEvent('channel.claim.denied', claim, 'denied', { reason: claim.status === 'expired' ? 'expired' : 'replay', target, targetHash }, filePath)
    return { status: 'denied', reason: claim.status === 'expired' ? 'expired' : 'replay', claim, target }
  }
  if (Date.parse(claim.expiresAt) <= now.getTime()) {
    const expired = updateChannelClaimCodeStatus(claim.id, { status: 'expired', deniedAt: now.toISOString(), denialReason: 'expired' }, filePath) || claim
    recordClaimEvent('channel.claim.expired', expired, 'denied', { reason: 'expired', target, targetHash }, filePath)
    return { status: 'denied', reason: 'expired', claim: expired, target }
  }

  const accepted = updateChannelClaimCodeStatus(claim.id, {
    status: 'accepted',
    acceptedAt: now.toISOString(),
    acceptedTargetHash: targetHash,
  }, filePath) || claim
  const details = {
    target,
    targetHash,
    reason: 'operator_denial_probe',
    evidence: 'provider-native',
    redacted: true,
  }
  recordClaimEvent('channel.claim.accepted', accepted, 'ok', details, filePath)
  try {
    appendAuditEvent({
      actor: provider,
      source: target,
      operation: 'channel.inbound',
      target,
      result: 'denied',
      details: {
        claimId: accepted.id,
        provider,
        action: accepted.action,
        codeFingerprint,
        ...details,
      },
    }, filePath)
  } catch {}
  return { status: 'accepted', claim: accepted, target }
}

export function acceptChannelClaimFromMessage(msg: ChannelMessage, options: { now?: Date; config?: GatewayConfig } = {}): ChannelClaimAcceptResult {
  const extracted = extractClaimCode(msg.text)
  if (!extracted) return { status: 'no_claim' }
  const filePath = workStatePath()
  const provider = normalizeProvider(msg.provider)
  const now = options.now || new Date()
  const target = redactedChannelTargetLabel(provider, msg.chatId, msg.threadId)
  const targetHash = channelTargetFingerprint(provider, msg.chatId, msg.threadId)
  const codeHash = claimCodeHash(extracted.normalized)
  const codeFingerprint = claimCodeFingerprint(extracted.normalized)
  const claim = findChannelClaimCodeByHash(codeHash, filePath)

  if (!claim) {
    recordClaimDenial({ provider, action: 'trust_target', codeFingerprint, target, targetHash, reason: 'wrong_code' }, filePath)
    return { status: 'denied', reason: 'wrong_code', target }
  }
  if (claim.provider !== provider) {
    recordClaimEvent('channel.claim.denied', claim, 'denied', { reason: 'wrong_provider', attemptedProvider: provider, target, targetHash }, filePath)
    return { status: 'denied', reason: 'wrong_provider', claim, target }
  }
  if (claim.action !== 'trust_target') {
    recordClaimEvent('channel.claim.denied', claim, 'denied', { reason: 'wrong_action', target, targetHash }, filePath)
    return { status: 'denied', reason: 'wrong_action', claim, target }
  }
  if (claim.status === 'accepted') {
    recordClaimEvent('channel.claim.replayed', claim, 'denied', { reason: 'replay', target, targetHash }, filePath)
    return { status: 'denied', reason: 'replay', claim, target }
  }
  if (claim.status !== 'pending') {
    recordClaimEvent('channel.claim.denied', claim, 'denied', { reason: claim.status === 'expired' ? 'expired' : 'replay', target, targetHash }, filePath)
    return { status: 'denied', reason: claim.status === 'expired' ? 'expired' : 'replay', claim, target }
  }
  if (Date.parse(claim.expiresAt) <= now.getTime()) {
    const expired = updateChannelClaimCodeStatus(claim.id, { status: 'expired', deniedAt: now.toISOString(), denialReason: 'expired' }, filePath) || claim
    recordClaimEvent('channel.claim.expired', expired, 'denied', { reason: 'expired', target, targetHash }, filePath)
    return { status: 'denied', reason: 'expired', claim: expired, target }
  }
  if (!isClaimAllowlistProvider(provider)) {
    recordClaimEvent('channel.claim.denied', claim, 'denied', { reason: 'manual_trust_required', target, targetHash }, filePath)
    return { status: 'denied', reason: 'manual_trust_required', claim, target }
  }

  // Record the claiming sender as the trusted actor for this target so the
  // principal that established trust can send free text and privileged commands
  // under the default strict per-sender policy (e.g. Discord DMs, where the
  // channel id never equals the sender id).
  const config = options.config || getConfig()
  const leadership = getCurrentDaemonLeadershipStatus()
  const epoch = captureCurrentDaemonLeadershipEpoch()
  if (leadership.enabled && !epoch) throw new Error('channel claim acceptance refused: daemon writer leadership is required')
  const previousRules = (config.security.channelAllowlists[provider] || []).map(rule => ({ ...rule, userIds: rule.userIds ? [...rule.userIds] : undefined, adminUserIds: rule.adminUserIds ? [...rule.adminUserIds] : undefined }))
  const changed = addTrustedTarget(provider, { chatId: msg.chatId, threadId: msg.threadId, userIds: claimantUserIds(msg) }, config)
  let accepted: ChannelClaimCodeRecord
  try {
    if (epoch && !sameLeadershipEpoch(epoch, captureCurrentDaemonLeadershipEpoch())) throw new Error('channel claim acceptance lost daemon writer leadership')
    accepted = (epoch
      ? withWorkDbLeadershipEpoch(epoch, () => updateChannelClaimCodeStatus(claim.id, {
          status: 'accepted',
          acceptedAt: now.toISOString(),
          acceptedTargetHash: targetHash,
        }, filePath))
      : updateChannelClaimCodeStatus(claim.id, {
          status: 'accepted',
          acceptedAt: now.toISOString(),
          acceptedTargetHash: targetHash,
        }, filePath)) || claim
  } catch (err) {
    if (changed) replaceTrustedTargets(provider, previousRules)
    throw err
  }
  recordClaimEvent('channel.claim.accepted', accepted, 'ok', { target, targetHash }, filePath)
  return { status: 'accepted', claim: accepted, target }
}

export function extractClaimCode(text: string): { raw: string; normalized: string } | undefined {
  const match = CLAIM_CODE_PATTERN.exec(String(text || '').toUpperCase())
  if (!match) return undefined
  const normalized = `${match[1]}${match[2]}${match[3]}`
  return normalized.length === CLAIM_CODE_LENGTH ? { raw: match[0], normalized } : undefined
}

export function claimCodeHash(normalizedCode: string): string {
  return createHash('sha256').update(`channel-claim:v1:${normalizeClaimCode(normalizedCode)}`).digest('hex')
}

export function claimCodeFingerprint(normalizedCode: string): string {
  return createHash('sha256').update(`channel-claim-fingerprint:v1:${normalizeClaimCode(normalizedCode)}`).digest('hex').slice(0, 12)
}

export function listActiveChannelClaimCodeRefs(provider?: string, now = new Date()): string[] {
  try {
    return listChannelClaimCodes({ provider, status: 'pending', now }).map(claim => `claim-code:${claim.provider}:${claim.action}:${claim.codeFingerprint}:expires:${claim.expiresAt}`)
  } catch {
    return []
  }
}

export function listActiveChannelClaimCodeRefsReadOnly(provider?: string, now = new Date()): string[] {
  try {
    return listChannelClaimCodesReadOnly({ provider, status: 'pending', now }).map(claim => `claim-code:${claim.provider}:${claim.action}:${claim.codeFingerprint}:expires:${claim.expiresAt}`)
  } catch {
    return []
  }
}

function claimantUserIds(msg: ChannelMessage): string[] | undefined {
  const userId = String(msg.userId || '').trim()
  if (!userId || userId === 'unknown' || userId === msg.chatId) return undefined
  return [userId]
}

function addTrustedTarget(provider: ClaimAllowlistProvider, target: ChannelAllowlistRule, config: GatewayConfig): boolean {
  const current = config.security.channelAllowlists[provider] || []
  const threadId = target.threadId || undefined
  const existingIndex = current.findIndex(rule => rule.chatId === target.chatId && (rule.threadId || '') === (threadId || ''))
  if (existingIndex >= 0) {
    // Already-trusted target: merge the claimant into the existing rule's
    // userIds (idempotently) instead of returning early, so rules created
    // before per-sender actor policies can be healed in-band by re-running the
    // claim flow from the affected chat.
    const existing = current[existingIndex]!
    const merged = [...new Set([...(existing.userIds || []), ...(target.userIds || [])])]
    if (merged.length === (existing.userIds?.length || 0)) return false
    const rules = [...current]
    rules[existingIndex] = { ...existing, userIds: merged }
    updateConfig({
      security: {
        channelAllowlists: {
          [provider]: rules,
        },
      },
    } as any)
    return true
  }
  const rule: ChannelAllowlistRule = { chatId: target.chatId }
  if (threadId) rule.threadId = threadId
  if (target.userIds?.length) rule.userIds = target.userIds
  updateConfig({
    security: {
      channelAllowlists: {
        [provider]: [...current, rule],
      },
    },
  } as any)
  return true
}

function replaceTrustedTargets(provider: ClaimAllowlistProvider, rules: ChannelAllowlistRule[]): void {
  updateConfig({
    security: {
      channelAllowlists: {
        [provider]: rules,
      },
    },
  } as any)
}

function sameLeadershipEpoch(expected: WorkDbLeadershipEpoch, actual: WorkDbLeadershipEpoch | undefined): boolean {
  return Boolean(actual
    && actual.scope === expected.scope
    && actual.leaderId === expected.leaderId
    && actual.fencingToken === expected.fencingToken
    && Date.parse(actual.leaseExpiresAt) > actual.now())
}

function recordClaimDenial(input: {
  provider: string
  action: ChannelClaimAction
  codeFingerprint: string
  target: string
  targetHash: string
  reason: ChannelClaimDenyReason
}, filePath: string): void {
  const payload = {
    provider: input.provider,
    action: input.action,
    codeFingerprint: input.codeFingerprint,
    target: input.target,
    targetHash: input.targetHash,
    reason: input.reason,
  }
  try { appendWorkEvent('channel.claim.denied', undefined, payload, filePath) } catch {}
  try {
    appendAuditEvent({
      actor: input.provider,
      source: input.target,
      operation: 'channel.claim.accept',
      target: input.target,
      result: 'denied',
      details: payload,
    }, filePath)
  } catch {}
}

function recordClaimEvent(type: string, claim: ChannelClaimCodeRecord, result: 'ok' | 'denied', details: Record<string, unknown>, filePath: string): void {
  const payload = {
    claimId: claim.id,
    provider: claim.provider,
    action: claim.action,
    status: claim.status,
    codeFingerprint: claim.codeFingerprint,
    expiresAt: claim.expiresAt,
    ...details,
  }
  try { appendWorkEvent(type, claim.id, payload, filePath) } catch {}
  try {
    appendAuditEvent({
      actor: type === 'channel.claim.created' ? claim.createdBy : claim.provider,
      source: type === 'channel.claim.created' ? 'operator' : String(details['target'] || claim.provider),
      operation: type === 'channel.claim.created' ? 'channel.claim.create' : 'channel.claim.accept',
      target: String(details['target'] || `claim:${claim.id}`),
      result,
      details: payload,
    }, filePath)
  } catch {}
}

function assertProviderClaimSupported(provider: string): void {
  if (!isClaimAllowlistProvider(provider)) throw new Error(`channel provider requires manual trust: ${provider}`)
}

function isClaimAllowlistProvider(provider: string): provider is ClaimAllowlistProvider {
  return (CLAIM_ALLOWLIST_KEYS as readonly string[]).includes(provider)
}

function normalizeProvider(provider: string): string {
  const value = String(provider || '').trim().toLowerCase()
  if (!/^[a-z0-9_-]{1,40}$/.test(value)) throw new Error('provider must contain only lowercase letters, numbers, _, or -')
  return value
}

function normalizeClaimCode(value: string): string {
  let text = String(value || '').trim().toUpperCase()
  const prefixed = /^GW[-\s]+(.+)$/.exec(text)
  if (prefixed) text = prefixed[1]!
  const normalized = text.replace(/[^A-Z2-9]/g, '')
  if (normalized.length !== CLAIM_CODE_LENGTH || /[IO01]/.test(normalized)) throw new Error('claim code is malformed')
  return normalized
}

function generateClaimCode(): string {
  const bytes = randomBytes(CLAIM_CODE_LENGTH)
  let output = ''
  for (const byte of bytes) output += CLAIM_ALPHABET[byte % CLAIM_ALPHABET.length]
  return output
}

export function formatClaimCode(normalized: string): string {
  const code = normalizeClaimCode(normalized)
  return `GW-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`
}
