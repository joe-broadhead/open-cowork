import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractManagedSessionIdsFromLogContents,
  normalizeStoredSessionRecord,
} from '../apps/desktop/src/main/session-registry-utils.ts'

test('extractManagedSessionIdsFromLogContents finds created and forked Cowork sessions', () => {
  const ids = extractManagedSessionIdsFromLogContents([
    '[2026-04-11T14:35:24.993Z] [session] Created session ses_aaa111\n',
    '[2026-04-11T14:35:24.994Z] [session] Forked ses_aaa111 -> ses_bbb222 at message\n',
  ])

  assert.deepEqual(Array.from(ids).sort(), ['ses_aaa111', 'ses_bbb222'])
})

test('normalizeStoredSessionRecord keeps Cowork-managed records and drops external ones', () => {
  const normalizeDirectory = (value: string) => value
  const toDisplayDirectory = (value: string) => value === '/runtime-home' ? null : value

  const managed = normalizeStoredSessionRecord({
    id: 'ses_managed',
    opencodeDirectory: '/runtime-home',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  }, normalizeDirectory, toDisplayDirectory, new Set(['ses_managed']))

  const external = normalizeStoredSessionRecord({
    id: 'ses_external',
    opencodeDirectory: '/external',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  }, normalizeDirectory, toDisplayDirectory, new Set(['ses_managed']))

  assert.deepEqual(managed, {
    id: 'ses_managed',
    title: undefined,
    directory: null,
    opencodeDirectory: '/runtime-home',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    providerId: null,
    modelId: null,
    summary: null,
    parentSessionId: null,
    changeSummary: null,
    revertedMessageId: null,
    kind: 'interactive',
    automationId: null,
    runId: null,
    managedByCowork: true,
  })
  assert.equal(external, null)
})
