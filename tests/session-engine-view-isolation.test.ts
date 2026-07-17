import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionEngine } from '@open-cowork/runtime-host/session-engine'

test('getSessionView returns a clone so callers cannot mutate engine state (JOE-868)', () => {
  const engine = createSessionEngine()
  engine.activateSession('ses_isolation')
  engine.applyStreamEvent({
    type: 'busy',
    sessionId: 'ses_isolation',
    data: { type: 'busy' },
  } as never)
  const a = engine.getSessionView('ses_isolation')
  const b = engine.getSessionView('ses_isolation')
  assert.notEqual(a, b)
  const original = a.isGenerating
  a.isGenerating = !original
  const c = engine.getSessionView('ses_isolation')
  assert.equal(c.isGenerating, original)
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
