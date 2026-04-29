import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeExplorerSymbols,
  normalizeFileContent,
  normalizeFileNodes,
  normalizeFileStatuses,
  normalizeTextMatches,
} from '../apps/desktop/src/main/explorer-normalizers.ts'

describe('normalizeFileNodes', () => {
  it('returns [] for non-array input', () => {
    assert.deepEqual(normalizeFileNodes(null), [])
    assert.deepEqual(normalizeFileNodes('oops'), [])
    assert.deepEqual(normalizeFileNodes({}), [])
  })

  it('keeps only well-formed nodes with a valid type', () => {
    const result = normalizeFileNodes([
      { name: 'a.ts', path: 'src/a.ts', absolute: '/repo/src/a.ts', type: 'file', ignored: false },
      { name: 'lib', path: 'src/lib', absolute: '/repo/src/lib', type: 'directory' },
      { name: 'weird', path: 'x', absolute: '/x', type: 'mystery' }, // invalid type
      { name: 'missing-path', absolute: '/y', type: 'file' }, // missing path
      null,
      { foo: 'bar' }, // missing required fields
    ])
    assert.equal(result.length, 2)
    assert.equal(result[0].name, 'a.ts')
    assert.equal(result[0].ignored, false)
    assert.equal(result[1].name, 'lib')
    assert.equal(result[1].ignored, false)
  })

  it('defaults ignored to false when missing', () => {
    const result = normalizeFileNodes([
      { name: 'x', path: 'x', absolute: '/x', type: 'file' },
    ])
    assert.equal(result[0].ignored, false)
  })
})

describe('normalizeFileContent', () => {
  it('returns null for invalid input', () => {
    assert.equal(normalizeFileContent(null), null)
    assert.equal(normalizeFileContent({ type: 'unknown' }), null)
    assert.equal(normalizeFileContent({}), null)
  })

  it('accepts text and binary file content', () => {
    const text = normalizeFileContent({ type: 'text', content: 'hello' })
    assert.equal(text?.type, 'text')
    assert.equal(text?.content, 'hello')
    const binary = normalizeFileContent({ type: 'binary', content: '' })
    assert.equal(binary?.type, 'binary')
  })

  it('rebuilds unified patch from the structured patch shape when present', () => {
    const result = normalizeFileContent({
      type: 'text',
      content: '',
      patch: {
        hunks: [
          { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' first', '-old', '+new-a', '+new-b'] },
        ],
      },
    })
    assert.ok(result?.patch)
    assert.ok(result?.patch?.includes('@@ -1,2 +1,3 @@'))
    assert.ok(result?.patch?.includes('+new-a'))
  })

  it('prefers a top-level string patch over the structured one', () => {
    const result = normalizeFileContent({
      type: 'text',
      content: '',
      patch: '@@ -1,1 +1,1 @@\n-a\n+b',
    })
    assert.equal(result?.patch, '@@ -1,1 +1,1 @@\n-a\n+b')
  })
})

describe('normalizeFileStatuses', () => {
  it('drops entries with unknown status values', () => {
    const result = normalizeFileStatuses([
      { path: 'a', added: 1, removed: 0, status: 'added' },
      { path: 'b', added: 0, removed: 0, status: 'renamed' },
      { path: 'c', added: 0, removed: 0, status: 'modified' },
    ])
    assert.equal(result.length, 2)
    assert.deepEqual(result.map((f) => f.status), ['added', 'modified'])
  })

  it('defaults numeric fields to 0', () => {
    const result = normalizeFileStatuses([
      { path: 'x', status: 'added' },
    ])
    assert.equal(result[0].added, 0)
    assert.equal(result[0].removed, 0)
  })

  it('drops entries without a path', () => {
    assert.deepEqual(normalizeFileStatuses([{ status: 'added' }]), [])
  })
})

describe('normalizeExplorerSymbols', () => {
  it('extracts path from a file:// URI', () => {
    const result = normalizeExplorerSymbols([
      {
        name: 'foo',
        kind: 12,
        location: {
          uri: 'file:///repo/src/a.ts',
          range: { start: { line: 3, character: 4 }, end: { line: 3, character: 10 } },
        },
      },
    ])
    assert.equal(result[0].path, '/repo/src/a.ts')
    assert.equal(result[0].range.start.line, 3)
    assert.equal(result[0].range.start.col, 4)
    assert.equal(result[0].range.end.col, 10)
  })

  it('falls back to the raw uri when it has no file:// prefix', () => {
    const result = normalizeExplorerSymbols([
      {
        name: 'x',
        kind: 0,
        location: { uri: 'src/a.ts', range: { start: {}, end: {} } },
      },
    ])
    assert.equal(result[0].path, 'src/a.ts')
  })

  it('skips entries without a name', () => {
    assert.deepEqual(normalizeExplorerSymbols([{ kind: 1, location: {} }]), [])
  })
})

describe('normalizeTextMatches', () => {
  it('flattens ripgrep-style path/lines nesting', () => {
    const result = normalizeTextMatches([
      {
        path: { text: 'src/a.ts' },
        lines: { text: 'const foo = 1' },
        line_number: 42,
        submatches: [
          { match: { text: 'foo' }, start: 6, end: 9 },
        ],
      },
    ])
    assert.equal(result[0].path, 'src/a.ts')
    assert.equal(result[0].lineText, 'const foo = 1')
    assert.equal(result[0].lineNumber, 42)
    assert.equal(result[0].submatches.length, 1)
    assert.equal(result[0].submatches[0].text, 'foo')
    assert.equal(result[0].submatches[0].start, 6)
  })

  it('drops matches without a path', () => {
    assert.deepEqual(normalizeTextMatches([{ lines: { text: 'x' } }]), [])
  })

  it('filters submatches that are missing required fields', () => {
    const result = normalizeTextMatches([
      {
        path: { text: 'a' },
        lines: { text: 'x' },
        line_number: 1,
        submatches: [
          { match: { text: 'ok' }, start: 0, end: 2 },
          { match: {}, start: 0, end: 2 }, // no text
          { match: { text: 'no-range' } }, // no start/end
        ],
      },
    ])
    assert.equal(result[0].submatches.length, 1)
    assert.equal(result[0].submatches[0].text, 'ok')
  })
})
