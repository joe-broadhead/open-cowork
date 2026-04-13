import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMessages,
  buildSessionStateFromItems,
  createEmptySessionViewState,
  deriveVisibleSessionPatch,
  type HistoryItem,
} from '../apps/desktop/src/renderer/stores/session.ts'

test('history replay keeps the final authoritative text for a message part', () => {
  const items: HistoryItem[] = [
    {
      type: 'message',
      id: 'evt-1',
      messageId: 'msg-1',
      partId: 'part-1',
      role: 'assistant',
      content: 'Hello wor',
      timestamp: '2026-04-13T10:00:00.000Z',
    },
    {
      type: 'message',
      id: 'evt-2',
      messageId: 'msg-1',
      partId: 'part-1',
      role: 'assistant',
      content: 'Hello world',
      timestamp: '2026-04-13T10:00:01.000Z',
    },
  ]

  const state = buildSessionStateFromItems(items)
  const messages = buildMessages(state.messageIds, state.messageById, state.messagePartsById)

  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'Hello world')
  assert.deepEqual(messages[0].segments?.map((segment) => segment.content), ['Hello world'])
})

test('visible session state pauses generation while awaiting permission', () => {
  const state = createEmptySessionViewState({ hydrated: true })
  const visible = deriveVisibleSessionPatch(
    state,
    'session-1',
    new Set(['session-1']),
    new Set(['session-1']),
  )

  assert.equal(visible.isGenerating, false)
  assert.equal(visible.isAwaitingPermission, true)
})

test('visible session state resumes generating when approval wait clears', () => {
  const state = createEmptySessionViewState({ hydrated: true })
  const visible = deriveVisibleSessionPatch(
    state,
    'session-1',
    new Set(['session-1']),
    new Set<string>(),
  )

  assert.equal(visible.isGenerating, true)
  assert.equal(visible.isAwaitingPermission, false)
})
