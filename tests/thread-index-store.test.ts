import { ThreadIndexStore, THREAD_INDEX_SCHEMA_VERSION } from '@open-cowork/runtime-host/thread-index/thread-index-store'
import { migrateThreadIndexDb } from '../packages/runtime-host/src/thread-index/thread-index-schema.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
function withStore(name: string, run: (store: ThreadIndexStore, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), `open-cowork-thread-index-${name}-`))
  const dbPath = join(root, 'thread-index.sqlite')
  const store = new ThreadIndexStore(dbPath)
  try {
    run(store, root)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('thread index migration backfills workflow_id/change_source into a pre-existing older table', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-thread-index-upgrade-'))
  const dbPath = join(root, 'thread-index.sqlite')
  try {
    // Simulate a database created under an earlier schema whose thread_index table predates the
    // workflow_id/change_source columns. `create table if not exists` cannot add them later, so the
    // migration must backfill them via ALTER — otherwise the first upsert throws "no such column".
    const legacy = new DatabaseSync(dbPath)
    // The full thread_index schema minus the workflow_id/change_source columns that were added later.
    legacy.exec(`create table thread_index (
      session_id text primary key, title text not null, kind text not null, directory text,
      project_label text, provider_id text, model_id text, status text not null,
      created_at text not null, updated_at text not null, parent_session_id text, run_id text,
      reverted_message_id text, message_count integer not null default 0,
      tool_call_count integer not null default 0, task_run_count integer not null default 0,
      cost real not null default 0, input_tokens integer not null default 0,
      output_tokens integer not null default 0, reasoning_tokens integer not null default 0,
      cache_read_tokens integer not null default 0, cache_write_tokens integer not null default 0,
      change_files integer not null default 0, change_additions integer not null default 0,
      change_deletions integer not null default 0, indexed_at text not null,
      metadata_version integer not null
    );`)
    legacy.close()

    const db = new DatabaseSync(dbPath)
    migrateThreadIndexDb(db)
    const columns = (db.prepare('pragma table_info(thread_index)').all() as Array<{ name?: string }>).map((row) => row.name)
    db.close()

    assert.ok(columns.includes('change_source'), 'change_source must be backfilled into a pre-existing table')
    assert.ok(columns.includes('workflow_id'), 'workflow_id must be backfilled into a pre-existing table')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('thread index store searches, facets, and cursor-pages 5k seeded threads', () => withStore('search', (store, root) => {
  for (let index = 0; index < 5_000; index += 1) {
    store.upsertThread({
      sessionId: `session-${String(index).padStart(4, '0')}`,
      title: index % 2 === 0 ? `Revenue report ${index}` : `Agent investigation ${index}`,
      directory: index % 3 === 0 ? `/workspace/project-${index % 5}` : null,
      projectLabel: index % 3 === 0 ? `project-${index % 5}` : null,
      providerId: index % 2 === 0 ? 'openrouter' : 'codex',
      modelId: index % 2 === 0 ? 'openrouter/sonnet' : 'codex/gpt-5',
      status: index % 7 === 0 ? 'needs_user' : 'idle',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index % 60)).toISOString(),
      messageCount: index % 10,
      toolCallCount: index % 4,
      taskRunCount: index % 3,
      actualAgents: index % 2 === 0 ? [{ name: 'research', count: 2 }] : [{ name: 'review', count: 1 }],
      actualTools: index % 5 === 0 ? [{ name: 'charts.create', mcpName: 'charts', count: 1 }] : [],
    })
  }

  const firstPage = store.searchThreads({ text: 'revenue', limit: 25, providerIds: ['openrouter'], sort: 'title_asc' })
  assert.equal(firstPage.threads.length, 25)
  assert.ok(firstPage.totalEstimate > 2_000)
  assert.ok(firstPage.nextCursor)
  assert.match(firstPage.threads[0]!.title, /Revenue report/)

  const secondPage = store.searchThreads({ text: 'revenue', limit: 25, providerIds: ['openrouter'], sort: 'title_asc', cursor: firstPage.nextCursor })
  assert.equal(secondPage.threads.length, 25)
  assert.notEqual(secondPage.threads[0]!.sessionId, firstPage.threads[0]!.sessionId)

  const facets = store.listFacets({ text: 'report' })
  assert.ok(facets.providers.some((bucket) => bucket.value === 'openrouter'))
  assert.ok(facets.agents.some((bucket) => bucket.value === 'research'))
  assert.ok(facets.tools.some((bucket) => bucket.value === 'charts.create'))
  assert.ok(store.searchThreads({ projectLabels: ['project-0'], limit: 5 }).threads.every((thread) => thread.projectLabel === 'project-0'))

  const dbPath = join(root, 'thread-index.sqlite')
  assert.equal(statSync(dbPath).mode & 0o777, 0o600)
  if (process.platform !== 'win32') {
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        assert.equal(statSync(sidecar).mode & 0o777, 0o600)
      } catch {
        // SQLite may not materialize both sidecars after a short test run.
      }
    }
  }
  assert.equal(THREAD_INDEX_SCHEMA_VERSION, 2)
}))

