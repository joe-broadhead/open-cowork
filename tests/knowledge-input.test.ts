import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKnowledgeProposalContent } from '../apps/desktop/src/main/knowledge/knowledge-input.ts'

// The knowledge proposal normalizer is the shared coercion used by BOTH the
// desktop IPC handlers and the Cloud HTTP route, so the two trust boundaries
// stay consistent. These tests pin that coercion contract.

test('normalizes proposal content: trims strings, coerces numbers, keeps null/undefined intent', () => {
  const result = normalizeKnowledgeProposalContent({
    spaceId: 'space-1',
    pageId: '  page-7  ',
    pageTitle: 'Parental leave',
    summary: 'Updated policy',
    add: 12,
    del: 3,
    links: [{ id: 'l1', kind: 'artifact', label: 'Doc' }],
    body: [{ id: 'b1', type: 'p', text: 'Body' }],
    // not part of the proposal content — must be dropped
    workspaceId: 'attacker-controlled',
    by: 'attacker',
  } as Record<string, unknown>)

  assert.equal(result.spaceId, 'space-1')
  assert.equal(result.pageId, 'page-7')
  assert.equal(result.pageTitle, 'Parental leave')
  assert.equal(result.summary, 'Updated policy')
  assert.equal(result.add, 12)
  assert.equal(result.del, 3)
  assert.deepEqual(result.links, [{ id: 'l1', kind: 'artifact', label: 'Doc' }])
  // workspace + actor are NOT carried by the content normalizer — each caller
  // injects those from its authenticated context.
  assert.ok(!('workspaceId' in result))
  assert.ok(!('by' in result))
})

test('drops non-string pageId/non-number counts and non-array links', () => {
  const result = normalizeKnowledgeProposalContent({
    spaceId: 'space-1',
    pageId: 42,
    summary: 'x',
    add: 'not-a-number',
    del: null,
    links: 'not-an-array',
    body: [],
  } as Record<string, unknown>)

  assert.ok(!('pageId' in result), 'a non-string, non-null pageId is omitted')
  assert.ok(!('add' in result), 'a non-number add is omitted')
  assert.equal(result.del, null, 'an explicit null count is preserved as null')
  assert.ok(!('links' in result), 'a non-array links value is omitted')
})

test('preserves explicit null pageId (clear-the-target intent)', () => {
  const result = normalizeKnowledgeProposalContent({ spaceId: 's', summary: 'x', body: [], pageId: null } as Record<string, unknown>)
  assert.equal(result.pageId, null)
})
