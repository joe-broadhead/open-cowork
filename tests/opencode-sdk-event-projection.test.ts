import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  translateOpencodeRuntimeEvent,
  translateOpencodeRuntimeEventWithDiagnostics,
} from '@open-cowork/cloud-server/opencode-runtime-adapter'
import {
  CLOUD_SESSION_EVENT_TYPES,
  cloudSessionViewToSessionView,
  createCloudSessionProjectionView,
  reduceCloudSessionProjectionEvent,
} from '../packages/shared/dist/cloud-session-projection.js'

type SdkFixture = {
  name: string
  raw: unknown
  expectedTypes: string[]
}

type DropFixture = {
  name: string
  raw: unknown
  expectedDropped: {
    sdkEventType: string | null
    reason: string
  }
}

type DirectCloudEventFixture = {
  name: string
  event: {
    type: string
    payload: Record<string, unknown>
  }
}

type EventFixtures = {
  sdkEvents: SdkFixture[]
  resolutionEvents: SdkFixture[]
  dropEvents: DropFixture[]
  directCloudEvents: DirectCloudEventFixture[]
}

function loadFixtures(): EventFixtures {
  return JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/opencode-sdk-v2-events.json'), 'utf8')) as EventFixtures
}

function sessionRecord() {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    profileName: 'default',
    status: 'running' as const,
    title: 'SDK fixture session',
    updatedAt: '2026-05-29T10:00:00.000Z',
  }
}

function eventRecord(sequence: number, event: { type: string, payload: Record<string, unknown> }) {
  return {
    sequence,
    type: event.type,
    payload: event.payload,
    createdAt: `2026-05-29T10:${String(sequence).padStart(2, '0')}:00.000Z`,
  }
}

test('SDK v2 event fixtures normalize into the shared cloud projection contract', () => {
  const fixtures = loadFixtures()
  const runtimeFixtures = fixtures.sdkEvents.filter((fixture) => fixture.name !== 'runtime-error')

  for (const fixture of runtimeFixtures) {
    assert.deepEqual(
      translateOpencodeRuntimeEvent(fixture.raw).map((event) => event.type),
      fixture.expectedTypes,
      fixture.name,
    )
  }

  const normalized = runtimeFixtures.flatMap((fixture) => translateOpencodeRuntimeEvent(fixture.raw))
  assert.deepEqual(normalized.map((event) => event.type), [
    'assistant.message',
    'tool.call',
    'permission.requested',
    'question.asked',
    'todos.updated',
    'session.status',
    'cost.updated',
  ])

  const session = sessionRecord()
  let projection = createCloudSessionProjectionView(session)
  ;[
    ...normalized,
    ...fixtures.directCloudEvents.map((fixture) => fixture.event),
  ].forEach((event, index) => {
    assert.equal((CLOUD_SESSION_EVENT_TYPES as readonly string[]).includes(event.type), true, `${event.type} must be a shared cloud event`)
    projection = reduceCloudSessionProjectionEvent(session, projection, eventRecord(index + 1, event))
  })

  assert.deepEqual(projection.messages.map((message) => message.content), ['normalized assistant text'])
  assert.equal(projection.toolCalls[0]?.name, 'bash')
  assert.equal(projection.toolCalls[0]?.status, 'complete')
  assert.equal(projection.pendingApprovals[0]?.id, 'permission-1')
  assert.equal(projection.pendingQuestions[0]?.id, 'question-1')
  assert.equal(projection.pendingQuestions[0]?.tool?.callId, 'tool-call-1')
  assert.deepEqual(projection.todos.map((todo) => todo.content), ['Harden SDK boundary'])
  assert.equal(projection.status, 'idle')
  assert.equal(projection.sessionCost, 0.42)
  assert.equal(projection.sessionTokens.input, 10)
  assert.equal(projection.taskRuns[0]?.id, 'task-1')
  assert.equal(projection.artifacts[0]?.cloudArtifactId, 'artifact-1')

  const desktopView = cloudSessionViewToSessionView({
    session,
    projection: {
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      sequence: normalized.length,
      view: projection,
      updatedAt: projection.updatedAt,
    },
  })
  assert.equal(desktopView.messages[0]?.content, 'normalized assistant text')
  assert.equal(desktopView.pendingApprovals[0]?.id, 'permission-1')
  assert.equal(desktopView.pendingQuestions[0]?.id, 'question-1')
})

