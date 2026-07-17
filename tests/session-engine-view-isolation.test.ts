import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionEngine } from '@open-cowork/runtime-host/session-engine'

test('getSessionView seals views so callers cannot mutate engine state (JOE-868)', () => {
  const engine = createSessionEngine()
  engine.activateSession('ses_isolation')
  engine.applyStreamEvent({
    type: 'busy',
    sessionId: 'ses_isolation',
    data: { type: 'busy' },
  } as never)

  const a = engine.getSessionView('ses_isolation')
  const b = engine.getSessionView('ses_isolation')
  // Identity is stable while the revision is cached (memoization-friendly).
  assert.equal(a, b)
  assert.ok(Object.isFrozen(a))

  const original = a.isGenerating
  assert.throws(() => {
    // ESM is strict mode: assignment to a frozen property must throw.
    ;(a as { isGenerating: boolean }).isGenerating = !original
  }, TypeError)

  const c = engine.getSessionView('ses_isolation')
  assert.equal(c.isGenerating, original)
  assert.equal(c, a)
})

test('createSessionEngine yields isolated engines for multi-tenant tests (JOE-872)', () => {
  const left = createSessionEngine()
  const right = createSessionEngine()
  assert.notEqual(left, right)
  left.activateSession('only-left')
  left.applyStreamEvent({
    type: 'busy',
    sessionId: 'only-left',
    data: { type: 'busy' },
  } as never)
  assert.equal(left.getSessionView('only-left').isGenerating, true)
  assert.equal(right.getSessionView('only-left').isGenerating, false)
})
