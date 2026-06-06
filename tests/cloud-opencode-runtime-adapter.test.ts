import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createCloudPathProvider } from '../apps/desktop/src/main/cloud/path-provider.ts'
import { createSdkCloudRuntimeAdapter } from '../apps/desktop/src/main/cloud/runtime-adapter.ts'
import {
  buildNodeOpencodeCloudRuntimeClientConfig,
  createNodeOpencodeCloudRuntimeAdapter,
  subscribeToOpencodeCloudRuntimeEvents,
  translateOpencodeRuntimeEvent,
  translateOpencodeRuntimeEventWithDiagnostics,
} from '../apps/desktop/src/main/cloud/opencode-runtime-adapter.ts'

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
    session: {
      async create() {
        return {
          data: {
            id: 'ses_1',
            title: 'Session',
            time: { created: Date.now(), updated: Date.now() },
          },
        }
      },
      async promptAsync(input) {
        promptInputs.push(input)
      },
      async abort() {},
    },
  })

  await adapter.promptSession({
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
      parts,
      agent: 'build',
    },
    {
      sessionID: 'ses_1',
      parts,
      agent: 'build',
      messageID: 'msg_valid',
    },
  ])
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

test('cloud OpenCode runtime subscription translates stream events and reports failures', async () => {
  const delivered: unknown[] = []
  const errors: unknown[] = []
  const dropped: unknown[] = []
  const client = {
    event: {
      async subscribe() {
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
          })(),
        }
      },
    },
  }

  subscribeToOpencodeCloudRuntimeEvents(
    client,
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
})

test('cloud OpenCode runtime subscription does not subscribe after caller cancellation', () => {
  const controller = new AbortController()
  controller.abort()
  let subscribed = false
  const unsubscribe = subscribeToOpencodeCloudRuntimeEvents(
    {
      event: {
        async subscribe() {
          subscribed = true
          return { stream: [] }
        },
      },
    },
    () => undefined,
    { signal: controller.signal },
  )

  unsubscribe()
  assert.equal(subscribed, false)
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
    timeout: 5000,
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
    timeout: 5000,
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
