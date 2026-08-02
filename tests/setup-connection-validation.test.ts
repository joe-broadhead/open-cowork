import assert from 'node:assert/strict'
import test from 'node:test'
import {
  waitForCompletedSetupAssistant,
  waitForSetupConnectionProvider,
} from '../apps/desktop/src/main/setup/connection-validation.ts'

test('setup connection waits for the selected provider while the V2 catalog warms', async () => {
  let calls = 0
  const provider = await waitForSetupConnectionProvider(async () => {
    calls += 1
    return calls < 3
      ? []
      : [{ id: 'or', name: 'OpenRouter', models: {}, connected: true }]
  }, 'or', { timeoutMs: 100, pollIntervalMs: 1 })

  assert.equal(provider?.id, 'or')
  assert.equal(calls, 3)
})

test('setup connection returns null when the selected provider never becomes ready', async () => {
  const provider = await waitForSetupConnectionProvider(
    async () => [],
    'or',
    { timeoutMs: 5, pollIntervalMs: 1 },
  )

  assert.equal(provider, null)
})

test('setup connection polls V2 messages instead of the unavailable session wait route', async () => {
  let calls = 0
  const assistant = await waitForCompletedSetupAssistant(async () => {
    calls += 1
    if (calls === 1) return [{ type: 'user' }]
    if (calls === 2) {
      return [{
        type: 'assistant',
        model: { providerID: 'or', id: 'deepseek/deepseek-v4-flash' },
        time: { created: 1 },
      }]
    }
    return [{
      type: 'assistant',
      model: { providerID: 'or', id: 'deepseek/deepseek-v4-flash' },
      time: { created: 1, completed: 2 },
      finish: 'stop',
    }]
  }, { timeoutMs: 100, pollIntervalMs: 1 })

  assert.equal(assistant.model.providerID, 'or')
  assert.equal(assistant.finish, 'stop')
  assert.equal(calls, 3)
})

test('setup connection waits through completed tool-call steps for the final assistant', async () => {
  let calls = 0
  const toolCallStep = {
    type: 'assistant',
    model: { providerID: 'or', id: 'deepseek/deepseek-v4-flash' },
    time: { created: 1, completed: 2 },
    finish: 'tool-calls',
  }
  const assistant = await waitForCompletedSetupAssistant(async () => {
    calls += 1
    if (calls === 1) {
      return [{
        type: 'assistant',
        model: { providerID: 'or', id: 'deepseek/deepseek-v4-flash' },
        time: { created: 3 },
      }, toolCallStep]
    }
    return [{
      type: 'assistant',
      model: { providerID: 'or', id: 'deepseek/deepseek-v4-flash' },
      time: { created: 3, completed: 4 },
      finish: 'stop',
    }, toolCallStep]
  }, { timeoutMs: 100, pollIntervalMs: 1 })

  assert.equal(assistant.finish, 'stop')
  assert.equal(calls, 2)
})

test('setup connection reports a bounded message request timeout clearly', async () => {
  const timeout = new Error('synthetic timeout')
  timeout.name = 'TimeoutError'

  await assert.rejects(
    () => waitForCompletedSetupAssistant(async () => {
      throw timeout
    }, { timeoutMs: 100, pollIntervalMs: 1 }),
    /timed out while waiting for the connection check/i,
  )
})

test('setup connection stops polling when OpenCode records an assistant failure', async () => {
  const assistant = await waitForCompletedSetupAssistant(async () => [{
    type: 'assistant',
    model: { providerID: 'or', id: 'deepseek/deepseek-v4-flash' },
    time: { created: 1 },
    error: { type: 'unknown', message: 'synthetic provider failure' },
  }], { timeoutMs: 100, pollIntervalMs: 1 })

  assert.deepEqual(assistant.error, {
    type: 'unknown',
    message: 'synthetic provider failure',
  })
})
