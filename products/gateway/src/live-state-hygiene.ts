import { createHash } from 'node:crypto'
import type { GatewayConfig } from './config.js'
import { getConfig } from './config.js'
import { listChannelSessions, listChannelSessionsReadOnly, type ChannelSessionLink } from './channel-sessions.js'
import { applyHumanGateTimeouts } from './human-loop.js'
import { redactSensitiveText } from './security.js'
import {
  appendAuditEvent,
  appendWorkEvent,
  listChannelClaimCodes,
  listChannelClaimCodesReadOnly,
  listDelegationProgressRouteReceipts,
  listDelegationProgressRouteReceiptsReadOnly,
  listHumanGates,
  listHumanGatesReadOnly,
  updateChannelClaimCodeStatus,
  type ChannelClaimCodeRecord,
  type DelegationProgressRouteReceiptRecord,
  type HumanGateRecord,
  type WorkState,
} from './work-store.js'

export type LiveStateHygieneStatus = 'clean' | 'attention'
export type LiveStateHygieneItemKind = 'expired_claim_code' | 'stale_human_gate' | 'stale_session_link' | 'stale_parent_receipt' | 'session_source_unavailable'
export type LiveStateHygieneSeverity = 'info' | 'warning' | 'critical'
export type LiveStateHygieneResetAction = 'expire_claim_code' | 'apply_human_gate_timeout'

export interface LiveStateHygieneItem {
  id: string
  kind: LiveStateHygieneItemKind
  severity: LiveStateHygieneSeverity
  summary: string
  nextAction: string
  provider?: string
  sessionRef?: string
  targetRef?: string
  evidenceRef?: string
  staleSince?: string
  resettable: boolean
  resetAction?: LiveStateHygieneResetAction
}

export interface LiveStateHygieneReport {
  generatedAt: string
  status: LiveStateHygieneStatus
  summary: string
  releaseClaim: {
    scope: string
    productionCertified: false
    notes: string[]
  }
  openCodeSessions: {
    checked: boolean
    reachable: boolean
    count: number
    error?: string
  }
  counts: Record<LiveStateHygieneItemKind, number>
  resettable: {
    expiredClaimCodes: number
    expiredHumanGates: number
    total: number
  }
  items: LiveStateHygieneItem[]
}

export interface LiveStateHygieneResetResult {
  applied: boolean
  expiredClaimCodes: string[]
  processedHumanGates: string[]
  report: LiveStateHygieneReport
}