test('thread index store keeps user tags, smart filters, and suggestions separate', () => withStore('tags', (store) => {
  store.upsertThread({
    sessionId: 'thread-1',
    title: 'Weekly chart report',
    directory: '/workspace/revenue',
    projectLabel: 'revenue',
    providerId: 'openrouter',
    modelId: 'openrouter/sonnet',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    changeFiles: 1,
    changeAdditions: 2,
    changeDeletions: 0,
    changeSource: 'synthetic',
    actualAgents: [{ name: 'research', count: 1 }],
    actualTools: [{ name: 'charts.create', mcpName: 'charts', count: 1 }],
  })
  store.upsertThread({
    sessionId: 'thread-2',
    title: 'Provider auth debug',
    providerId: 'codex',
    modelId: 'codex/gpt-5',
    status: 'error',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
  })

  const tag = store.createTag({ name: 'Revenue', color: '#22c55e' })
  store.applyTags(['thread-1'], [tag.id])
  const filter = store.createSmartFilter({ name: 'Reports', query: { text: 'report', tagIds: [tag.id] } })
  const suggestion = store.upsertSuggestion('thread-1', {
    label: 'reporting',
    reason: 'Actual chart tool usage.',
    evidence: [{ type: 'tool', value: 'charts.create' }],
  })

  const tagged = store.searchThreads({ tagIds: [tag.id] })
  assert.equal(tagged.threads.length, 1)
  assert.equal(tagged.threads[0]!.tags[0]!.name, 'Revenue')
  assert.deepEqual(tagged.threads[0]!.changeSummary, {
    files: 1,
    additions: 2,
    deletions: 0,
    source: 'synthetic',
    synthetic: true,
  })
  assert.equal(tagged.threads[0]!.actualTools[0]!.name, 'charts.create')
  assert.equal(tagged.threads[0]!.suggestions[0]!.label, 'reporting')

  const smart = store.searchThreads({ smartFilterId: filter.id })
  assert.equal(smart.threads.length, 1)
  assert.equal(smart.threads[0]!.sessionId, 'thread-1')

  assert.equal(store.acceptSuggestion(suggestion.id), true)
  assert.equal(store.searchThreads({ text: 'reporting' }).threads[0]!.suggestions[0]!.status, 'accepted')
  assert.equal(store.dismissSuggestion(suggestion.id), true)
  assert.equal(store.searchThreads({ text: 'reporting' }).threads.length, 0)
  store.replaceSuggestedSuggestions('thread-1', [{
    label: 'reporting',
    reason: 'Deterministic refresh should not reintroduce a dismissed label.',
    evidence: [{ type: 'tool', value: 'charts.create' }],
  }])
  assert.equal(store.searchThreads({ text: 'reporting' }).threads.length, 0)

  store.removeTags(['thread-1'], [tag.id])
  assert.equal(store.searchThreads({ tagIds: [tag.id] }).threads.length, 0)
}))

test('thread index store rejects oversized thread queries and bulk tag payloads', () => withStore('caps', (store) => {
  store.upsertThread({
    sessionId: 'thread-1',
    title: 'Capped thread',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  })
  assert.throws(
    () => store.searchThreads({ text: 'x'.repeat(300) }),
    /query text exceeds/i,
  )
  const tag = store.createTag({ name: 'Small' })
  assert.throws(
    () => store.applyTags(Array.from({ length: 501 }, (_, index) => `s-${index}`), [tag.id]),
    /sessionIds exceeds 500 values/,
  )
  assert.throws(
    () => store.createTag({ name: 'x'.repeat(80) }),
    /Tag name exceeds 48 bytes/,
  )
  store.applyTags(['thread-1'], ['missing-tag'])
  assert.equal(store.searchThreads({ tagIds: ['missing-tag'] }).threads.length, 0)
  assert.throws(
    () => store.upsertSuggestion('thread-1', {
      label: 'unsafe',
      reason: 'Invalid evidence type should fail closed.',
      evidence: [{ type: 'unknown', value: 'x' } as never],
    }),
    /evidence type is invalid/i,
  )
}))
