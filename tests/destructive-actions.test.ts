import test from 'node:test'
import assert from 'node:assert/strict'
import { createDestructiveConfirmationManager } from '../apps/desktop/src/main/destructive-actions.ts'

test('destructive confirmation tokens are single-use and action-bound', () => {
  const manager = createDestructiveConfirmationManager(() => 1_000)
  const grant = manager.issue({ action: 'session.delete', sessionId: 'session-1' })

  assert.equal(
    manager.consume({ action: 'session.delete', sessionId: 'session-1' }, grant.token),
    true,
  )
  assert.equal(
    manager.consume({ action: 'session.delete', sessionId: 'session-1' }, grant.token),
    false,
  )
})

test('destructive confirmation tokens do not authorize a different target', () => {
  const manager = createDestructiveConfirmationManager(() => 1_000)
  const grant = manager.issue({
    action: 'mcp.remove',
    target: { name: 'nova', scope: 'machine', directory: null },
  })

  assert.equal(
    manager.consume({
      action: 'mcp.remove',
      target: { name: 'charts', scope: 'machine', directory: null },
    }, grant.token),
    false,
  )
})

test('destructive confirmation tokens expire', () => {
  let now = 1_000
  const manager = createDestructiveConfirmationManager(() => now)
  const grant = manager.issue({
    action: 'skill.remove',
    target: { name: 'chart-creator', scope: 'machine', directory: null },
  })

  now = 40_000

  assert.equal(
    manager.consume({
      action: 'skill.remove',
      target: { name: 'chart-creator', scope: 'machine', directory: null },
    }, grant.token),
    false,
  )
})
