import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { auditLedgerEntryHash } from '../audit-ledger.js'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { runStorageLifecycleAudit } from '../storage.js'
import { appendAuditEvent, appendWorkEvent, clearWorkStateForTest, listAuditLedgerEntries, runWorkStoreRetentionMaintenance } from '../work-store.js'

describe('audit ledger', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-audit-ledger-test-'))
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:telegram-secret-token-value'
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-secret-token'
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    updateConfig({ channels: { telegram: { botToken: '123456:telegram-secret-token-value' } } } as any)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['TELEGRAM_BOT_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('writes queryable redacted ledger rows for high-value events', () => {
    const firstEventId = appendAuditEvent({
      actor: 'operator',
      source: 'http',
      operation: 'config.update',
      target: 'telegram:trusted-chat-42:topic-private',
      result: 'denied',
      details: {
        token: 'operator-secret-token',
        body: 'private transcript body',
        path: '/Users/joe/private-notes/audit.md',
        sessionId: 'ses_private_audit',
      },
    }, store)
    const secondEventId = appendWorkEvent('delegation.progress', 'task_audit_1', {
      idempotencyKey: 'audit-ledger-key',
      progress: 'completed',
      summary: 'private message body about trusted-chat-42',
      provider: 'telegram',
      chatId: 'trusted-chat-42',
      threadId: 'topic-private',
    }, store)
    const runtimeEventId = appendWorkEvent('runtime.capability_grant.rejected', 'task_audit_1', {
      stage: 'implement',
      status: 'denied',
      taskId: 'task_audit_1',
      capabilityGrant: {
        id: 'grant_private',
        status: 'denied',
        grants: {
          filesystem: { workdir: '/Users/joe/private-notes/runtime', policy: 'local-workdir' },
          secrets: { allowedNames: ['GITHUB_TOKEN'], count: 1 },
        },
      },
    }, store)

    const rows = listAuditLedgerEntries({ limit: 20 }, store)
    const configRow = rows.find(row => row.sourceEventId === firstEventId)
    const delegationRow = rows.find(row => row.sourceEventId === secondEventId)
    const runtimeRow = rows.find(row => row.sourceEventId === runtimeEventId)

    expect(configRow).toMatchObject({
      sourceEventType: 'audit.security',
      class: 'config_admin',
      result: 'denied',
      retentionClass: 'security_audit',
      evidenceRefs: [`work_event:${firstEventId}`],
    })
    expect(delegationRow).toMatchObject({
      sourceEventType: 'delegation.progress',
      class: 'scheduler_transition',
      retentionClass: 'local_beta_work_history',
    })
    expect(runtimeRow).toMatchObject({
      sourceEventType: 'runtime.capability_grant.rejected',
      class: 'security_decision',
      result: 'denied',
      resourceKind: 'task',
      retentionClass: 'security_audit',
      evidenceRefs: [`work_event:${runtimeEventId}`],
    })
    expect(delegationRow?.previousHash).toBe(configRow?.entryHash)
    expect(runtimeRow?.previousHash).toBe(delegationRow?.entryHash)
    for (const row of rows) {
      const { entryHash, ...withoutEntryHash } = row
      expect(auditLedgerEntryHash({ ...withoutEntryHash, id: 0 })).toBe(entryHash)
    }
    expect(listAuditLedgerEntries({ class: 'scheduler_transition' }, store).map(row => row.sourceEventType)).toEqual(['delegation.progress'])

    const serialized = JSON.stringify(rows)
    for (const raw of [
      'trusted-chat-42',
      'topic-private',
      'telegram-secret-token-value',
      'operator-secret-token',
      'private transcript body',
      'private message body',
      'ses_private_audit',
      '/Users/joe/private-notes/audit.md',
      '/Users/joe/private-notes/runtime',
    ]) {
      expect(serialized).not.toContain(raw)
    }
  })

  it('serves the per-append dedupe lookup with an index instead of a full ledger scan', () => {
    appendAuditEvent({ actor: 'operator', source: 'http', operation: 'config.update', target: 'target-a', result: 'ok' }, store)

    const db = new DatabaseSync(store, { readOnly: true })
    try {
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM audit_ledger WHERE source_event_id = ?').all(1) as any[]
      const detail = plan.map(row => String(row.detail)).join(' | ')
      expect(detail).toMatch(/USING (COVERING )?INDEX/)
      expect(detail).not.toContain('SCAN audit_ledger')
    } finally {
      db.close()
    }
  })

  it('prunes ledger rows beyond the row cap and keeps chain verification passing via the retention anchor', () => {
    const eventIds: number[] = []
    for (let index = 0; index < 6; index++) {
      eventIds.push(appendWorkEvent('delegation.progress', `task_retention_${index}`, {
        idempotencyKey: `retention-key-${index}`,
        progress: 'completed',
      }, store))
    }
    const beforeRows = listAuditLedgerEntries({ limit: 50 }, store)
    expect(beforeRows.length).toBeGreaterThanOrEqual(6)
    const expectedAnchor = beforeRows[beforeRows.length - 4]

    const result = runWorkStoreRetentionMaintenance(store, { auditLedgerMaxRows: 3 })

    expect(result.auditLedger.pruned).toBe(beforeRows.length - 3)
    expect(result.auditLedger.retained).toBe(3)
    expect(result.auditLedger.anchorHash).toBe(expectedAnchor!.entryHash)

    const afterRows = listAuditLedgerEntries({ limit: 50 }, store)
    expect(afterRows).toHaveLength(3)
    expect(afterRows[0]!.previousHash).toBe(expectedAnchor!.entryHash)
    expect(afterRows.map(row => row.sourceEventId)).toEqual(eventIds.slice(-3))

    const report = runStorageLifecycleAudit({ now: new Date() })
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'audit_ledger_hash_chain', status: 'pass' }),
      expect.objectContaining({ name: 'audit_ledger_entry_hashes', status: 'pass' }),
    ]))
  })

  it('chunks an over-cap retention prune into bounded transactions that land on the same boundary and anchor', () => {
    for (let index = 0; index < 9; index++) {
      appendWorkEvent('delegation.progress', `task_chunk_${index}`, {
        idempotencyKey: `chunk-key-${index}`,
        progress: 'completed',
      }, store)
    }
    const beforeRows = listAuditLedgerEntries({ limit: 100 }, store)
    expect(beforeRows.length).toBeGreaterThanOrEqual(9)
    const keepRows = 3
    const toDelete = beforeRows.length - keepRows
    const expectedAnchor = beforeRows[toDelete - 1]

    // Every chunk advances the retention anchor inside its own transaction, so
    // counting anchor meta writes counts delete transactions.
    const db = new DatabaseSync(store)
    db.exec(`
      CREATE TABLE anchor_write_audit(value TEXT NOT NULL);
      CREATE TRIGGER audit_anchor_write AFTER INSERT ON meta WHEN NEW.key = 'auditLedgerRetentionAnchorHash'
      BEGIN
        INSERT INTO anchor_write_audit(value) VALUES (NEW.value);
      END;
    `)
    db.close()

    const chunkRows = 2
    const result = runWorkStoreRetentionMaintenance(store, { auditLedgerMaxRows: keepRows, auditLedgerDeleteChunkRows: chunkRows })
    expect(result.auditLedger).toMatchObject({ pruned: toDelete, retained: keepRows, anchorHash: expectedAnchor!.entryHash })

    const auditDb = new DatabaseSync(store)
    const anchorWrites = (auditDb.prepare('SELECT value FROM anchor_write_audit').all() as any[]).map(row => String(row.value))
    auditDb.close()
    expect(anchorWrites.length).toBe(Math.ceil(toDelete / chunkRows))
    expect(anchorWrites.length).toBeGreaterThan(1)
    expect(anchorWrites[anchorWrites.length - 1]).toBe(expectedAnchor!.entryHash)
    // Every intermediate anchor is a real chunk-boundary hash from the pruned prefix.
    const prunedHashes = beforeRows.slice(0, toDelete).map(row => row.entryHash)
    for (const value of anchorWrites) expect(prunedHashes).toContain(value)

    const afterRows = listAuditLedgerEntries({ limit: 100 }, store)
    expect(afterRows).toHaveLength(keepRows)
    expect(afterRows[0]!.previousHash).toBe(expectedAnchor!.entryHash)
    expect(afterRows.map(row => row.entryHash)).toEqual(beforeRows.slice(toDelete).map(row => row.entryHash))

    const report = runStorageLifecycleAudit({ now: new Date() })
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'audit_ledger_hash_chain', status: 'pass' }),
      expect.objectContaining({ name: 'audit_ledger_entry_hashes', status: 'pass' }),
    ]))
  })

  it('prunes expired rows by age and continues the chain from the anchor after a full prune', () => {
    appendWorkEvent('delegation.progress', 'task_age_1', { idempotencyKey: 'age-key-1', progress: 'completed' }, store)
    appendWorkEvent('delegation.progress', 'task_age_2', { idempotencyKey: 'age-key-2', progress: 'completed' }, store)
    const beforeRows = listAuditLedgerEntries({ limit: 50 }, store)
    const lastHash = beforeRows[beforeRows.length - 1]!.entryHash

    // Everything is older than a zero-length retention window.
    const result = runWorkStoreRetentionMaintenance(store, { auditLedgerMaxAgeMs: 0, now: new Date(Date.now() + 1000) })
    expect(result.auditLedger.pruned).toBe(beforeRows.length)
    expect(result.auditLedger.retained).toBe(0)
    expect(result.auditLedger.anchorHash).toBe(lastHash)
    expect(listAuditLedgerEntries({ limit: 50 }, store)).toHaveLength(0)

    // The next append chains from the anchor, not from a fresh genesis.
    appendWorkEvent('delegation.progress', 'task_age_3', { idempotencyKey: 'age-key-3', progress: 'completed' }, store)
    const afterRows = listAuditLedgerEntries({ limit: 50 }, store)
    expect(afterRows).toHaveLength(1)
    expect(afterRows[0]!.previousHash).toBe(lastHash)

    const report = runStorageLifecycleAudit({ now: new Date() })
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'audit_ledger_hash_chain', status: 'pass' }),
    ]))
  })

  it('is a no-op when the ledger is inside the retention policy', () => {
    appendWorkEvent('delegation.progress', 'task_noop', { idempotencyKey: 'noop-key', progress: 'completed' }, store)
    const before = listAuditLedgerEntries({ limit: 50 }, store)

    const result = runWorkStoreRetentionMaintenance(store)

    expect(result.auditLedger.pruned).toBe(0)
    expect(listAuditLedgerEntries({ limit: 50 }, store)).toEqual(before)
  })
})
