import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { DurableOpencodeClient as OpencodeClient } from './opencode-session-runtime.js'
import type { ChannelAdapter } from './channels/provider.js'
import { getConfig, getConfigDir } from './config.js'
import { canCurrentDaemonWrite } from './daemon-leadership.js'
import { listChannelSessions, type ChannelSessionLink } from './channel-sessions.js'
import { listChannelBindings, recoverInterruptedStorageRestore, restrictSqliteDbPermissions } from './work-store.js'
import { queueEvent } from './wakeup.js'
import { redactSensitiveText, redactedChannelTargetLabel } from './security.js'
import {
  emptyChannelSyncState,
  loadChannelSyncCoordinationState,
  readChannelSyncCoordinationState,
  saveChannelSyncCoordinationState,
  type ChannelSyncState,
  type DeliveryCheckpoint,
  type PendingInbound,
} from './channel-sync-state-store.js'

// JOE-996 / H1: coordination state (deliveries, pendingInbound, receipts) lives in
// channel-sync.json.sqlite. Legacy channel-sync.json is imported once.

export interface ChannelSyncSummary {
  active: boolean
  lastSyncAt?: string
  deliveriesTracked: number
  pendingInbound: number
  outbox?: {
    pending: number
    leased: number
    delivered: number
    deadLetter: number
    providerBackoff: Array<{ provider: string; retryAfter: string; pending: number; lastError?: string }>
  }
}

type OutboundDecision =
  | { action: 'deliver'; text: string }
  | { action: 'skip' }
  | { action: 'defer' }

export interface ChannelSyncOptions {
  includeUserMessages?: boolean
  intervalMs?: number
  stateFile?: string
  outboxFile?: string
  workStateFile?: string
  now?: () => number
}

export interface ChannelSyncClient {
  session: {
    messages(args: { path: { id: string } }): Promise<{ data?: any[] }>
  }
}

export interface ChannelDeliveryReceipt {
  receiptId?: string
  messageId?: string
  id?: string
}

export interface ChannelDeliveryAdapter {
  sendMessage(chatId: string, text: string, options?: { threadId?: string; idempotencyKey?: string }): Promise<undefined | string | ChannelDeliveryReceipt>
  reconcileDelivery?(input: {
    chatId: string
    threadId?: string
    idempotencyKey: string
    receiptId: string
  }): Promise<'delivered' | 'pending' | 'unknown' | { status: 'delivered' | 'pending' | 'unknown' }>
}

const RECENT_SEEN_LIMIT = 5000
const PENDING_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_INTERVAL_MS = 3000
const OUTBOX_LEASE_MS = 60_000
const INBOUND_SUBMIT_LEASE_MS = 30_000
// The OpenCode session API has no since-cursor, so every poll refetches the
// full transcript. Sessions with no unseen messages back off exponentially
// (capped) and snap back on inbound traffic or an OpenCode activity event.
const IDLE_POLL_BACKOFF_MAX_MS = 60_000
const IDLE_POLL_BACKOFF_MAX_STREAK = 16
// Delivered/dead-letter outbox rows are receipts, not a queue; prune them on a
// slow cadence so chat volume cannot grow the outbox database forever.
const OUTBOX_DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const OUTBOX_DEAD_LETTER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const OUTBOX_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000

let activeBridge: ChannelSyncBridge | null = null

export class ChannelSyncBridge {
  private state: ChannelSyncState | null = null
  private timer: NodeJS.Timeout | null = null
  private syncInFlight: Promise<void> | null = null
  private stopped = false
  private readonly includeUserMessages: boolean
  private readonly intervalMs: number
  private readonly stateFile: string
  private readonly outboxFile: string
  private readonly workStateFile?: string
  private readonly now: () => number
  private readonly ownerId = `channel-sync-${process.pid}-${randomUUID()}`
  private readonly sessionPollState = new Map<string, { idleStreak: number; nextPollAt: number }>()
  private lastOutboxMaintenanceMs = 0

  constructor(
    private readonly client: ChannelSyncClient,
    private readonly channels: Map<string, Pick<ChannelAdapter, 'sendMessage'>>,
    options: ChannelSyncOptions = {},
  ) {
    this.includeUserMessages = options.includeUserMessages ?? true
    this.intervalMs = normalizeIntervalMs(options.intervalMs)
    this.stateFile = options.stateFile || defaultStateFile()
    this.outboxFile = options.outboxFile || defaultOutboxFile(this.stateFile)
    this.workStateFile = options.workStateFile
    this.now = options.now || Date.now
  }

