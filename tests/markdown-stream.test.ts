import assert from 'node:assert/strict'
import test from 'node:test'
import { streamMarkdown } from '../packages/app/src/components/chat/markdown-stream.ts'

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

  const normalized = streamMarkdown(source, false)[0]?.src ?? ''

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

  assert.equal(streamMarkdown(source, false)[0]?.src, source)
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

test('normalizes model-collapsed GFM tables before final rendering', () => {
  const source = '| Day | Date (2026) | Sessions | CVR | |---|---|---|---| | Sun | 26 Apr | 152,762 | 3.03% | | Mon | 27 Apr | 185,921 | 2.90% |'
  const normalized = streamMarkdown(source, false)[0]?.src

  assert.equal(normalized, [
    '| Day | Date (2026) | Sessions | CVR |',
    '|---|---|---|---|',
    '| Sun | 26 Apr | 152,762 | 3.03% |',
    '| Mon | 27 Apr | 185,921 | 2.90% |',
  ].join('\n'))
  assert.equal(streamMarkdown(source, false)[0]?.src, normalized)
})

test('normalizes collapsed table rows with empty cells without splitting them as row boundaries', () => {
  const source = '| Metric | Current | Notes | |---|---|---| | Sessions | 906,321 | All days down YoY | | CVR | 2.79% | |'
  const normalized = streamMarkdown(source, false)[0]?.src

  assert.equal(normalized, [
    '| Metric | Current | Notes |',
    '|---|---|---|',
    '| Sessions | 906,321 | All days down YoY |',
    '| CVR | 2.79% | |',
  ].join('\n'))
})

test('normalizes collapsed table separators with padded cells', () => {
  const source = '| Day | Sessions | | --- | ---: | | Sun | 10 | | Mon | 12 |'
  const normalized = streamMarkdown(source, false)[0]?.src

  assert.equal(normalized, [
    '| Day | Sessions |',
    '| --- | ---: |',
    '| Sun | 10 |',
    '| Mon | 12 |',
  ].join('\n'))
})

test('does not normalize collapsed-looking tables inside code fences', () => {
  const source = [
    '```md',
    '| Day | Sessions | |---|---| | Sun | 10 |',
    '```',
  ].join('\n')

  assert.equal(streamMarkdown(source, false)[0]?.src, source)
})
