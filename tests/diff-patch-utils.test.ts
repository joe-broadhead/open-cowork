import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeHunkGap,
  diffWordsInLinePair,
  inferStatus,
  parseUnifiedPatch,
} from '../apps/desktop/src/renderer/components/chat/diff-patch-utils.ts'

describe('parseUnifiedPatch', () => {
  it('returns empty for empty patch', () => {
    assert.deepEqual(parseUnifiedPatch(''), [])
  })

  it('parses a simple single-hunk modification with correct line numbers', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' first',
      '-second',
      '+second-new',
      '+third',
      ' fourth',
    ].join('\n')
    const hunks = parseUnifiedPatch(patch)
    assert.equal(hunks.length, 1)
    const rows = hunks[0].rows
    assert.deepEqual(rows.map((row) => row.kind), ['context', 'remove', 'add', 'add', 'context'])
    const contextStart = rows[0]
    assert.equal(contextStart.oldLine, 1)
    assert.equal(contextStart.newLine, 1)
    const removed = rows[1]
    assert.equal(removed.oldLine, 2)
    assert.equal(removed.newLine, null)
    const firstAdd = rows[2]
    assert.equal(firstAdd.oldLine, null)
    assert.equal(firstAdd.newLine, 2)
    const contextEnd = rows[4]
    assert.equal(contextEnd.oldLine, 3)
    assert.equal(contextEnd.newLine, 4)
  })

  it('handles multiple hunks in a single patch', () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '@@ -10,1 +10,1 @@',
      '-c',
      '+d',
    ].join('\n')
    const hunks = parseUnifiedPatch(patch)
    assert.equal(hunks.length, 2)
    assert.equal(hunks[0].rows.length, 2)
    assert.equal(hunks[1].rows.length, 2)
    assert.equal(hunks[1].rows[0].oldLine, 10)
  })

  it('ignores git-style file headers', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      'index abc..def 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n')
    const hunks = parseUnifiedPatch(patch)
    assert.equal(hunks.length, 1)
    assert.equal(hunks[0].rows.length, 2)
  })

  it('ignores "\\ No newline at end of file" markers', () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
    ].join('\n')
    const hunks = parseUnifiedPatch(patch)
    assert.equal(hunks[0].rows.length, 2)
  })
})

describe('diffWordsInLinePair', () => {
  it('highlights only the changed tokens', () => {
    const { removedSegments, addedSegments } = diffWordsInLinePair(
      'const total = a + b',
      'const total = a + c',
    )
    assert.deepEqual(removedSegments, [
      { text: 'const total = a + ', kind: 'same' },
      { text: 'b', kind: 'removed' },
    ])
    assert.deepEqual(addedSegments, [
      { text: 'const total = a + ', kind: 'same' },
      { text: 'c', kind: 'added' },
    ])
  })

  it('handles pure insertions and deletions', () => {
    const insertion = diffWordsInLinePair('foo', 'foo bar')
    assert.ok(insertion.addedSegments.some((s) => s.kind === 'added'))
    assert.ok(insertion.removedSegments.every((s) => s.kind === 'same'))

    const deletion = diffWordsInLinePair('foo bar', 'foo')
    assert.ok(deletion.removedSegments.some((s) => s.kind === 'removed'))
    assert.ok(deletion.addedSegments.every((s) => s.kind === 'same'))
  })

  it('falls back to whole-line marking for very long inputs', () => {
    const long = 'x'.repeat(2000)
    const { removedSegments, addedSegments } = diffWordsInLinePair(long, long + 'y')
    assert.equal(removedSegments.length, 1)
    assert.equal(removedSegments[0]?.kind, 'removed')
    assert.equal(addedSegments.length, 1)
    assert.equal(addedSegments[0]?.kind, 'added')
  })
})

describe('computeHunkGap', () => {
  it('reports the unchanged run between two hunks', () => {
    const patch = [
      '@@ -10,2 +10,2 @@',
      '-old line 10',
      '+new line 10',
      '@@ -200,2 +200,2 @@',
      '-old line 200',
      '+new line 200',
    ].join('\n')
    const hunks = parseUnifiedPatch(patch)
    assert.equal(hunks.length, 2)
    const gap = computeHunkGap(hunks[0]!, hunks[1]!)
    assert.ok(gap)
    assert.equal(gap!.hiddenLines, 189)
    assert.equal(gap!.startOldLine, 11)
  })

  it('returns null when adjacent hunks have no gap', () => {
    const patch = [
      '@@ -10,1 +10,1 @@',
      '-a',
      '+b',
      '@@ -11,1 +11,1 @@',
      '-c',
      '+d',
    ].join('\n')
    const hunks = parseUnifiedPatch(patch)
    assert.equal(hunks.length, 2)
    const gap = computeHunkGap(hunks[0]!, hunks[1]!)
    assert.equal(gap, null)
  })
})

describe('inferStatus', () => {
  it('respects an explicit status when provided', () => {
    assert.equal(inferStatus([], 'added'), 'added')
    assert.equal(inferStatus([], 'deleted'), 'deleted')
  })

  it('infers added when patch is add-only', () => {
    const hunks = parseUnifiedPatch('@@ -0,0 +1,2 @@\n+line1\n+line2')
    assert.equal(inferStatus(hunks), 'added')
  })

  it('infers deleted when patch is remove-only', () => {
    const hunks = parseUnifiedPatch('@@ -1,2 +0,0 @@\n-line1\n-line2')
    assert.equal(inferStatus(hunks), 'deleted')
  })

  it('infers modified when patch has both adds and removes', () => {
    const hunks = parseUnifiedPatch('@@ -1,1 +1,1 @@\n-a\n+b')
    assert.equal(inferStatus(hunks), 'modified')
  })
})