  start(): NodeJS.Timeout {
    if (this.timer) return this.timer
    this.stopped = false
    this.timer = setInterval(() => {
      this.syncOnce().catch(err => queueEvent(`Channel sync failed: ${cleanError(err?.message || String(err))}`))
    }, this.intervalMs)
    this.syncOnce().catch(err => queueEvent(`Channel sync failed: ${cleanError(err?.message || String(err))}`))
    return this.timer
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.drain()
  }

  async drain(): Promise<void> {
    while (this.syncInFlight) {
      const inFlight = this.syncInFlight
      await inFlight
      if (this.syncInFlight === inFlight) return
    }
  }

  recordInbound(sessionId: string, provider: string, chatId: string, text: string, threadId?: string, providerMessageId?: string): boolean {
    if (!canCurrentDaemonWrite()) return false
    const state = this.loadState()
    const normalizedProviderMessageId = normalizeProviderMessageId(providerMessageId)
    const receiptKey = normalizedProviderMessageId ? inboundReceiptKey(provider, chatId, threadId, normalizedProviderMessageId) : undefined
    const existingReceipt = receiptKey ? state.inboundReceipts[receiptKey] : undefined
    if (existingReceipt?.submittedAt) return false
    const textHash = hashText(text)
    const createdAt = this.now()
    if (existingReceipt?.submitLeaseUntil && existingReceipt.submitLeaseUntil > createdAt) return false
    const submitLeaseUntil = createdAt + INBOUND_SUBMIT_LEASE_MS
    if (receiptKey && existingReceipt) {
      state.pendingInbound = state.pendingInbound.filter(row => !sameInbound(row, provider, chatId, threadId, normalizedProviderMessageId, existingReceipt.textHash))
    }
    state.pendingInbound.push({ sessionId, provider, chatId, threadId: normalizeThreadId(threadId) || undefined, textHash, createdAt, submitLeaseUntil, providerMessageId: normalizedProviderMessageId })
    // Inbound traffic means a reply is coming: resume fast polling immediately.
    this.notifySessionActivity(sessionId)
    if (receiptKey && normalizedProviderMessageId) {
      state.inboundReceipts[receiptKey] = {
        sessionId,
        provider,
        chatId,
        threadId: normalizeThreadId(threadId) || undefined,
        providerMessageId: normalizedProviderMessageId,
        textHash,
        createdAt,
        submitLeaseUntil,
      }
    }
    this.prunePending(state)
    this.saveState()
    return true
  }

  markInboundSubmitted(provider: string, chatId: string, text: string, threadId?: string, providerMessageId?: string): void {
    const normalizedProviderMessageId = normalizeProviderMessageId(providerMessageId)
    if (!normalizedProviderMessageId) return
    const state = this.loadState()
    const key = inboundReceiptKey(provider, chatId, threadId, normalizedProviderMessageId)
    const receipt = state.inboundReceipts[key]
    if (!receipt) return
    const submittedAt = this.now()
    receipt.submittedAt = submittedAt
    receipt.submitLeaseUntil = undefined
    const textHash = hashText(text)
    for (const row of state.pendingInbound) {
      if (sameInbound(row, provider, chatId, threadId, normalizedProviderMessageId, textHash)) {
        row.submittedAt = submittedAt
        row.submitLeaseUntil = undefined
      }
    }
    this.saveState()
  }

  forgetInbound(provider: string, chatId: string, text: string, threadId?: string, providerMessageId?: string): void {
    const normalizedProviderMessageId = normalizeProviderMessageId(providerMessageId)
    const textHash = hashText(text)
    const state = this.loadState()
    state.pendingInbound = state.pendingInbound.filter(row => !sameInbound(row, provider, chatId, threadId, normalizedProviderMessageId, textHash))
    if (normalizedProviderMessageId) delete state.inboundReceipts[inboundReceiptKey(provider, chatId, threadId, normalizedProviderMessageId)]
    this.saveState()
  }

  async initialize(sessionId: string, provider: string, chatId: string, threadId?: string): Promise<void> {
    if (!canCurrentDaemonWrite()) return
    const key = checkpointKey(sessionId, provider, chatId, threadId)
    const state = this.loadState()
    if (state.deliveries[key]) return

    const messages = await this.readMessages(sessionId)
    state.deliveries[key] = createCheckpoint(sessionId, provider, chatId, this.now(), threadId)
    for (const message of messages) this.markSeen(state.deliveries[key], message)
    this.saveState()
  }

  summary(): ChannelSyncSummary {
    return summarizeChannelSyncState(this.loadState(), true, this.outboxFile, this.now())
  }

  async syncOnce(): Promise<void> {
    if (this.stopped) return
    if (!canCurrentDaemonWrite()) return
    if (this.syncInFlight) return this.syncInFlight
    this.syncInFlight = this.runSyncOnce().finally(() => { this.syncInFlight = null })
    return this.syncInFlight
  }

