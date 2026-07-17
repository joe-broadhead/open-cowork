import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  classifyOpencodeSdkEvent,
  mapToStandaloneProductKinds,
  normalizeOpencodeEventEnvelope,
  OPENCODE_BENIGN_EVENT_TYPES,
  translateOpencodeEvent,
  translateOpencodeEventForStandalone,
} from '@open-cowork/shared'
import { normalizeRuntimeEventEnvelope } from '@open-cowork/runtime-host'
import { translateOpencodeRuntimeEvent } from '@open-cowork/cloud-server/opencode-runtime-adapter'

type SdkFixture = {
  name: string
  raw: unknown
  expectedTypes: string[]
}

type EventFixtures = {
  sdkEvents: SdkFixture[]
}

function loadFixtures(): EventFixtures {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/opencode-sdk-v2-events.json'), 'utf8'),
  ) as EventFixtures
}

test('JOE-838: runtime-host envelope normalizer delegates to shared translator', () => {
  const raw = {
    payload: {
      type: 'permission.asked',
      properties: { id: 'p1', sessionID: 's1' },
    },
  }
  assert.deepEqual(normalizeRuntimeEventEnvelope(raw), normalizeOpencodeEventEnvelope(raw))
  assert.deepEqual(normalizeOpencodeEventEnvelope(raw), {
    type: 'permission.asked',
    properties: { id: 'p1', sessionID: 's1' },
  })
})

test('JOE-838: stringified SSE payloads normalize like object envelopes', () => {
  const asObject = {
    type: 'question.v2.asked',
    properties: { id: 'q1', sessionID: 's1', questions: [] },
  }
  assert.deepEqual(
    normalizeOpencodeEventEnvelope(JSON.stringify(asObject)),
    normalizeOpencodeEventEnvelope(asObject),
  )
})

test('JOE-838: shared fixtures classify into product kinds (Cloud fan-out agreement)', () => {
  const fixtures = loadFixtures()
  for (const fixture of fixtures.sdkEvents) {
    if (fixture.name === 'runtime-error') continue
    const translation = translateOpencodeEvent(fixture.raw)
    assert.ok(translation.envelope, fixture.name)
    assert.equal(translation.disposition.status, 'project', fixture.name)
    if (translation.disposition.status !== 'project') continue
    assert.deepEqual(
      translation.disposition.kinds,
      fixture.expectedTypes,
      `${fixture.name} product kinds`,
    )
    // Cloud payload fan-out must emit the same product types for critical fixtures.
    assert.deepEqual(
      translateOpencodeRuntimeEvent(fixture.raw).map((event) => event.type),
      fixture.expectedTypes,
      `${fixture.name} cloud agreement`,
    )
  }
})

test('JOE-838: standalone projection shares envelope + classification for channel-critical events', () => {
  const permission = translateOpencodeEventForStandalone({
    type: 'permission.v2.asked',
    properties: { id: 'perm-1', sessionID: 'oc-1', action: 'read' },
  })
  assert.equal(permission.length, 1)
  assert.equal(permission[0]?.type, 'permission.requested')
  assert.equal(permission[0]?.entityId, 'perm-1')

  const toolStarted = translateOpencodeEventForStandalone({
    type: 'session.next.tool.called',
    properties: { callID: 'c1', tool: 'bash' },
  })
  assert.equal(toolStarted[0]?.type, 'tool.started')

  const toolDone = translateOpencodeEventForStandalone({
    type: 'session.next.tool.success',
    properties: { callID: 'c1' },
  })
  assert.equal(toolDone[0]?.type, 'tool.completed')

  const text = translateOpencodeEventForStandalone({
    type: 'session.next.text.ended',
    properties: { text: 'hello channel' },
  })
  assert.equal(text[0]?.type, 'assistant.message')

  // Reasoning stays private across surfaces.
  assert.deepEqual(
    translateOpencodeEventForStandalone({
      type: 'session.next.reasoning.delta',
      properties: { delta: 'secret chain' },
    }),
    [],
  )
  assert.equal(
    classifyOpencodeSdkEvent('session.next.reasoning.delta').status,
    'private',
  )
})

test('JOE-838: benign control-plane types are a frozen shared set', () => {
  assert.ok(OPENCODE_BENIGN_EVENT_TYPES.has('server.connected'))
  assert.equal(classifyOpencodeSdkEvent('server.connected').status, 'benign')
  assert.equal(classifyOpencodeSdkEvent('mcp.unrecognized').status, 'unknown')
})

test('JOE-838: standalone kind map expands tool.call lifecycle only for native tool events', () => {
  const called = classifyOpencodeSdkEvent('session.next.tool.called')
  assert.deepEqual(mapToStandaloneProductKinds('session.next.tool.called', called), ['tool.started'])
  const failed = classifyOpencodeSdkEvent('session.next.tool.failed')
  assert.deepEqual(mapToStandaloneProductKinds('session.next.tool.failed', failed), ['tool.failed'])
})