export async function buildLiveStateHygieneReport(client?: any, options: { now?: Date; config?: GatewayConfig; state?: WorkState; readOnly?: boolean } = {}): Promise<LiveStateHygieneReport> {
  const config = options.config || getConfig()
  const now = options.now || new Date()
  const nowMs = now.getTime()
  const generatedAt = now.toISOString()
  const gates = options.readOnly ? listHumanGatesReadOnlySafe({ status: 'open' }) : listHumanGates({ status: 'open' })
  const claimCodes = options.readOnly ? listChannelClaimCodesReadOnlySafe({ status: 'pending' }) : listChannelClaimCodes({ status: 'pending' })
  const channelSessions = options.readOnly ? listChannelSessionsReadOnlySafe() : listChannelSessions()
  const receipts = options.readOnly ? listDelegationProgressRouteReceiptsReadOnlySafe({ limit: 250 }) : listDelegationProgressRouteReceipts({ limit: 250 })
  const sessionSource = await collectOpenCodeSessionIds(client, config)
  const items: LiveStateHygieneItem[] = [
    ...expiredClaimItems(claimCodes, nowMs, config),
    ...staleGateItems(gates, nowMs, config),
    ...staleSessionItems(channelSessions, sessionSource, config),
    ...staleParentReceiptItems(receipts, config),
  ]
  if (sessionSource.checked && !sessionSource.reachable) {
    items.push({
      id: 'opencode-session-source-unavailable',
      kind: 'session_source_unavailable',
      severity: 'warning',
      summary: redactSensitiveText('OpenCode session source was unavailable, so stale session links could not be proven fresh or stale.', config),
      nextAction: 'Open OpenCode Web/TUI or restart `opencode serve`, then rerun `opencode-gateway operator hygiene`.',
      resettable: false,
    })
  }
  const counts = countItems(items)
  const resettable = {
    expiredClaimCodes: items.filter(item => item.resetAction === 'expire_claim_code').length,
    expiredHumanGates: items.filter(item => item.resetAction === 'apply_human_gate_timeout').length,
    total: items.filter(item => item.resettable).length,
  }

  return {
    generatedAt,
    status: items.length ? 'attention' : 'clean',
    summary: items.length
      ? `${items.length} stale live-state signal(s); ${resettable.total} can be reset automatically.`
      : 'No stale live-state signals detected.',
    releaseClaim: {
      scope: 'Local beta live-state hygiene only: reset stale support clutter without expanding public release or production claims.',
      productionCertified: false,
      notes: [
        'Reset only expires already-expired claim codes and applies existing human-gate timeout policy.',
        'Trusted channel bindings and OpenCode session links are never deleted automatically; stale links get recovery guidance.',
        'Raw chat IDs, session IDs, claim codes, and transcript text are not emitted in this report.',
      ],
    },
    openCodeSessions: {
      checked: sessionSource.checked,
      reachable: sessionSource.reachable,
      count: sessionSource.ids?.size || 0,
      error: sessionSource.error,
    },
    counts,
    resettable,
    items,
  }
}

export async function applyLiveStateHygieneReset(client?: any, options: { now?: Date; config?: GatewayConfig } = {}): Promise<LiveStateHygieneResetResult> {
  const config = options.config || getConfig()
  const now = options.now || new Date()
  const expiredClaimCodes: string[] = []
  for (const claim of listChannelClaimCodes({ status: 'pending' })) {
    if (!isExpired(claim.expiresAt, now.getTime())) continue
    const updated = updateChannelClaimCodeStatus(claim.id, {
      status: 'expired',
      deniedAt: now.toISOString(),
      denialReason: 'live_state_hygiene_expired',
    })
    if (updated) expiredClaimCodes.push(claimRef(updated))
  }
  const processed = applyHumanGateTimeouts(config, now.getTime()).gates.map(gate => gateRef(gate))
  const applied = Boolean(expiredClaimCodes.length || processed.length)
  try {
    appendWorkEvent('live_state_hygiene.reset', undefined, {
      expiredClaimCodes: expiredClaimCodes.length,
      processedHumanGates: processed.length,
    })
  } catch {}
  try {
    appendAuditEvent({
      actor: 'operator-cli',
      source: 'live-state-hygiene',
      operation: 'operator.reset-stale',
      target: 'local-live-state',
      result: 'ok',
      details: { expiredClaimCodes: expiredClaimCodes.length, processedHumanGates: processed.length },
    })
  } catch {}
  return {
    applied,
    expiredClaimCodes,
    processedHumanGates: processed,
    report: await buildLiveStateHygieneReport(client, { now, config }),
  }
}

export function formatLiveStateHygieneText(report: LiveStateHygieneReport): string {
  const lines = [
    `Live-state hygiene: ${report.status}`,
    `Summary: ${report.summary}`,
    `Scope: ${report.releaseClaim.scope}`,
    `OpenCode sessions: ${report.openCodeSessions.checked ? report.openCodeSessions.reachable ? `${report.openCodeSessions.count} visible` : 'unavailable' : 'not checked'}`,
    `Resettable: ${report.resettable.total} (${report.resettable.expiredClaimCodes} expired claim code(s), ${report.resettable.expiredHumanGates} expired gate(s))`,
  ]
  if (report.openCodeSessions.error) lines.push(`OpenCode session source: ${report.openCodeSessions.error}`)
  if (report.items.length) {
    lines.push('', 'Stale signals:')
    for (const item of report.items.slice(0, 12)) {
      const refs = [item.provider, item.sessionRef, item.targetRef, item.evidenceRef].filter(Boolean).join(' ')
      lines.push(`- [${item.severity}] ${item.kind}${refs ? ` ${refs}` : ''}: ${item.summary}`)
      lines.push(`  Next: ${item.nextAction}`)
    }
  }
  lines.push('', 'Commands:')
  lines.push('- opencode-gateway operator hygiene - rerun this read-only report.')
  lines.push('- opencode-gateway operator reset-stale - expire resettable stale claim codes and apply existing human-gate timeout policy.')
  return lines.join('\n')
}