test('SDK v2 permission and question resolution fixtures clear shared pending state', () => {
  const session = sessionRecord()
  const fixtures = loadFixtures()
  const rawSdkEvents = [
    fixtures.sdkEvents.find((fixture) => fixture.name === 'permission-requested'),
    fixtures.sdkEvents.find((fixture) => fixture.name === 'question-asked'),
    ...fixtures.resolutionEvents,
  ].filter((fixture): fixture is SdkFixture => Boolean(fixture))

  let projection = createCloudSessionProjectionView(session)
  rawSdkEvents
    .flatMap((fixture) => translateOpencodeRuntimeEvent(fixture.raw))
    .forEach((event, index) => {
      assert.equal((CLOUD_SESSION_EVENT_TYPES as readonly string[]).includes(event.type), true, `${event.type} must be a shared cloud event`)
      projection = reduceCloudSessionProjectionEvent(session, projection, eventRecord(index + 1, event))
    })

  assert.equal(projection.pendingApprovals.length, 0)
  assert.equal(projection.pendingQuestions.length, 0)
})

test('SDK v2 unknown and intentionally dropped events are observable', () => {
  for (const fixture of loadFixtures().dropEvents) {
    const translation = translateOpencodeRuntimeEventWithDiagnostics(fixture.raw)
    assert.deepEqual(translation.events, [], fixture.name)
    assert.deepEqual(translation.dropped, fixture.expectedDropped, fixture.name)
  }
})

test('native /api/event families translate text, tools, steps, permission, and question envelopes', () => {
  const nativeEvents = [
    {
      raw: { type: 'session.next.step.started', data: { sessionID: 'session-1', assistantMessageID: 'assistant-1' } },
      types: ['session.status'],
    },
    {
      raw: { type: 'session.next.text.delta', data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', textID: 'text-1', delta: 'Hello' } },
      types: ['assistant.message'],
    },
    {
      raw: { type: 'session.next.text.ended', data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', textID: 'text-1', text: 'Hello world' } },
      types: ['assistant.message'],
    },
    {
      raw: { type: 'session.next.tool.called', data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', callID: 'call-1', tool: 'read', input: { path: 'README.md' } } },
      types: ['tool.call'],
    },
    {
      raw: { type: 'session.next.tool.success', data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', callID: 'call-1', structured: {}, content: [{ type: 'text', text: 'done' }], provider: { executed: true } } },
      types: ['tool.call'],
    },
    {
      raw: { type: 'session.next.step.ended', data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', finish: 'stop', cost: 0.1, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } },
      types: ['cost.updated', 'session.idle'],
    },
    {
      raw: { type: 'permission.v2.asked', properties: { id: 'permission-native', sessionID: 'session-1', action: 'file.read', resources: ['README.md'] } },
      types: ['permission.requested'],
    },
    {
      raw: { type: 'question.v2.asked', properties: { id: 'question-native', sessionID: 'session-1', questions: [] } },
      types: ['question.asked'],
    },
  ]

  for (const fixture of nativeEvents) {
    assert.deepEqual(translateOpencodeRuntimeEvent(fixture.raw).map((event) => event.type), fixture.types)
  }

  for (const type of ['session.next.reasoning.delta', 'session.next.reasoning.ended']) {
    const translation = translateOpencodeRuntimeEventWithDiagnostics({
      type,
      data: {
        sessionID: 'session-1',
        assistantMessageID: 'assistant-1',
        reasoningID: 'reasoning-1',
        delta: 'private chain of thought',
        text: 'private chain of thought',
      },
    })
    assert.deepEqual(translation.events, [])
    assert.deepEqual(translation.dropped, { sdkEventType: type, reason: 'no-projected-events' })
  }
})

test('native V2 tool follow-up events preserve the called tool identity', () => {
  const session = sessionRecord()

  for (const [eventType, expectedStatus] of [
    ['session.next.tool.progress', 'running'],
    ['session.next.tool.success', 'complete'],
    ['session.next.tool.failed', 'error'],
  ] as const) {
    const rawEvents = [
      {
        type: 'session.next.tool.called',
        data: {
          sessionID: 'session-1',
          assistantMessageID: 'assistant-1',
          callID: 'call-1',
          tool: 'read',
          input: { path: 'README.md' },
        },
      },
      {
        type: eventType,
        data: {
          sessionID: 'session-1',
          assistantMessageID: 'assistant-1',
          callID: 'call-1',
          content: [{ type: 'text', text: 'done' }],
          ...(eventType === 'session.next.tool.failed' ? { error: { message: 'failed' } } : {}),
        },
      },
    ]

    let projection = createCloudSessionProjectionView(session)
    rawEvents
      .flatMap((raw) => translateOpencodeRuntimeEvent(raw))
      .forEach((event, index) => {
        projection = reduceCloudSessionProjectionEvent(session, projection, eventRecord(index + 1, event))
      })

    assert.equal(projection.toolCalls[0]?.name, 'read', eventType)
    assert.deepEqual(projection.toolCalls[0]?.input, { path: 'README.md' }, eventType)
    assert.equal(projection.toolCalls[0]?.status, expectedStatus, eventType)
  }
})
