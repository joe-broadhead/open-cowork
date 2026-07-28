import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionEngine, SessionEngine } from '@open-cowork/runtime-host/session-engine'
import { createStreamEvents } from '../scripts/perf/fixtures.ts'

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

test('getSessionView normalizes provider values without retaining prototypes or functions', () => {
  class ProviderToolInput {
    nested = { path: 'before.md' }
    callback = () => 'provider callback'
    weak = new WeakMap<object, string>()

    inheritedMethod() {
      return 'provider prototype'
    }
  }

  const engine = createSessionEngine()
  const sessionId = 'ses_nonplain_isolation'
  const input = new ProviderToolInput()
  engine.activateSession(sessionId)
  engine.applyStreamEvent({
    type: 'tool_call',
    sessionId,
    data: {
      type: 'tool_call',
      id: 'tool-nonplain',
      name: 'provider-tool',
      input,
      status: 'complete',
    },
  } as never)

  const projectedInput = engine.getSessionView(sessionId).toolCalls[0]?.input as Record<string, unknown> & {
    nested: { path: string }
    weak: Record<string, never>
  }
  assert.notEqual(projectedInput, input)
  assert.equal(Object.getPrototypeOf(projectedInput), Object.prototype)
  assert.equal(Object.isFrozen(projectedInput), true)
  assert.equal(Object.isFrozen(projectedInput.nested), true)
  assert.equal(Object.isFrozen(input), false)
  assert.equal(Object.isFrozen(input.nested), false)
  assert.equal(Object.hasOwn(projectedInput, 'callback'), false)
  assert.equal(Reflect.get(projectedInput, 'inheritedMethod'), undefined)
  assert.notEqual(projectedInput.weak, input.weak)
  assert.equal(Object.getPrototypeOf(projectedInput.weak), Object.prototype)
  assert.deepEqual(projectedInput.weak, {})

  input.nested.path = 'after.md'
  assert.equal(projectedInput.nested.path, 'before.md')
})

test('getSessionView does not invoke provider accessors or retain shared source values', () => {
  const engine = createSessionEngine()
  const sessionId = 'ses_provider_accessors'
  const shared = { path: 'before.md' }
  let accessorReads = 0
  const input: Record<string, unknown> = {
    callback: () => 'not cloneable',
    left: shared,
    right: shared,
  }
  Object.defineProperty(input, 'computed', {
    enumerable: true,
    get() {
      accessorReads += 1
      return shared
    },
  })
  engine.activateSession(sessionId)
  engine.applyStreamEvent({
    type: 'tool_call',
    sessionId,
    data: {
      type: 'tool_call',
      id: 'tool-accessor',
      name: 'provider-tool',
      input,
      status: 'complete',
    },
  } as never)
  accessorReads = 0

  const projectedInput = engine.getSessionView(sessionId).toolCalls[0]?.input as {
    left: { path: string }
    right: { path: string }
    computed?: unknown
  }
  assert.equal(accessorReads, 0)
  assert.equal(Object.hasOwn(projectedInput, 'computed'), false)
  assert.notEqual(projectedInput.left, shared)
  assert.equal(projectedInput.left, projectedInput.right)

  shared.path = 'after.md'
  assert.equal(projectedInput.left.path, 'before.md')
  assert.throws(() => {
    projectedInput.right.path = 'mutated.md'
  }, TypeError)
})

test('getSessionView preserves arbitrary provider keys without changing the clone prototype', () => {
  const engine = createSessionEngine()
  const sessionId = 'ses_provider_proto_key'
  const input = JSON.parse(
    '{"__proto__":{"spoofed":"inherited"},"safe":"own"}',
  ) as Record<string, unknown>
  engine.activateSession(sessionId)
  engine.applyStreamEvent({
    type: 'tool_call',
    sessionId,
    data: {
      type: 'tool_call',
      id: 'tool-proto-key',
      name: 'provider-tool',
      input,
      status: 'complete',
    },
  } as never)

  const projectedInput = engine.getSessionView(sessionId).toolCalls[0]?.input
  assert.equal(Object.getPrototypeOf(projectedInput), Object.prototype)
  assert.equal(Object.hasOwn(projectedInput || {}, '__proto__'), true)
  assert.deepEqual(Reflect.get(projectedInput || {}, '__proto__'), { spoofed: 'inherited' })
  assert.equal(Reflect.get(projectedInput || {}, 'spoofed'), undefined)
  assert.equal(Reflect.get(projectedInput || {}, 'safe'), 'own')
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

test('stream appends only materialize a wall-clock timestamp when the message is created', () => {
  let nowIsoCalls = 0
  const engine = new SessionEngine({
    nowMs: () => 1_800_000_000_000,
    nowIso: () => {
      nowIsoCalls += 1
      return '2027-01-15T08:00:00.000Z'
    },
  })
  const sessionId = 'stream-timestamp-laziness'
  engine.activateSession(sessionId)
  const callsAfterActivation = nowIsoCalls

  for (let index = 0; index < 40; index += 1) {
    engine.applyStreamEvent({
      type: 'text',
      sessionId,
      data: {
        type: 'text',
        role: 'assistant',
        messageId: 'message-1',
        partId: 'part-1',
        content: `chunk-${index} `,
        mode: 'append',
      },
    } as never)
  }

  assert.equal(nowIsoCalls - callsAfterActivation, 1)
  const view = engine.getSessionView(sessionId)
  assert.equal(view.messages.length, 1)
  assert.match(view.messages[0]?.content || '', /chunk-0 .*chunk-39/)
  assert.ok(Object.isFrozen(view.messages[0]))
})

test('mixed stream projection stays complete, deterministic, and immutable', () => {
  const project = () => {
    const engine = new SessionEngine({
      nowMs: () => 1_800_000_000_000,
      nowIso: () => '2027-01-15T08:00:00.000Z',
    })
    const events = createStreamEvents('mixed-stream-contract')
    engine.activateSession('mixed-stream-contract')
    for (const event of events) engine.applyStreamEvent(event as never)
    return engine.getSessionView('mixed-stream-contract')
  }

  const first = project()
  const second = project()
  assert.deepEqual(first, second)
  assert.equal(first.messages.length, 1)
  assert.equal(first.taskRuns.length, 6)
  assert.equal(first.taskRuns.every((taskRun) => taskRun.status === 'complete'), true)
  assert.ok(first.taskRuns.every((taskRun) => taskRun.toolCalls.length === 8))
  assert.ok(first.sessionCost > 0)
  assert.ok(first.sessionTokens.input > 0)
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.taskRuns[0]?.toolCalls[0]))
})