  /**
   * Reset the idle-poll backoff for a session, typically because an OpenCode
   * event or inbound channel message signalled activity on it.
   */
  notifySessionActivity(sessionId: string): void {
    if (!sessionId) return
    this.sessionPollState.delete(sessionId)
  }

  private async runSyncOnce(): Promise<void> {
    this.maybeRunOutboxMaintenance()
    const links = this.workStateFile ? listChannelBindings({}, this.workStateFile) : listChannelSessions()
    if (links.length === 0) return

    const bySession = new Map<string, ChannelSessionLink[]>()
    for (const link of links) {
      const rows = bySession.get(link.sessionId) || []
      rows.push(link)
      bySession.set(link.sessionId, rows)
    }
    // Drop poll state for sessions that are no longer bound.
    for (const sessionId of this.sessionPollState.keys()) {
      if (!bySession.has(sessionId)) this.sessionPollState.delete(sessionId)
    }

    for (const [sessionId, sessionLinks] of bySession.entries()) {
      const poll = this.sessionPollState.get(sessionId)
      if (poll && poll.nextPollAt > this.now()) continue
      const messages = await this.readMessages(sessionId)
      let active = false
      for (const link of sessionLinks) {
        if (await this.syncLink(link, messages)) active = true
      }
      this.updateSessionPollState(sessionId, active)
    }
    this.prunePending(this.loadState())
    this.saveState()
  }

  private updateSessionPollState(sessionId: string, active: boolean): void {
    if (active) {
      this.sessionPollState.delete(sessionId)
      return
    }
    const idleStreak = Math.min((this.sessionPollState.get(sessionId)?.idleStreak || 0) + 1, IDLE_POLL_BACKOFF_MAX_STREAK)
    const backoffMs = Math.min(this.intervalMs * 2 ** idleStreak, IDLE_POLL_BACKOFF_MAX_MS)
    this.sessionPollState.set(sessionId, { idleStreak, nextPollAt: this.now() + backoffMs })
  }

  /** Returns true when the link saw unseen messages (delivered, deferred, or skipped). */
  private async syncLink(link: ChannelSessionLink, messages: any[]): Promise<boolean> {
    const state = this.loadState()
    const key = checkpointKey(link.sessionId, link.provider, link.chatId, link.threadId)
    let checkpoint = state.deliveries[key]
    if (!checkpoint) {
      checkpoint = createCheckpoint(link.sessionId, link.provider, link.chatId, this.now(), link.threadId)
      state.deliveries[key] = checkpoint
      for (const message of messages) this.markSeen(checkpoint, message)
      return true
    }

    const channel = this.channels.get(link.provider) as ChannelDeliveryAdapter | undefined
    if (!channel) return false

    let sawUnseen = false
    const sorted = [...messages].sort((a, b) => messageCreated(a) - messageCreated(b))
    for (const message of sorted) {
      if (this.hasSeen(checkpoint, message)) continue
      sawUnseen = true
      const outbound = this.renderOutbound(message, link)
      if (outbound.action === 'defer') break
      if (outbound.action === 'skip') {
        this.markSeen(checkpoint, message)
        continue
      }

      try {
        const target = redactedChannelTargetLabel(link.provider, link.chatId, link.threadId)
        const lease = this.acquireOutboxLease(link, message, outbound.text)
        if (lease === 'delivered') {
          this.markSeen(checkpoint, message)
          continue
        }
        if (lease === 'dead_letter') {
          queueEvent(`Channel sync delivery dead-lettered for ${target}; operator action required`)
          break
        }
        if (lease !== 'leased') break
        const idempotencyKey = outboxDeliveryId(link, message)
        const providerReceipt = this.readOutboxProviderReceipt(link, message)
        if (providerReceipt?.receiptId && channel.reconcileDelivery) {
          const reconciled = await channel.reconcileDelivery({
            chatId: link.chatId,
            threadId: link.threadId,
            idempotencyKey,
            receiptId: providerReceipt.receiptId,
          })
          const status = typeof reconciled === 'string' ? reconciled : reconciled.status
          if (status === 'delivered') {
            if (!this.completeOutboxDelivery(link, message)) break
            this.markSeen(checkpoint, message)
            queueEvent(`Channel sync reconciled delivered ${messageRole(message)} message to ${target}`)
            continue
          }
          if (status === 'pending') break
        }
        const sendResult = await channel.sendMessage(link.chatId, outbound.text, { threadId: link.threadId, idempotencyKey })
        const receiptId = providerReceiptId(sendResult)
        if (receiptId) this.recordOutboxProviderReceipt(link, message, receiptId, Boolean(channel.reconcileDelivery))
        if (!this.completeOutboxDelivery(link, message)) {
          queueEvent(`Channel sync delivery lease lost for ${target}; leaving checkpoint behind for retry`)
          break
        }
        this.markSeen(checkpoint, message)
        queueEvent(`Channel sync delivered ${messageRole(message)} message to ${target}`)
      } catch (err: any) {
        this.failOutboxDelivery(link, message, err?.message || String(err))
        queueEvent(`Channel sync delivery failed to ${redactedChannelTargetLabel(link.provider, link.chatId, link.threadId)}: ${cleanError(err?.message || String(err))}`)
        break
      }
    }
    return sawUnseen
  }