function expiredClaimItems(claims: ChannelClaimCodeRecord[], nowMs: number, config: GatewayConfig): LiveStateHygieneItem[] {
  return claims
    .filter(claim => isExpired(claim.expiresAt, nowMs))
    .map(claim => ({
      id: `expired-claim:${claim.provider}:${claim.codeFingerprint}`,
      kind: 'expired_claim_code' as const,
      severity: 'warning' as const,
      provider: claim.provider,
      evidenceRef: claimRef(claim),
      staleSince: claim.expiresAt,
      summary: redactSensitiveText(`${claim.provider} ${claim.action} claim code expired and is still pending.`, config),
      nextAction: 'Run `opencode-gateway operator reset-stale` to mark the expired claim closed, then create a fresh claim code if onboarding should continue.',
      resettable: true,
      resetAction: 'expire_claim_code' as const,
    }))
}

function staleGateItems(gates: HumanGateRecord[], nowMs: number, config: GatewayConfig): LiveStateHygieneItem[] {
  return gates
    .filter(gate => isExpired(gate.expiresAt, nowMs))
    .map(gate => ({
      id: `stale-gate:${gate.id}`,
      kind: 'stale_human_gate' as const,
      severity: gate.timeoutAction === 'block' || gate.timeoutAction === 'pause' ? 'critical' as const : 'warning' as const,
      evidenceRef: gateRef(gate),
      staleSince: gate.expiresAt,
      summary: redactSensitiveText(`Expired ${gate.type} gate is still open: ${gate.reason}`, config),
      nextAction: `Run \`opencode-gateway operator reset-stale\` to apply the configured timeout action (${gate.timeoutAction || config.humanLoop.timeoutAction}), or answer the gate directly if work should proceed.`,
      resettable: true,
      resetAction: 'apply_human_gate_timeout' as const,
    }))
}

function staleSessionItems(bindings: ChannelSessionLink[], source: OpenCodeSessionSource, config: GatewayConfig): LiveStateHygieneItem[] {
  if (!source.checked || !source.reachable || !source.ids) return []
  return bindings
    .filter(binding => binding.sessionId && !source.ids!.has(binding.sessionId))
    .map(binding => ({
      id: `stale-session:${binding.provider}:${fingerprint(binding.sessionId)}:${fingerprint(`${binding.chatId}:${binding.threadId || ''}`)}`,
      kind: 'stale_session_link' as const,
      severity: 'warning' as const,
      provider: binding.provider,
      sessionRef: sessionRef(binding.sessionId),
      targetRef: targetRef(binding.provider, binding.chatId, binding.threadId),
      summary: redactSensitiveText(`${binding.provider} channel binding points at an OpenCode session that is not visible in the current OpenCode server.`, config),
      nextAction: 'Create or switch to a fresh OpenCode session, then run `/project bind <alias> <roadmapId> --rebind` from the trusted channel. Gateway does not delete trusted bindings automatically.',
      resettable: false,
    }))
}

