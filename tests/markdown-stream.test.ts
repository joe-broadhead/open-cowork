import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeFencedCodeBlocks, streamMarkdown } from '../apps/desktop/src/renderer/components/chat/markdown-stream.ts'

test('normalizes nested fences inside a top-level code block', () => {
  const source = [
    'Here is the bubble sort implementation in Julia:',
    '',
    '```julia',
    '"""',
    '    BubbleSortIterator',
    '',
    '# Examples',
    '```julia',
    'numbers = [4, 2, 7, 1]',
    '```',
    '"""',
    'function Base.iterate(iter::BubbleSortIterator, state=nothing)',
    '    return nothing',
    'end',
    '```',
    '',
    '**Key Julia features demonstrated:**',
  ].join('\n')

  const normalized = normalizeFencedCodeBlocks(source)

  assert.match(normalized, /````julia/)
  assert.match(normalized, /\n````\n\n\*\*Key Julia features demonstrated:\*\*/)
  assert.match(normalized, /\n```julia\nnumbers = \[4, 2, 7, 1\]\n```\n/)
  assert.equal(streamMarkdown(normalized, false)[0]?.src, normalized)
})

test('keeps separate top-level code fences unchanged', () => {
  const source = [
    '```ts',
    'const x = 1',
    '```',
    '',
    'Then run this:',
    '',
    '```bash',
    'echo ok',
    '```',
  ].join('\n')

  assert.equal(normalizeFencedCodeBlocks(source), source)
})

test('widens an incomplete outer fence during streaming when nested fences appear inside', () => {
  const source = [
    '```julia',
    '"""',
    '# Examples',
    '```julia',
    'numbers = [1, 2, 3]',
    '```',
    '"""',
    'function bubble_sort(arr)',
  ].join('\n')

  const blocks = streamMarkdown(source, true)

  assert.equal(blocks.length, 1)
  assert.match(blocks[0]?.src ?? '', /^````julia/)
})
