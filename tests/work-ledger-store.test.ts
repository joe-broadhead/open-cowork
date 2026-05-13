import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkLedgerUpsertInput } from '@open-cowork/shared'
import { WorkLedgerStore, WORK_LEDGER_SCHEMA_VERSION } from '../apps/desktop/src/main/work-ledger-store.ts'

function withStore(name: string, run: (store: WorkLedgerStore, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), `open-cowork-work-ledger-${name}-`))
  const dbPath = join(root, 'work-ledger.sqlite')
  const store = new WorkLedgerStore(dbPath)
  try {
    run(store, root)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}

function entry(overrides: Partial<WorkLedgerUpsertInput> = {}): WorkLedgerUpsertInput {
  const sourceKind = overrides.sourceKind || 'thread'
  const sourceId = overrides.sourceId || 'session-1'
  return {
    id: overrides.id || `${sourceKind}:${sourceId}`,
    sourceKind,
    sourceId,
    title: overrides.title || 'Quarterly revenue analysis',
    summary: overrides.summary ?? 'Safe summary.',
    status: overrides.status || 'completed',
    sourceLabel: overrides.sourceLabel || 'Revenue workspace',
    owner: overrides.owner ?? 'revenue',
    agents: overrides.agents || ['research'],
    capabilities: overrides.capabilities || ['charts.create'],
    usage: overrides.usage || {
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    },
    riskLabels: overrides.riskLabels || [],
    governanceLabels: overrides.governanceLabels || [],
    reviewState: overrides.reviewState || 'resolved',
    needsUserAttention: overrides.needsUserAttention ?? false,
    sourceRef: overrides.sourceRef || { kind: sourceKind, id: sourceId, sessionId: sourceId },
    route: overrides.route || { surface: 'thread', sessionId: sourceId },
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-02T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? '2026-01-02T00:00:00.000Z',
  }
}

test('work ledger store inserts, updates, facets, and cursor-pages indexed entries', () => withStore('search', (store, root) => {
  for (let index = 0; index < 240; index += 1) {
    store.upsertEntry(entry({
      id: `thread:session-${index}`,
      sourceKind: index % 3 === 0 ? 'automation_run' : 'thread',
      sourceId: `session-${index}`,
      title: index % 2 === 0 ? `Revenue ledger row ${index}` : `Incident review ${index}`,
      status: index % 5 === 0 ? 'needs_user' : 'completed',
      owner: index % 2 === 0 ? 'finance' : 'ops',
      agents: index % 2 === 0 ? ['research'] : ['review'],
      capabilities: index % 3 === 0 ? ['github.pr'] : ['charts.create'],
      riskLabels: index % 5 === 0 ? ['policy'] : [],
      governanceLabels: index % 4 === 0 ? ['approval'] : [],
      reviewState: index % 5 === 0 ? 'needs_review' : 'resolved',
      needsUserAttention: index % 5 === 0,
      updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index % 60)).toISOString(),
    }))
  }

  const first = store.searchEntries({ text: 'revenue', owners: ['finance'], limit: 20, sort: 'title_asc' })
  assert.equal(first.entries.length, 20)
  assert.ok(first.totalEstimate > 100)
  assert.ok(first.nextCursor)
  assert.match(first.entries[0]!.title, /Revenue ledger row/)

  const second = store.searchEntries({ text: 'revenue', owners: ['finance'], limit: 20, sort: 'title_asc', cursor: first.nextCursor })
  assert.equal(second.entries.length, 20)
  assert.notEqual(second.entries[0]!.id, first.entries[0]!.id)

  const attention = store.searchEntries({ needsUserAttention: true, reviewStates: ['needs_review'] })
  assert.ok(attention.entries.length > 0)
  assert.ok(attention.entries.every((item) => item.needsUserAttention))

  const facets = store.listFacets({ text: 'ledger' })
  assert.ok(facets.sourceKinds.some((bucket) => bucket.value === 'thread'))
  assert.ok(facets.owners.some((bucket) => bucket.value === 'finance'))
  assert.ok(facets.agents.some((bucket) => bucket.value === 'research'))
  assert.ok(facets.capabilities.some((bucket) => bucket.value === 'charts.create'))

  const dbPath = join(root, 'work-ledger.sqlite')
  assert.equal(statSync(dbPath).mode & 0o777, 0o600)
  assert.equal(WORK_LEDGER_SCHEMA_VERSION, 1)
}))

test('work ledger store keeps stable source references across rename and archive updates', () => withStore('refs', (store) => {
  const original = store.upsertEntry(entry({
    id: 'automation:automation-1',
    sourceKind: 'automation',
    sourceId: 'automation-1',
    title: 'Weekly report',
    status: 'ready',
    sourceRef: { kind: 'automation', id: 'automation-1', automationId: 'automation-1' },
    route: { surface: 'automations', automationId: 'automation-1' },
  }))
  const updated = store.upsertEntry(entry({
    ...original,
    title: 'Renamed weekly report',
    status: 'archived',
    updatedAt: '2026-02-01T00:00:00.000Z',
  }))

  assert.equal(updated.title, 'Renamed weekly report')
  assert.equal(updated.status, 'archived')
  assert.deepEqual(updated.sourceRef, { kind: 'automation', id: 'automation-1', automationId: 'automation-1' })
  assert.deepEqual(updated.route, { surface: 'automations', automationId: 'automation-1' })
  assert.equal(store.searchEntries({ text: 'weekly' }).entries.length, 1)
}))

test('work ledger store redacts obvious secrets and rejects oversized queries', () => withStore('redaction', (store) => {
  store.upsertEntry(entry({
    title: 'Investigate token=super-secret-value',
    summary: 'Failed with Authorization: Bearer abcdefghijklmnopqrstuvwxyz and password=hunter2',
  }))
  const result = store.searchEntries({ text: 'investigate' })
  assert.equal(result.entries.length, 1)
  const serialized = JSON.stringify(result.entries[0])
  assert.equal(serialized.includes('super-secret-value'), false)
  assert.equal(serialized.includes('abcdefghijklmnopqrstuvwxyz'), false)
  assert.equal(serialized.includes('hunter2'), false)
  assert.match(serialized, /redacted/)

  assert.throws(
    () => store.searchEntries({ text: 'x'.repeat(300) }),
    /query text exceeds/i,
  )
}))