  private renderOutbound(message: any, target: ChannelSessionLink): OutboundDecision {
    const role = messageRole(message)
    const text = extractMessageText(message)

    if (role === 'assistant') {
      if (!messageComplete(message)) return { action: 'defer' }
      return text ? { action: 'deliver', text } : { action: 'skip' }
    }

    if (!text) return { action: 'skip' }
    if (role !== 'user' || !this.includeUserMessages) return { action: 'skip' }

    const source = this.matchPendingInbound(message)
    if (source?.provider === target.provider && source.chatId === target.chatId && normalizeThreadId(source.threadId) === normalizeThreadId(target.threadId)) return { action: 'skip' }

    const label = source ? channelLabel(source.provider) : 'OpenCode Web'
    return { action: 'deliver', text: `${label}:\n${text}` }
  }

  private matchPendingInbound(message: any): PendingInbound | undefined {
    const id = messageId(message)
    const sessionId = messageSessionId(message)
    const text = extractMessageText(message)
    const created = messageCreated(message)
    const state = this.loadState()

    let match = state.pendingInbound.find(p => p.messageId === id)
    if (!match) {
      match = state.pendingInbound.find(p =>
        p.sessionId === sessionId &&
        p.textHash === hashText(text) &&
        !p.messageId &&
        created >= p.createdAt - 5000 &&
        created <= p.createdAt + 10 * 60 * 1000,
      )
    }
    if (match && !match.messageId) {
      match.messageId = id
      this.saveState()
    }
    return match
  }

  private hasSeen(checkpoint: DeliveryCheckpoint, message: any): boolean {
    const id = messageId(message)
    const created = messageCreated(message)
    if (!id) return true
    if (checkpoint.seenMessageIds.includes(id)) return true
    if (created === checkpoint.lastMessageCreated && checkpoint.lastMessageCreatedIds.includes(id)) return true
    return checkpoint.lastMessageCreated > 0 && created < checkpoint.lastMessageCreated
  }

  private markSeen(checkpoint: DeliveryCheckpoint, message: any): void {
    const id = messageId(message)
    if (!id) return
    const created = messageCreated(message)
    if (created > checkpoint.lastMessageCreated) {
      checkpoint.lastMessageCreated = created
      checkpoint.lastMessageCreatedIds = [id]
    } else if (created === checkpoint.lastMessageCreated && !checkpoint.lastMessageCreatedIds.includes(id)) {
      checkpoint.lastMessageCreatedIds.push(id)
    }
    if (!checkpoint.seenMessageIds.includes(id)) checkpoint.seenMessageIds.push(id)
    checkpoint.seenMessageIds = checkpoint.seenMessageIds.slice(-RECENT_SEEN_LIMIT)
    checkpoint.lastMessageCreatedIds = checkpoint.lastMessageCreatedIds.slice(-RECENT_SEEN_LIMIT)
    checkpoint.updatedAt = new Date(this.now()).toISOString()
  }

  private async readMessages(sessionId: string): Promise<any[]> {
    const { createOpenCodeSessionRuntime } = await import('./opencode-session-runtime.js')
    return createOpenCodeSessionRuntime(this.client as any).messages(sessionId)
  }

  private loadState(): ChannelSyncState {
    if (this.state) return this.state
    this.state = loadChannelSyncCoordinationState(this.outboxFile, this.stateFile, this.now())
      || emptyChannelSyncState(this.now())
    return this.state
  }

  private saveState(): void {
    if (!this.state) return
    this.state.savedAt = new Date(this.now()).toISOString()
    saveChannelSyncCoordinationState(this.outboxFile, this.state)
  }

  private prunePending(state: ChannelSyncState): void {
    const cutoff = this.now() - PENDING_TTL_MS
    state.pendingInbound = state.pendingInbound.filter(p => p.createdAt >= cutoff)
    for (const [key, receipt] of Object.entries(state.inboundReceipts)) {
      if (receipt.createdAt < cutoff) delete state.inboundReceipts[key]
    }
  }

