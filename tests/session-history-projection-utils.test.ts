import type { NormalizedMessagePart, NormalizedSessionMessage } from '@open-cowork/runtime-host'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectHistoryTextParts,
  createHistoryCostPayload,
  getHistoryModelMeta,
  toHistorySortTime,
} from '../apps/desktop/src/main/session-history-projection-utils.ts'

const part = (overrides: Partial<NormalizedMessagePart>): NormalizedMessagePart => ({
  type: 'text',
  id: null,
  text: null,
  tool: null,
  callId: null,
  title: null,
  name: null,
  agent: null,
  description: null,
  prompt: null,
  raw: null,
  auto: false,
  overflow: false,
  reason: null,
  metadata: {},
  attachments: [],
  state: {
    input: {},
    output: null,
    error: null,
    attachments: [],
    metadata: {},
    title: null,
    raw: null,
    status: null,
  },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: null,
  ...overrides,
})

test('toHistorySortTime normalizes seconds while preserving millisecond timestamps', () => {
  assert.equal(toHistorySortTime(1_713_714_000), 1_713_714_000_000)
  assert.equal(toHistorySortTime(1_713_714_000_123), 1_713_714_000_123)
  assert.equal(toHistorySortTime(Number.NaN, 123), 123_000)
})

test('collectHistoryTextParts returns only non-empty text parts and concatenates replay text', () => {
  const first = part({ id: 'one', text: 'Hello ' })
  const second = part({ id: 'two', text: 'world' })
  const empty = part({ id: 'empty', text: '' })
  const tool = part({ type: 'tool', id: 'tool', text: 'ignored' })

  const result = collectHistoryTextParts([first, empty, tool, second])

  assert.deepEqual(result.textParts.map((item) => item.id), ['one', 'two'])
  assert.equal(result.fullText, 'Hello world')
})

test('createHistoryCostPayload preserves reported cost and normalizes token counters', () => {
  const result = createHistoryCostPayload('unknown-model', part({
    cost: 1.23,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 2,
      cache: { read: 3, write: 4 },
    },
  }))

  assert.equal(result.cost, 1.23)
  assert.deepEqual(result.tokens, {
    input: 10,
    output: 5,
    reasoning: 2,
    cache: { read: 3, write: 4 },
  })
})

test('getHistoryModelMeta extracts renderer-safe provider and model ids', () => {
  const message: NormalizedSessionMessage = {
    id: 'msg-1',
    role: 'assistant',
    time: {},
    info: {
      id: 'msg-1',
      title: null,
      role: 'assistant',
      parentID: null,
      sessionID: null,
      time: {},
      model: {
        providerId: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
      },
      summary: null,
      revertedMessageId: null,
    },
    parts: [],
  }

  assert.deepEqual(getHistoryModelMeta(message), {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4',
  })
})
