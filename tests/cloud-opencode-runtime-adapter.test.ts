import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'
import {
  createSdkCloudRuntimeAdapter,
  type CloudRuntimeEvent,
} from '@open-cowork/cloud-server/runtime-adapter'
import {
  buildNodeOpencodeCloudRuntimeClientConfig,
  createNodeOpencodeCloudRuntimeAdapter,
  subscribeToOpencodeCloudRuntimeEvents,
  translateOpencodeRuntimeEvent,
  translateOpencodeRuntimeEventWithDiagnostics,
} from '@open-cowork/cloud-server/opencode-runtime-adapter'
import {
  CLOUD_SESSION_SSE_MAX_BUFFERED_BYTES,
  RUNTIME_EVENT_MAX_DEPTH,
  RUNTIME_EVENT_REDACTED,
  RUNTIME_EVENT_TRUNCATED,
} from '@open-cowork/shared'

const MANAGED_RUNTIME_START_TIMEOUT_MS = 15_000

function idleEventId(sessionId: string, admissionId: string) {
  const key = createHash('sha256').update(admissionId).digest('hex').slice(0, 32)
  return `opencode:${sessionId}:idle:${key}`
}

async function* waitForAbortStream(signal?: AbortSignal): AsyncGenerator<unknown> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve()
    else signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  yield* []
}