  private acquireOutboxLease(link: ChannelSessionLink, message: any, text: string): 'leased' | 'busy' | 'delivered' | 'dead_letter' {
    const db = this.openOutboxDb()
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const id = outboxDeliveryId(link, message)
        const now = new Date(this.now()).toISOString()
        const providerBackoff = db.prepare(`
          SELECT retry_after FROM channel_sync_outbox
          WHERE provider = ? AND status = 'pending' AND retry_after IS NOT NULL AND retry_after > ?
          ORDER BY retry_after DESC LIMIT 1
        `).get(link.provider, now) as any
        if (providerBackoff?.retry_after) {
          db.exec('COMMIT')
          return 'busy'
        }
        const existing = db.prepare('SELECT status, lease_expires_at, retry_after FROM channel_sync_outbox WHERE id = ?').get(id) as any
        if (existing?.status === 'delivered') {
          db.exec('COMMIT')
          return 'delivered'
        }
        if (existing?.status === 'dead_letter') {
          db.exec('COMMIT')
          return 'dead_letter'
        }
        const leaseExpires = Date.parse(String(existing?.lease_expires_at || ''))
        if (existing?.status === 'leased' && Number.isFinite(leaseExpires) && leaseExpires > this.now()) {
          db.exec('COMMIT')
          return 'busy'
        }
        const retryAfter = Date.parse(String(existing?.retry_after || ''))
        if (existing?.status === 'pending' && Number.isFinite(retryAfter) && retryAfter > this.now()) {
          db.exec('COMMIT')
          return 'busy'
        }
        db.prepare(`INSERT OR IGNORE INTO channel_sync_outbox (
          id, session_id, provider, chat_id, thread_id, message_id, message_created, role, text_hash,
          idempotency_key, delivery_semantics, status, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'at_least_once', 'pending', 0, ?, ?)`).run(
          id,
          link.sessionId,
          link.provider,
          link.chatId,
          normalizeThreadId(link.threadId),
          messageId(message),
          messageCreated(message),
          messageRole(message),
          hashText(text),
          id,
          now,
          now,
        )
        db.prepare(`UPDATE channel_sync_outbox
          SET status = 'leased', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, last_error = NULL, retry_after = NULL, updated_at = ?
          WHERE id = ?`).run(this.ownerId, new Date(this.now() + OUTBOX_LEASE_MS).toISOString(), now, id)
        db.exec('COMMIT')
        return 'leased'
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
        throw err
      }
    } finally {
      db.close()
    }
  }

  private completeOutboxDelivery(link: ChannelSessionLink, message: any): boolean {
    const db = this.openOutboxDb()
    try {
      const now = new Date(this.now()).toISOString()
      const result = db.prepare(`UPDATE channel_sync_outbox
        SET status = 'delivered', delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND lease_owner = ?`).run(now, now, outboxDeliveryId(link, message), this.ownerId)
      return result.changes === 1
    } finally {
      db.close()
    }
  }

  private readOutboxProviderReceipt(link: ChannelSessionLink, message: any): { receiptId?: string } | undefined {
    const db = this.openOutboxDb()
    try {
      const row = db.prepare('SELECT provider_receipt_id FROM channel_sync_outbox WHERE id = ? AND lease_owner = ?')
        .get(outboxDeliveryId(link, message), this.ownerId) as { provider_receipt_id?: unknown } | undefined
      const receiptId = typeof row?.provider_receipt_id === 'string' && row.provider_receipt_id ? row.provider_receipt_id : undefined
      return receiptId ? { receiptId } : undefined
    } finally {
      db.close()
    }
  }

  private recordOutboxProviderReceipt(link: ChannelSessionLink, message: any, receiptId: string, reconcilable: boolean): void {
    const db = this.openOutboxDb()
    try {
      const now = new Date(this.now()).toISOString()
      db.prepare(`UPDATE channel_sync_outbox
        SET provider_receipt_id = ?, provider_receipt_json = ?, delivery_semantics = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ?`).run(
          receiptId,
          JSON.stringify({ receiptId }),
          reconcilable ? 'provider_receipt_reconciliation' : 'provider_receipt_at_least_once',
          now,
          outboxDeliveryId(link, message),
          this.ownerId,
        )
    } finally {
      db.close()
    }
  }

  private failOutboxDelivery(link: ChannelSessionLink, message: any, reason: string): void {
    const db = this.openOutboxDb()
    try {
      const now = new Date(this.now()).toISOString()
      const id = outboxDeliveryId(link, message)
      const row = db.prepare('SELECT attempts FROM channel_sync_outbox WHERE id = ? AND lease_owner = ?').get(id, this.ownerId) as any
      const attempts = Number(row?.attempts || 0)
      const policy = deliveryFailurePolicy(reason, attempts, this.now())
      db.prepare(`UPDATE channel_sync_outbox
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, retry_after = ?, dead_lettered_at = ?, provider_error_kind = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ?`).run(
          policy.deadLetter ? 'dead_letter' : 'pending',
          cleanError(reason),
          policy.retryAfter,
          policy.deadLetter ? now : null,
          policy.kind,
          now,
          id,
          this.ownerId,
        )
      const target = redactedChannelTargetLabel(link.provider, link.chatId, link.threadId)
      if (policy.deadLetter) queueEvent(`Channel sync delivery dead-lettered after ${attempts} attempt(s) to ${target}: ${cleanError(reason)}`)
      else if (policy.retryAfter) queueEvent(`Channel sync backing off ${link.provider} delivery until ${policy.retryAfter}: ${cleanError(reason)}`)
    } finally {
      db.close()
    }
  }

  private maybeRunOutboxMaintenance(): void {
    const nowMs = this.now()
    if (nowMs - this.lastOutboxMaintenanceMs < OUTBOX_MAINTENANCE_INTERVAL_MS) return
    this.lastOutboxMaintenanceMs = nowMs
    if (!fs.existsSync(this.outboxFile)) return
    try {
      const db = this.openOutboxDb()
      try {
        const deliveredCutoff = new Date(nowMs - OUTBOX_DELIVERED_RETENTION_MS).toISOString()
        const deadLetterCutoff = new Date(nowMs - OUTBOX_DEAD_LETTER_RETENTION_MS).toISOString()
        const delivered = db.prepare("DELETE FROM channel_sync_outbox WHERE status = 'delivered' AND COALESCE(delivered_at, updated_at) < ?").run(deliveredCutoff) as any
        const deadLettered = db.prepare("DELETE FROM channel_sync_outbox WHERE status = 'dead_letter' AND COALESCE(dead_lettered_at, updated_at) < ?").run(deadLetterCutoff) as any
        const pruned = Number(delivered?.changes || 0) + Number(deadLettered?.changes || 0)
        if (pruned) queueEvent(`Channel sync outbox retention pruned ${pruned} settled delivery receipt(s)`)
      } finally {
        db.close()
      }
    } catch (err: any) {
      queueEvent(`Channel sync outbox retention failed: ${cleanError(err?.message || String(err))}`)
    }
  }

  private openOutboxDb(): DatabaseSync {
    recoverInterruptedStorageRestore(path.dirname(this.outboxFile))
    fs.mkdirSync(path.dirname(this.outboxFile), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.outboxFile)
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS channel_sync_outbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL,
        message_created INTEGER NOT NULL,
        role TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        idempotency_key TEXT,
        provider_receipt_id TEXT,
        provider_receipt_json TEXT,
        delivery_semantics TEXT NOT NULL DEFAULT 'at_least_once',
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        retry_after TEXT,
        dead_lettered_at TEXT,
        provider_error_kind TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_sync_outbox_status ON channel_sync_outbox(status, lease_expires_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_channel_sync_outbox_backoff ON channel_sync_outbox(provider, status, retry_after);
      CREATE INDEX IF NOT EXISTS idx_channel_sync_outbox_session ON channel_sync_outbox(session_id, provider, chat_id, thread_id);
    `)
    ensureOutboxColumns(db)
    db.prepare('UPDATE channel_sync_outbox SET idempotency_key = id WHERE idempotency_key IS NULL OR idempotency_key = ?').run('')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_sync_outbox_idempotency ON channel_sync_outbox(idempotency_key)')
    // Owner-only for the outbox and its SQLite WAL/SHM sidecars, which inherit the
    // process umask when SQLite creates them (guaranteed to exist after the WAL
    // pragma and schema writes above).
    restrictSqliteDbPermissions(this.outboxFile)
    return db
  }
}

export function startChannelSync(client: OpencodeClient, channels: Map<string, Pick<ChannelAdapter, 'sendMessage'>>): ChannelSyncBridge | null {
  const cfg = getConfig().channelSync
  if (cfg.enabled === false) return null
  activeBridge?.stop()
  activeBridge = new ChannelSyncBridge(client as unknown as ChannelSyncClient, channels, {
    includeUserMessages: cfg.includeUserMessages,
    intervalMs: cfg.intervalMs,
  })
  activeBridge.start()
  return activeBridge
}


export function getChannelSyncSummary(options: { stateFile?: string; now?: number } = {}): ChannelSyncSummary {
  if (activeBridge && !options.stateFile) return activeBridge.summary()
  const stateFile = options.stateFile || defaultStateFile()
  return summarizeChannelSyncState(readChannelSyncState(stateFile), false, defaultOutboxFile(stateFile), options.now)
}

export function clearChannelSyncForTest(filePath = defaultStateFile()): void {
  activeBridge?.stop()
  activeBridge = null
  try { fs.rmSync(filePath, { force: true }) } catch {}
  try { fs.rmSync(defaultOutboxFile(filePath), { force: true }) } catch {}
  try { fs.rmSync(`${defaultOutboxFile(filePath)}-wal`, { force: true }) } catch {}
  try { fs.rmSync(`${defaultOutboxFile(filePath)}-shm`, { force: true }) } catch {}
}

export function extractMessageText(message: any): string {
  return (Array.isArray(message?.parts) ? message.parts : [])
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('\n')
    .trim()
}

function createCheckpoint(sessionId: string, provider: string, chatId: string, now: number, threadId?: string): DeliveryCheckpoint {
  const timestamp = new Date(now).toISOString()
  return { sessionId, provider, chatId, threadId: normalizeThreadId(threadId) || undefined, initializedAt: timestamp, updatedAt: timestamp, lastMessageCreated: 0, lastMessageCreatedIds: [], seenMessageIds: [] }
}

function checkpointKey(sessionId: string, provider: string, chatId: string, threadId?: string): string {
  return `${sessionId}:${provider}:${chatId}:${normalizeThreadId(threadId)}`
}

function defaultStateFile(): string {
  return path.join(process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir(), 'channel-sync.json')
}

function defaultOutboxFile(stateFile: string): string {
  return `${stateFile}.sqlite`
}

function outboxDeliveryId(link: ChannelSessionLink, message: any): string {
  return hashText([link.sessionId, link.provider, link.chatId, normalizeThreadId(link.threadId), messageId(message)].join('\u0000'))
}

function cleanError(reason: string): string {
  return redactSensitiveText(reason, getConfig()).substring(0, 1000)
}

function readChannelSyncState(filePath: string): ChannelSyncState | null {
  return readChannelSyncCoordinationState(defaultOutboxFile(filePath), filePath)
}

/** Test/diagnostics helper: read authoritative coordination state from SQLite (H1). */
export function readChannelSyncStateForTest(stateFile = defaultStateFile()): ChannelSyncState | null {
  return readChannelSyncState(stateFile)
}

function summarizeChannelSyncState(state: ChannelSyncState | null, active: boolean, outboxFile?: string, now = Date.now()): ChannelSyncSummary {
  return {
    active,
    lastSyncAt: state?.savedAt || undefined,
    deliveriesTracked: Object.keys(state?.deliveries || {}).length,
    pendingInbound: state?.pendingInbound.length || 0,
    outbox: summarizeOutbox(outboxFile, now),
  }
}

function summarizeOutbox(outboxFile: string | undefined, now: number): ChannelSyncSummary['outbox'] {
  if (!outboxFile || !fs.existsSync(outboxFile)) return { pending: 0, leased: 0, delivered: 0, deadLetter: 0, providerBackoff: [] }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(outboxFile, { readOnly: true })
    const columns = new Set((db.prepare('PRAGMA table_info(channel_sync_outbox)').all() as any[]).map(row => String(row.name)))
    const hasBackoff = columns.has('retry_after')
    const counts = db.prepare('SELECT status, COUNT(*) AS count FROM channel_sync_outbox GROUP BY status').all() as any[]
    const byStatus = Object.fromEntries(counts.map(row => [String(row.status), Number(row.count || 0)]))
    const providerBackoff = hasBackoff
      ? db.prepare(`
          SELECT provider, MAX(retry_after) AS retry_after, COUNT(*) AS pending, MAX(last_error) AS last_error
          FROM channel_sync_outbox
          WHERE status = 'pending' AND retry_after IS NOT NULL AND retry_after > ?
          GROUP BY provider
          ORDER BY retry_after DESC
        `).all(new Date(now).toISOString()) as any[]
      : []
    return {
      pending: byStatus['pending'] || 0,
      leased: byStatus['leased'] || 0,
      delivered: byStatus['delivered'] || 0,
      deadLetter: byStatus['dead_letter'] || 0,
      providerBackoff: providerBackoff.map(row => ({
        provider: String(row.provider || 'unknown'),
        retryAfter: String(row.retry_after || ''),
        pending: Number(row.pending || 0),
        ...(row.last_error ? { lastError: cleanError(String(row.last_error)) } : {}),
      })).filter(row => row.retryAfter),
    }
  } catch {
    return { pending: 0, leased: 0, delivered: 0, deadLetter: 0, providerBackoff: [] }
  } finally {
    db?.close()
  }
}

function ensureOutboxColumns(db: DatabaseSync): void {
  const columns = new Set((db.prepare('PRAGMA table_info(channel_sync_outbox)').all() as any[]).map(row => String(row.name)))
  for (const [name, ddl] of [
    ['retry_after', 'ALTER TABLE channel_sync_outbox ADD COLUMN retry_after TEXT'],
    ['dead_lettered_at', 'ALTER TABLE channel_sync_outbox ADD COLUMN dead_lettered_at TEXT'],
    ['provider_error_kind', 'ALTER TABLE channel_sync_outbox ADD COLUMN provider_error_kind TEXT'],
    ['idempotency_key', 'ALTER TABLE channel_sync_outbox ADD COLUMN idempotency_key TEXT'],
    ['provider_receipt_id', 'ALTER TABLE channel_sync_outbox ADD COLUMN provider_receipt_id TEXT'],
    ['provider_receipt_json', 'ALTER TABLE channel_sync_outbox ADD COLUMN provider_receipt_json TEXT'],
    ['delivery_semantics', "ALTER TABLE channel_sync_outbox ADD COLUMN delivery_semantics TEXT NOT NULL DEFAULT 'at_least_once'"],
  ] as const) {
    if (!columns.has(name)) db.exec(ddl)
  }
}

function providerReceiptId(result: undefined | string | ChannelDeliveryReceipt): string | undefined {
  if (typeof result === 'string') return result.trim() || undefined
  if (!result || typeof result !== 'object') return undefined
  for (const value of [result.receiptId, result.messageId, result.id]) {
    if (typeof value === 'string' && value.trim()) return value.trim().substring(0, 500)
  }
  return undefined
}

function deliveryFailurePolicy(reason: string, attempts: number, now: number): { kind: string; retryAfter: string | null; deadLetter: boolean } {
  const config = getConfig().channelSync
  const text = reason.toLowerCase()
  const kind = /429|rate limit|too many requests|retry after|retry_after/.test(text)
    ? 'rate_limit'
    : /401|403|unauthorized|forbidden|invalid token|chat not found|bad request/.test(text)
      ? 'terminal'
      : 'transient'
  const deadLetter = attempts >= (config.maxDeliveryAttempts || 10) || kind === 'terminal'
  if (deadLetter) return { kind, retryAfter: null, deadLetter: true }
  if (kind !== 'rate_limit') return { kind, retryAfter: null, deadLetter: false }
  const hintedSeconds = Number(reason.match(/(?:retry[_ -]?after|retry_after)[^\d]*(\d{1,6})/i)?.[1])
  const delayMs = Number.isFinite(hintedSeconds) && hintedSeconds > 0 ? hintedSeconds * 1000 : (config.providerBackoffMs || 60_000)
  return { kind, retryAfter: new Date(now + delayMs).toISOString(), deadLetter: false }
}

function messageId(message: any): string {
  return String(message?.info?.id || '')
}

function messageSessionId(message: any): string {
  return String(message?.info?.sessionID || '')
}

function messageRole(message: any): string {
  return String(message?.info?.role || '')
}

function messageCreated(message: any): number {
  return Number(message?.info?.time?.created || 0)
}

function messageComplete(message: any): boolean {
  if (typeof message?.info?.time?.completed === 'number') return true
  return (Array.isArray(message?.parts) ? message.parts : []).some((part: any) => part?.type === 'step-finish')
}

function channelLabel(provider: string): string {
  if (provider === 'telegram') return 'Telegram'
  if (provider === 'whatsapp') return 'WhatsApp'
  return provider
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function normalizeIntervalMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1000 ? value : DEFAULT_INTERVAL_MS
}

function sameInbound(row: PendingInbound, provider: string, chatId: string, threadId: string | undefined, providerMessageId: string | undefined, textHash: string): boolean {
  return row.provider === provider &&
    row.chatId === chatId &&
    (row.threadId || '') === (normalizeThreadId(threadId) || '') &&
    row.providerMessageId === providerMessageId &&
    row.textHash === textHash
}

function inboundReceiptKey(provider: string, chatId: string, threadId: string | undefined, providerMessageId: string): string {
  return hashText([provider, chatId, normalizeThreadId(threadId), providerMessageId].join('\u0000'))
}

function normalizeProviderMessageId(value?: string | null): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized ? normalized.substring(0, 300) : undefined
}

function normalizeThreadId(threadId?: string | null): string {
  return threadId ? String(threadId) : ''
}
