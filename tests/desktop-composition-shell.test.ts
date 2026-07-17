import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

test('JOE-842: desktop question-normalization no longer imports OpenCode SDK', () => {
  const source = readFileSync(join(root, 'apps/desktop/src/main/question-normalization.ts'), 'utf8')
  assert.equal(/@opencode-ai\/sdk/.test(source), false)
  assert.match(source, /@open-cowork\/runtime-host\/question-normalization/)
})

test('JOE-842: composition-shell inventory documents residual desktop SDK seams', () => {
  const inventory = readFileSync(join(root, 'docs/desktop-composition-shell.md'), 'utf8')
  const residual = [
    'apps/desktop/src/main/events.ts',
    'apps/desktop/src/main/event-subscriptions.ts',
    'apps/desktop/src/main/durable-session-events.ts',
    'apps/desktop/src/main/runtime-mcp-status-polling.ts',
    'apps/desktop/src/main/ipc/context.ts',
    'apps/desktop/src/main/ipc/provider-handlers.ts',
  ]
  for (const path of residual) {
    assert.match(inventory, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(inventory, /Removal plan/)
  assert.match(inventory, /question-normalization/)
})

test('JOE-842: runtime-host question normalization is pure and bounds inputs', async () => {
  const {
    normalizeQuestionAnswers,
    normalizeQuestionRequestId,
  } = await import('@open-cowork/runtime-host/question-normalization')

  assert.equal(normalizeQuestionRequestId(' q-1 '), 'q-1')
  assert.throws(() => normalizeQuestionRequestId(''), /required/)
  assert.deepEqual(normalizeQuestionAnswers([['A', 'B'], ['C']]), [['A', 'B'], ['C']])
  assert.throws(() => normalizeQuestionAnswers('nope'), /array/)
})