function writeExecutable(root: string, name: string, source: string) {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\n${source}`)
  chmodSync(path, 0o755)
  return path
}

test('cloud SDK runtime adapter only forwards native OpenCode message ids', async () => {
  const promptInputs: unknown[] = []
  const parts = [{ type: 'text' as const, text: 'hello' }]
  const adapter = createSdkCloudRuntimeAdapter({
    v2: {
      session: {
        async get() {
          return { data: { data: { id: 'ses_1', agent: 'build', time: { created: 1, updated: 1 } } } }
        },
        async switchAgent() {},
        async switchModel() {},
        async prompt(input) {
          promptInputs.push(input)
          return { data: { data: { id: 'input-1', sessionID: 'ses_1', admittedSeq: 7 } } }
        },
        async create() {
          return { data: { data: { id: 'ses_1', title: 'Session', time: { created: 1, updated: 1 } } } }
        },
        async interrupt() {},
      },
    },
  } as any, { directory: '/workspace' })

  const admission = await adapter.promptSession({
    sessionId: 'ses_1',
    parts,
    agent: 'build',
    messageId: 'cmd-1',
  })
  await adapter.promptSession({
    sessionId: 'ses_1',
    parts,
    agent: 'build',
    messageId: 'msg_valid',
  })

  assert.deepEqual(promptInputs, [
    {
      sessionID: 'ses_1',
      prompt: { text: 'hello' },
      delivery: 'queue',
      resume: true,
    },
    {
      sessionID: 'ses_1',
      id: 'msg_valid',
      prompt: { text: 'hello' },
      delivery: 'queue',
      resume: true,
    },
  ])
  assert.deepEqual(admission, { admissionId: 'input-1', admittedSequence: 7 })
})

test('cloud OpenCode event translator maps SDK message, status, idle, and error events', () => {
  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'message.part.updated.1',
      data: {
        sessionID: 'session-1',
        messageID: 'message-1',
        role: 'assistant',
        part: {
          id: 'part-1',
          type: 'text',
          text: 'hello from opencode',
        },
      },
    },
  }), [{
    type: 'assistant.message',
    payload: {
      sessionId: 'session-1',
      messageId: 'message-1',
      content: 'hello from opencode',
    },
  }])

  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: { type: 'busy' },
      },
    },
  }), [{
    type: 'session.status',
    payload: {
      sessionId: 'session-1',
      statusType: 'busy',
    },
  }])

  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'session.idle',
      properties: { sessionID: 'session-1' },
    },
  }), [{
    type: 'session.idle',
    payload: { sessionId: 'session-1' },
  }])

  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { message: 'provider failed' },
      },
    },
  }), [{
    type: 'runtime.error',
    payload: {
      sessionId: 'session-1',
      message: 'provider failed',
    },
  }])

  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'session.next.step.failed',
      properties: {
        sessionID: 'session-1',
        error: { message: 'step failed' },
      },
    },
  }), [{
    type: 'runtime.error',
    payload: {
      sessionId: 'session-1',
      message: 'step failed',
    },
  }])
})

test('native step settlement defers terminal projection to canonical session.idle', () => {
  assert.deepEqual(translateOpencodeRuntimeEvent({
    type: 'session.next.step.ended',
    data: {
      sessionID: 'session-1',
      assistantMessageID: 'assistant-1',
      finish: 'stop',
      cost: 0.25,
      tokens: { input: 3, output: 5 },
    },
  }).map((event) => event.type), ['cost.updated'])

  assert.deepEqual(translateOpencodeRuntimeEvent({
    type: 'session.idle',
    data: { sessionID: 'session-1' },
  }).map((event) => event.type), ['session.idle'])
})

test('cloud OpenCode event translator ignores user text echoes', () => {
  const raw = {
    payload: {
      type: 'message.part.updated.1',
      data: {
        sessionID: 'session-1',
        messageID: 'message-1',
        role: 'user',
        part: {
          id: 'part-1',
          type: 'text',
          text: 'user echo',
        },
      },
    },
  }
  assert.deepEqual(translateOpencodeRuntimeEvent(raw), [])
  assert.deepEqual(translateOpencodeRuntimeEventWithDiagnostics(raw).dropped, {
    sdkEventType: 'message.part.updated',
    reason: 'no-projected-events',
  })
})

test('cloud OpenCode event translator reports unknown and invalid SDK events', () => {
  assert.deepEqual(translateOpencodeRuntimeEventWithDiagnostics({
    payload: {
      type: 'sdk.future.event',
      properties: { sessionID: 'session-1' },
    },
  }), {
    events: [],
    dropped: {
      sdkEventType: 'sdk.future.event',
      reason: 'unknown-event-type',
    },
  })

  assert.deepEqual(translateOpencodeRuntimeEventWithDiagnostics({
    payload: { data: { sessionID: 'session-1' } },
  }), {
    events: [],
    dropped: {
      sdkEventType: null,
      reason: 'invalid-envelope',
    },
  })
})

test('cloud OpenCode event translator preserves projection-critical runtime events', () => {
  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'permission.asked',
      properties: {
        sessionID: 'session-1',
        permission: {
          id: 'permission-1',
          tool: 'bash',
          input: { command: 'git status' },
        },
      },
    },
  }), [{
    type: 'permission.requested',
    payload: {
      permissionId: 'permission-1',
      id: 'permission-1',
      sessionId: 'session-1',
      sourceSessionId: 'session-1',
      tool: 'bash',
      input: { command: 'git status' },
      description: 'bash',
    },
  }])

  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'question.asked',
      properties: {
        sessionID: 'session-1',
        id: 'question-1',
        questions: [{
          header: 'Pick',
          question: 'Proceed?',
          options: [{ label: 'Yes', description: 'Continue' }],
        }],
        tool: { messageID: 'message-1', callID: 'call-1' },
      },
    },
  }), [{
    type: 'question.asked',
    payload: {
      requestId: 'question-1',
      id: 'question-1',
      sessionId: 'session-1',
      sourceSessionId: 'session-1',
      questions: [{
        header: 'Pick',
        question: 'Proceed?',
        options: [{ label: 'Yes', description: 'Continue' }],
        multiple: false,
        custom: true,
      }],
      tool: { messageId: 'message-1', callId: 'call-1' },
    },
  }])

  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'message.part.updated',
      data: {
        sessionID: 'session-1',
        part: {
          id: 'part-1',
          callID: 'tool-call-1',
          type: 'tool',
          tool: 'read',
          state: {
            input: { file: 'README.md' },
            output: 'contents',
            status: 'completed',
          },
        },
      },
    },
  }), [{
    type: 'tool.call',
    payload: {
      sessionId: 'session-1',
      id: 'tool-call-1',
      name: 'read',
      input: { file: 'README.md' },
      status: 'complete',
      output: 'contents',
    },
  }])

  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'todo.updated',
      properties: {
        sessionID: 'session-1',
        todos: [{ content: 'Ship sync', status: 'in_progress', priority: 'high', id: 'todo-1' }],
      },
    },
  }), [{
    type: 'todos.updated',
    payload: {
      sessionId: 'session-1',
      todos: [{ id: 'todo-1', content: 'Ship sync', status: 'in_progress', priority: 'high' }],
    },
  }])
})

test('cloud OpenCode tool events are recursively redacted and bounded before persistence', () => {
  const syntheticApiKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz012345'].join('-')
  const deep: Record<string, unknown> = {}
  let cursor = deep
  for (let index = 0; index < RUNTIME_EVENT_MAX_DEPTH + 5; index += 1) {
    cursor.next = {}
    cursor = cursor.next as Record<string, unknown>
  }
  const [translated] = translateOpencodeRuntimeEvent({
    payload: {
      type: 'session.next.tool.failed',
      properties: {
        sessionID: 'session-1',
        callID: 'call-1',
        tool: 'custom',
        input: {
          nested: { authorization: 'Bearer deeply-secret' },
          path: '/var/lib/open-cowork/private/input.txt',
        },
        result: {
          apiKey: syntheticApiKey,
          deep,
          huge: 'x'.repeat(2 * 1_024 * 1_024),
          file: { type: 'file', url: 'https://files.example/private', content: 'private file' },
        },
        error: { clientSecret: 'nested-client-secret', message: 'failed' },
      },
    },
  })

  assert.ok(translated)
  const serialized = JSON.stringify(translated)
  assert.ok(Buffer.byteLength(serialized, 'utf8') < CLOUD_SESSION_SSE_MAX_BUFFERED_BYTES)
  assert.equal(serialized.includes('deeply-secret'), false)
  assert.equal(serialized.includes('abcdefghijklmnopqrstuvwxyz012345'), false)
  assert.equal(serialized.includes('nested-client-secret'), false)
  assert.equal(serialized.includes('/var/lib/open-cowork/private'), false)
  assert.equal(serialized.includes('private file'), false)
  assert.equal(serialized.includes(RUNTIME_EVENT_TRUNCATED), true)
  const input = translated.payload.input as Record<string, unknown>
  assert.deepEqual(input.nested, { authorization: RUNTIME_EVENT_REDACTED })
})

test('cloud OpenCode permission inputs are sanitized before projection', () => {
  const [translated] = translateOpencodeRuntimeEvent({
    payload: {
      type: 'permission.asked',
      properties: {
        sessionID: 'session-1',
        permission: {
          id: 'permission-1',
          tool: 'bash',
          input: {
            authorization: 'Bearer permission-secret',
            connection: 'postgresql://runtime-user:runtime-password@127.0.0.1/open_cowork',
            path: '/Volumes/Private/project/script.sh',
          },
        },
      },
    },
  })

  const serialized = JSON.stringify(translated)
  assert.equal(serialized.includes('permission-secret'), false)
  assert.equal(serialized.includes('runtime-user'), false)
  assert.equal(serialized.includes('runtime-password'), false)
  assert.equal(serialized.includes('/Volumes/Private'), false)
  assert.equal(
    ((translated?.payload.input as Record<string, unknown>).authorization),
    RUNTIME_EVENT_REDACTED,
  )
})

test('cloud OpenCode runtime adapter streams message.part.delta as append-mode assistant text', () => {
  assert.deepEqual(translateOpencodeRuntimeEvent({
    payload: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'msg-1',
        partID: 'part-1',
        field: 'text',
        delta: 'Hello',
      },
    },
  }), [{
    type: 'assistant.message',
    payload: {
      sessionId: 'session-1',
      messageId: 'msg-1',
      content: 'Hello',
      mode: 'append',
    },
  }])

  // Non-text streaming fields (reasoning, tool input) are not surfaced as
  // assistant message content.
  const reasoning = translateOpencodeRuntimeEventWithDiagnostics({
    payload: {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'msg-1',
        partID: 'part-1',
        field: 'reasoning',
        delta: 'thinking',
      },
    },
  })
  assert.deepEqual(reasoning.events, [])
  assert.equal(reasoning.dropped?.reason, 'no-projected-events')
})

test('cloud OpenCode runtime subscription translates stream events and reports failures', async () => {
  const delivered: unknown[] = []
  const errors: unknown[] = []
  const dropped: unknown[] = []
  const client = {
    v2: {
      event: {
        async subscribe({ signal }: { signal?: AbortSignal } = {}) {
          return {
            stream: (async function* stream() {
            yield {
              payload: {
                type: 'message.part.updated',
                data: {
                  sessionID: 'session-1',
                  messageID: 'message-1',
                  part: {
                    id: 'part-1',
                    type: 'text',
                    text: 'streamed answer',
                  },
                },
              },
            }
            yield {
              payload: {
                type: 'sdk.future.event',
                properties: {
                  sessionID: 'session-1',
                },
              },
            }
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve()
              else signal?.addEventListener('abort', () => resolve(), { once: true })
            })
            })(),
          }
        }
      },
    },
  }

  const unsubscribe = subscribeToOpencodeCloudRuntimeEvents(
    client as any,
    (event) => delivered.push(event),
    {
      onError: (error) => errors.push(error),
      onDroppedEvent: (event) => dropped.push(event),
    },
  )

  for (let attempt = 0; (delivered.length === 0 || dropped.length === 0) && attempt < 20; attempt += 1) {
    await delay(10)
  }

  assert.deepEqual(delivered, [{
    type: 'assistant.message',
    payload: {
      sessionId: 'session-1',
      messageId: 'message-1',
      content: 'streamed answer',
    },
  }])
  assert.deepEqual(dropped, [{
    sdkEventType: 'sdk.future.event',
    reason: 'unknown-event-type',
  }])
  assert.deepEqual(errors, [])
  unsubscribe()
})

test('cloud OpenCode runtime subscription reconnects after transient stream failure', async () => {
  let subscribeCount = 0
  const errors: unknown[] = []
  const delivered: CloudRuntimeEvent[] = []
  const client = {
    v2: {
      event: {
        async subscribe({ signal }: { signal?: AbortSignal } = {}) {
          subscribeCount += 1
          if (subscribeCount === 1) throw new Error('transient event stream failure')
          return {
            stream: (async function* stream() {
              yield {
                payload: {
                  type: 'session.status',
                  properties: { sessionID: 'session-1', status: { type: 'busy' } },
                },
              }
              await new Promise<void>((resolve) => {
                if (signal?.aborted) resolve()
                else signal?.addEventListener('abort', () => resolve(), { once: true })
              })
            })(),
          }
        },
      },
    },
  }

  const unsubscribe = subscribeToOpencodeCloudRuntimeEvents(
    client as any,
    (event) => { delivered.push(event) },
    { onError: (error) => { errors.push(error) } },
  )

  for (let attempt = 0; delivered.length === 0 && attempt < 100; attempt += 1) await delay(10)
  assert.equal(subscribeCount, 2)
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /transient event stream failure/)
  assert.deepEqual(delivered, [{
    type: 'session.status',
    payload: { sessionId: 'session-1', statusType: 'busy' },
  }])
  unsubscribe()
})

test('cloud OpenCode runtime subscription replays tracked V2 session events from the persisted aggregate cursor', async () => {
  const delivered: CloudRuntimeEvent[] = []
  const errors: unknown[] = []
  const afterValues: Array<string | undefined> = []
  let durableSubscribeCount = 0
  const durableTextEvent = (sequence: number, text: string) => ({
    id: `event-${sequence}`,
    type: 'session.next.text.ended',
    durable: { aggregateID: 'session-1', seq: sequence, version: sequence },
    data: {
      timestamp: sequence,
      sessionID: 'session-1',
      assistantMessageID: `message-${sequence}`,
      text,
    },
  })
  const client = {
    v2: {
      event: {
        async subscribe({ signal }: { signal?: AbortSignal } = {}) {
          return {
            stream: waitForAbortStream(signal),
          }
        },
      },
      session: {
        async events(parameters: { sessionID: string, after?: string }, options: { signal?: AbortSignal }) {
          assert.equal(parameters.sessionID, 'session-1')
          afterValues.push(parameters.after)
          durableSubscribeCount += 1
          if (durableSubscribeCount === 1) {
            return {
              stream: (async function* stream() {
                yield durableTextEvent(1, 'before disconnect')
                throw new Error('durable stream disconnected')
              })(),
            }
          }
          return {
            stream: (async function* stream() {
              yield durableTextEvent(2, 'replayed after disconnect')
              yield* waitForAbortStream(options.signal)
            })(),
          }
        },
      },
    },
  }

  const subscription = subscribeToOpencodeCloudRuntimeEvents(
    client as any,
    async (event) => { delivered.push(event) },
    { onError: (error) => { errors.push(error) } },
  )
  subscription.trackSession('session-1')

  for (let attempt = 0; delivered.length < 2 && attempt < 100; attempt += 1) await delay(10)
  assert.equal(durableSubscribeCount, 2)
  assert.deepEqual(afterValues, [undefined, '1'])
  assert.deepEqual(delivered.map((event) => ({
    eventId: event.eventId,
    content: event.payload.content,
  })), [
    { eventId: 'opencode:session-1:1:0', content: 'before disconnect' },
    { eventId: 'opencode:session-1:2:0', content: 'replayed after disconnect' },
  ])
  assert.equal(errors.some((error) => String(error).includes('durable stream disconnected')), true)
  subscription()
})

test('cloud OpenCode reconnect recovers missed children and suppresses an unknown child first-event duplicate/terminal', async () => {
  const delivered: CloudRuntimeEvent[] = []
  let globalSubscriptions = 0
  let listCalls = 0
  const textEvent = (sessionID: string, sequence: number, text: string) => ({
    id: `${sessionID}-${sequence}`,
    type: 'session.next.text.ended',
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    data: { sessionID, assistantMessageID: `${sessionID}-message`, textID: 'text-1', text, timestamp: sequence },
  })
  const client = {
    v2: {
      event: {
        async subscribe({ signal }: { signal?: AbortSignal } = {}) {
          globalSubscriptions += 1
          if (globalSubscriptions === 1) {
            return {
              stream: (async function* disconnectedStream() {
                yield* []
                throw new Error('global stream disconnected')
              })(),
            }
          }
          return {
            stream: (async function* reconnectedStream() {
              yield textEvent('child-first-event', 1, 'replayed first event')
              yield { payload: { type: 'session.idle', properties: { sessionID: 'child-first-event' } } }
              yield* waitForAbortStream(signal)
            })(),
          }
        },
      },
      session: {
        async list() {
          listCalls += 1
          return {
            data: {
              data: listCalls === 1
                ? [{ id: 'root-session' }]
                : [{ id: 'root-session' }, { id: 'child-missed-gap', parentID: 'root-session' }],
              cursor: {},
            },
          }
        },
        async events(parameters: { sessionID: string }, options: { signal?: AbortSignal }) {
          if (parameters.sessionID === 'root-session') return { stream: waitForAbortStream(options.signal) }
          const text = parameters.sessionID === 'child-missed-gap' ? 'missed during gap' : 'replayed first event'
          return {
            stream: (async function* childStream() {
              yield textEvent(parameters.sessionID, 1, text)
              yield* waitForAbortStream(options.signal)
            })(),
          }
        },
      },
    },
  }

  const subscription = subscribeToOpencodeCloudRuntimeEvents(
    client as any,
    async (event) => { delivered.push(event) },
  )
  subscription.trackSession('root-session')
  for (let attempt = 0; delivered.filter((event) => event.type === 'assistant.message').length < 2 && attempt < 100; attempt += 1) {
    await delay(10)
  }

  assert.ok(globalSubscriptions >= 2)
  assert.ok(listCalls >= 2, 'a fresh descendant scan must run after the global gap')
  assert.deepEqual(
    delivered.filter((event) => event.type === 'assistant.message').map((event) => event.payload.content).sort(),
    ['missed during gap', 'replayed first event'],
  )
  assert.equal(delivered.some((event) => event.type === 'session.idle'), false)
  subscription()
})

test('cloud OpenCode runtime subscription retries transient wait failures then detects the typed 1.17.20 fallback once', async () => {
  const delivered: CloudRuntimeEvent[] = []
  const errors: unknown[] = []
  let waitCalls = 0
  let activeCalls = 0
  let historyCalls = 0
  const client = {
    v2: {
      event: {
        async subscribe({ signal }: { signal?: AbortSignal } = {}) {
          return { stream: waitForAbortStream(signal) }
        },
      },
      session: {
        async events(_parameters: unknown, options: { signal?: AbortSignal }) {
          return { stream: waitForAbortStream(options.signal) }
        },
        async wait() {
          waitCalls += 1
          if (waitCalls === 1) throw new Error('transient wait transport failure')
          throw {
            _tag: 'ServiceUnavailableError',
            service: 'session.wait',
            message: 'Session wait is not available yet',
          }
        },
        async active() {
          activeCalls += 1
          return {
            data: {
              data: activeCalls === 1 ? { 'child-session': { type: 'running' } } : {},
            },
          }
        },
        async history() {
          historyCalls += 1
          return { data: { data: [], hasMore: false } }
        },
      },
    },
  }

  const subscription = subscribeToOpencodeCloudRuntimeEvents(
    client as any,
    async (event) => { delivered.push(event) },
    { onError: (error) => { errors.push(error) } },
  )
  subscription.markSessionAdmitted('session-1', 'command-1', 7)

  for (let attempt = 0; delivered.length === 0 && attempt < 100; attempt += 1) await delay(10)
  assert.deepEqual(delivered, [{
    eventId: idleEventId('session-1', 'command-1'),
    type: 'session.idle',
    payload: { sessionId: 'session-1' },
  }])
  assert.equal(waitCalls, 2, 'a transport error must not permanently disable session.wait')
  assert.equal(activeCalls, 2, 'an active child must keep the product root run open')
  assert.equal(historyCalls, 2, 'terminal delivery must reconcile root and child durable history first')
  assert.equal(errors.length, 2, 'the transient error and typed capability fallback are each reported once')
  assert.match(String(errors[0]), /transient wait transport failure/)
  subscription()
})

test('cloud OpenCode runtime subscription drains active children after a successful root wait', async () => {
  const delivered: CloudRuntimeEvent[] = []
  let waitCalls = 0
  let activeCalls = 0
  let historyCalls = 0
  const client = {
    v2: {
      event: {
        async subscribe({ signal }: { signal?: AbortSignal } = {}) {
          return { stream: waitForAbortStream(signal) }
        },
      },
      session: {
        async events(_parameters: unknown, options: { signal?: AbortSignal }) {
          return { stream: waitForAbortStream(options.signal) }
        },
        async wait() {
          waitCalls += 1
          return { data: { data: { id: 'session-1', status: 'idle' } } }
        },
        async active() {
          activeCalls += 1
          return {
            data: {
              data: activeCalls === 1 ? { 'child-session': { type: 'running' } } : {},
            },
          }
        },
        async history() {
          historyCalls += 1
          return { data: { data: [], hasMore: false } }
        },
      },
    },
  }

  const subscription = subscribeToOpencodeCloudRuntimeEvents(
    client as any,
    async (event) => { delivered.push(event) },
  )
  subscription.markSessionAdmitted('session-1', 'command-1', 7)

  for (let attempt = 0; delivered.length === 0 && attempt < 100; attempt += 1) await delay(10)
  assert.deepEqual(delivered, [{
    eventId: idleEventId('session-1', 'command-1'),
    type: 'session.idle',
    payload: { sessionId: 'session-1' },
  }])
  assert.equal(waitCalls, 2, 'root wait must be repeated while a delegated child remains active')
  assert.equal(activeCalls, 2, 'successful root wait must still verify process-wide quiescence')
  assert.equal(historyCalls, 2, 'root and discovered child histories must reconcile before idle')
  subscription()
})

test('cloud OpenCode synthetic terminal ids remain unique and retry-stable across adapter rebuilds', async () => {
  const settleInFreshAdapter = async (admissionId: string) => {
    const delivered: CloudRuntimeEvent[] = []
    const client = {
      v2: {
        event: {
          async subscribe({ signal }: { signal?: AbortSignal } = {}) {
            return { stream: waitForAbortStream(signal) }
          },
        },
        session: {
          async events(_parameters: unknown, options: { signal?: AbortSignal }) {
            return { stream: waitForAbortStream(options.signal) }
          },
          async wait() {
            throw Object.assign(new Error('wait unavailable'), {
              _tag: 'ServiceUnavailableError',
              service: 'session.wait',
            })
          },
          async active() {
            return { data: { data: {} } }
          },
          async history() {
            return { data: { data: [], hasMore: false } }
          },
        },
      },
    }
    const subscription = subscribeToOpencodeCloudRuntimeEvents(
      client as any,
      async (event) => { delivered.push(event) },
    )
    subscription.markSessionAdmitted('session-1', admissionId)
    for (let attempt = 0; delivered.length === 0 && attempt < 50; attempt += 1) await delay(10)
    subscription()
    assert.equal(delivered.length, 1)
    return delivered[0]!.eventId
  }

  const firstCommand = await settleInFreshAdapter('command-1')
  const secondCommand = await settleInFreshAdapter('command-2')
  const retriedSecondCommand = await settleInFreshAdapter('command-2')
  assert.notEqual(firstCommand, secondCommand, 'generation reset must not collide for a later command')
  assert.equal(secondCommand, retriedSecondCommand, 'the same admitted command remains idempotent after rebuild')
})

test('cloud OpenCode runtime subscription does not subscribe after caller cancellation', () => {
  const controller = new AbortController()
  controller.abort()
  let subscribed = false
  const unsubscribe = subscribeToOpencodeCloudRuntimeEvents(
    {
      v2: {
        event: {
          async subscribe() {
            subscribed = true
            return { stream: [] }
          },
        },
      },
    } as any,
    () => undefined,
    { signal: controller.signal },
  )

  unsubscribe()
  assert.equal(subscribed, false)
})

test('cloud OpenCode runtime subscription applies listener backpressure', async () => {
  let pulled = 0
  let releaseFirst: (() => void) | null = null
  const firstDelivery = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const delivered: string[] = []
  const client = {
    v2: {
      event: {
        async subscribe() {
          return {
            stream: (async function* stream() {
              for (const sessionID of ['session-1', 'session-2']) {
                pulled += 1
                yield {
                  payload: {
                    type: 'session.status',
                    properties: { sessionID, status: { type: 'busy' } },
                  },
                }
              }
            })(),
          }
        },
      },
    },
  }

  const unsubscribe = subscribeToOpencodeCloudRuntimeEvents(client as any, async (event) => {
    delivered.push(String(event.payload.sessionId))
    if (delivered.length === 1) await firstDelivery
  })

  for (let attempt = 0; delivered.length === 0 && attempt < 20; attempt += 1) await delay(10)
  await delay(10)
  assert.equal(pulled, 1)
  assert.deepEqual(delivered, ['session-1'])

  releaseFirst?.()
  for (let attempt = 0; delivered.length < 2 && attempt < 20; attempt += 1) await delay(10)
  assert.equal(pulled, 2)
  assert.deepEqual(delivered, ['session-1', 'session-2'])
  unsubscribe()
})

test('cloud Node OpenCode runtime adapter starts with managed env and client auth', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-cloud-node-runtime-'))
  const pidFile = join(root, 'pid')
  const envFile = join(root, 'env')
  const argsFile = join(root, 'args')
  const executable = writeExecutable(root, 'fake-opencode', `
printf '%s' "$$" > ${JSON.stringify(pidFile)}
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$OPENCODE_SERVER_USERNAME" "$OPENCODE_SERVER_PASSWORD" > ${JSON.stringify(envFile)}
printf '%s\\n' 'opencode server listening on http://127.0.0.1:43230'
while true; do sleep 1; done
`)

  const provider = createCloudPathProvider(join(root, 'cloud-root'))
  const adapter = await createNodeOpencodeCloudRuntimeAdapter({
    paths: provider,
    env: { PATH: process.env.PATH || '' },
    hostname: '127.0.0.1',
    port: 0,
    opencodeBinPath: executable,
    timeout: MANAGED_RUNTIME_START_TIMEOUT_MS,
    config: { logLevel: 'warn' },
  })

  try {
    assert.equal(adapter.url, 'http://127.0.0.1:43230')
    assert.match(readFileSync(argsFile, 'utf8'), /--hostname=127\.0\.0\.1/)
    assert.match(readFileSync(argsFile, 'utf8'), /--port=0/)
    const env = readFileSync(envFile, 'utf8').split('\n')
    assert.equal(env[0], provider.getRuntimeXdgRoots().home)
    assert.equal(env[1], provider.getRuntimeXdgRoots().configHome)
    assert.equal(env[2], provider.getRuntimeXdgRoots().dataHome)
    assert.equal(env[3], adapter.auth.username)
    assert.equal(env[4], adapter.auth.password)
    assert.deepEqual(buildNodeOpencodeCloudRuntimeClientConfig(adapter.url, adapter.auth), {
      baseUrl: adapter.url,
      headers: {
        Authorization: adapter.auth.authorizationHeader,
      },
    })
  } finally {
    await adapter.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloud Node OpenCode runtime adapter can deliver BYOK config without process env plaintext', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-cloud-node-runtime-byok-'))
  const envFile = join(root, 'env')
  const configCopyFile = join(root, 'config-copy')
  const secret = ['sk', 'runtime', 'byok', 'plaintext', '1234567890abcdef1234567890abcdef'].join('-')
  const provider = createCloudPathProvider(join(root, 'cloud-root'))
  const configPath = join(provider.getRuntimeXdgRoots().configHome, 'opencode', 'opencode.json')
  const executable = writeExecutable(root, 'fake-opencode', `
env > ${JSON.stringify(envFile)}
cat ${JSON.stringify(configPath)} > ${JSON.stringify(configCopyFile)} 2>/dev/null || true
printf '%s\\n' 'opencode server listening on http://127.0.0.1:43231'
while true; do sleep 1; done
`)

  const adapter = await createNodeOpencodeCloudRuntimeAdapter({
    paths: provider,
    env: {
      PATH: process.env.PATH || '',
      OPENCODE_CONFIG_CONTENT: `stale ${secret}`,
    },
    hostname: '127.0.0.1',
    port: 0,
    opencodeBinPath: executable,
    timeout: MANAGED_RUNTIME_START_TIMEOUT_MS,
    configDelivery: 'ephemeral-file',
    config: {
      model: 'openrouter/test-model',
      provider: {
        openrouter: {
          name: 'OpenRouter',
          options: {
            apiKey: secret,
          },
        },
      },
    },
  })

  try {
    assert.equal(adapter.url, 'http://127.0.0.1:43231')
    assert.equal(readFileSync(envFile, 'utf8').includes(secret), false)
    assert.equal(readFileSync(envFile, 'utf8').includes('OPENCODE_CONFIG_CONTENT'), false)
    assert.match(readFileSync(configCopyFile, 'utf8'), new RegExp(secret))
    assert.equal(existsSync(configPath), false)
  } finally {
    await adapter.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})