function staleParentReceiptItems(receipts: DelegationProgressRouteReceiptRecord[], config: GatewayConfig): LiveStateHygieneItem[] {
  return receipts
    .filter(receipt => receipt.state === 'stale_parent')
    .slice(0, 50)
    .map(receipt => ({
      id: `stale-parent:${fingerprint(receipt.dedupeKey)}`,
      kind: 'stale_parent_receipt' as const,
      severity: 'warning' as const,
      provider: receipt.provider,
      sessionRef: receipt.sessionId ? sessionRef(receipt.sessionId) : undefined,
      evidenceRef: `receipt:${fingerprint(receipt.dedupeKey)}`,
      staleSince: receipt.updatedAt,
      summary: redactSensitiveText('Delegated progress reached the channel, but parent OpenCode session delivery is stale.', config),
      nextAction: receipt.nextAction || 'Reconnect the parent OpenCode session client, then rerun delegated progress delivery.',
      resettable: false,
    }))
}

interface OpenCodeSessionSource {
  checked: boolean
  reachable: boolean
  ids?: Set<string>
  error?: string
}

async function collectOpenCodeSessionIds(client: any, config: GatewayConfig): Promise<OpenCodeSessionSource> {
  if (!client?.session?.list) return { checked: false, reachable: false }
  try {
    const response = await client.session.list()
    const rows = Array.isArray(response?.data) ? response.data : []
    return { checked: true, reachable: true, ids: new Set(rows.map((row: any) => String(row.id || '')).filter(Boolean)) }
  } catch (err: any) {
    return {
      checked: true,
      reachable: false,
      error: redactSensitiveText(err?.message || String(err), config).substring(0, 300),
    }
  }
}

function countItems(items: LiveStateHygieneItem[]): Record<LiveStateHygieneItemKind, number> {
  return {
    expired_claim_code: items.filter(item => item.kind === 'expired_claim_code').length,
    stale_human_gate: items.filter(item => item.kind === 'stale_human_gate').length,
    stale_session_link: items.filter(item => item.kind === 'stale_session_link').length,
    stale_parent_receipt: items.filter(item => item.kind === 'stale_parent_receipt').length,
    session_source_unavailable: items.filter(item => item.kind === 'session_source_unavailable').length,
  }
}

function listHumanGatesReadOnlySafe(filter: Parameters<typeof listHumanGatesReadOnly>[0]): ReturnType<typeof listHumanGatesReadOnly> {
  try {
    return listHumanGatesReadOnly(filter)
  } catch {
    return []
  }
}

function listChannelClaimCodesReadOnlySafe(filter: Parameters<typeof listChannelClaimCodesReadOnly>[0]): ReturnType<typeof listChannelClaimCodesReadOnly> {
  try {
    return listChannelClaimCodesReadOnly(filter)
  } catch {
    return []
  }
}

function listChannelSessionsReadOnlySafe(): ChannelSessionLink[] {
  try {
    return listChannelSessionsReadOnly()
  } catch {
    return []
  }
}

function listDelegationProgressRouteReceiptsReadOnlySafe(filter: Parameters<typeof listDelegationProgressRouteReceiptsReadOnly>[0]): ReturnType<typeof listDelegationProgressRouteReceiptsReadOnly> {
  try {
    return listDelegationProgressRouteReceiptsReadOnly(filter)
  } catch {
    return []
  }
}

function isExpired(value: string | undefined, nowMs: number): boolean {
  const time = Date.parse(value || '')
  return Number.isFinite(time) && time <= nowMs
}

function claimRef(claim: Pick<ChannelClaimCodeRecord, 'provider' | 'action' | 'codeFingerprint'>): string {
  return `claim:${claim.provider}:${claim.action}:${claim.codeFingerprint}`
}

function gateRef(gate: Pick<HumanGateRecord, 'id'>): string {
  return `gate:${fingerprint(gate.id)}`
}

function sessionRef(sessionId: string): string {
  return `session:${fingerprint(sessionId)}`
}

function targetRef(provider: string, chatId: string, threadId?: string): string {
  return `target:${provider}:${fingerprint(`${chatId}:${threadId || ''}`)}`
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}
