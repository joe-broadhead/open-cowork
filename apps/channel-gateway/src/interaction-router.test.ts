import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeChannelProvider } from '@open-cowork/gateway-testing'

import type { CloudGateway } from '../dist/index.js'
import { createGatewayMetrics, resolveGatewayConfig as resolveGatewayConfigBase, routeGatewayInteraction } from '../dist/index.js'

const cloudEnv = {
  OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
  OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
}

function resolveGatewayConfig(
  raw: Parameters<typeof resolveGatewayConfigBase>[0] = {},
  env: Parameters<typeof resolveGatewayConfigBase>[1] = {},
) {
  return resolveGatewayConfigBase(raw, {
    ...cloudEnv,
    ...env,
  })
}

function telemetryCount(
  metrics: ReturnType<typeof createGatewayMetrics>,
  outcome: 'attempt' | 'success' | 'retry' | 'error' | 'ignored',
): number {
  const match = metrics.channelTelemetry.renderPrometheus().match(new RegExp(
    `open_cowork_channel_messages_total\\{direction="outbound",outcome="${outcome}",provider_kind="other",schema_version="2",stack="monorepo-provider",surface="cloud-channel-gateway"\\} (\\d+)`,
  ))
  return Number(match?.[1] ?? 0)
}

test('interaction router resolves channel button tokens through cloud and acknowledges provider callback', async () => {
  const provider = new FakeChannelProvider()
  const calls: unknown[] = []
  const cloud = {
    async resolveChannelInteraction(input: unknown) {
      calls.push(input)
      return { interaction: { interactionId: 'interaction-1' }, command: { commandId: 'cmd-1' }, processed: 1 }
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }).providers[0]
  const metrics = createGatewayMetrics()

  const handled = await routeGatewayInteraction({
    cloud,
    provider,
    providerConfig: config,
    metrics,
    message: {
      id: 'message-1',
      provider: 'cli',
      target: {
        provider: 'cli',
        chatId: 'chat-1',
        threadId: 'thread-1',
      },
      sender: {
        providerUserId: 'user-1',
      },
      text: 'token-1',
      rawText: 'token-1',
      isCommand: false,
      attachments: [],
      interaction: {
        id: 'callback-1',
        token: 'apv:token-1',
        kind: 'button',
      },
      receivedAt: new Date(0),
      raw: {},
    },
  })

  assert.equal(handled, true)
  assert.deepEqual(calls, [{
    provider: 'cli',
    externalWorkspaceId: null,
    externalUserId: 'user-1',
    externalChatId: 'chat-1',
    token: 'token-1',
    externalInteractionId: 'callback-1',
    response: { allowed: true },
  }])
  assert.deepEqual(provider.answered, [{
    interactionId: 'callback-1',
    text: 'Approved',
    alert: undefined,
  }])
  assert.equal(metrics.interactionsResolved, 1)
  assert.equal(metrics.providerMetrics.fake?.interactionsResolved, 1)
  assert.equal(telemetryCount(metrics, 'attempt'), 1)
  assert.equal(telemetryCount(metrics, 'success'), 1)
})

test('interaction router records acknowledgement failures as errors without retrying them', async () => {
  const cases = [
    { name: '429', error: Object.assign(new Error('limited'), { status: 429 }) },
    { name: '5xx', error: Object.assign(new Error('unavailable'), { statusCode: 503 }) },
    { name: 'network', error: Object.assign(new Error('socket failed'), { code: 'ECONNRESET' }) },
    { name: '4xx', error: Object.assign(new Error('bad request'), { status: 400 }) },
    { name: 'unknown', error: new Error('provider offline') },
  ] as const
  const config = resolveGatewayConfig({
    server: { adminToken: 'admin-token' },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }).providers[0]
  const cloud = {
    async resolveChannelInteraction() {
      return { interaction: { interactionId: 'interaction-1' }, command: { commandId: 'cmd-1' }, processed: 1 }
    },
  } as CloudGateway

  for (const scenario of cases) {
    const provider = new FakeChannelProvider()
    provider.answerInteraction = async () => {
      throw scenario.error
    }
    const metrics = createGatewayMetrics()
    const handled = await routeGatewayInteraction({
      cloud,
      provider,
      providerConfig: config,
      metrics,
      message: {
        id: `message-${scenario.name}`,
        provider: 'cli',
        target: { provider: 'cli', chatId: 'chat-1' },
        sender: { providerUserId: 'user-1' },
        text: 'token',
        rawText: 'token',
        isCommand: false,
        attachments: [],
        interaction: {
          id: `callback-${scenario.name}`,
          token: 'apv:token',
          kind: 'button',
        },
        receivedAt: new Date(0),
        raw: {},
      },
    })

    assert.equal(handled, true, scenario.name)
    assert.equal(telemetryCount(metrics, 'attempt'), 1, scenario.name)
    assert.equal(telemetryCount(metrics, 'error'), 1, scenario.name)
    assert.equal(telemetryCount(metrics, 'retry'), 0, scenario.name)
  }
})

test('interaction router resolves unrecognized interaction tokens as a denial, never an approval (#874)', async () => {
  const provider = new FakeChannelProvider()
  const calls: unknown[] = []
  const cloud = {
    async resolveChannelInteraction(input: unknown) {
      calls.push(input)
      return { interaction: { interactionId: 'interaction-1' }, command: { commandId: 'cmd-1' }, processed: 1 }
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }).providers[0]
  const metrics = createGatewayMetrics()

  // No apv:/den:/ans:/rej: prefix → parseGatewayInteractionToken falls back to 'default'. The safe
  // resolution for an unparseable approval token is deny (fail closed), not an implicit approval.
  const handled = await routeGatewayInteraction({
    cloud,
    provider,
    providerConfig: config,
    metrics,
    message: {
      id: 'message-1',
      provider: 'cli',
      target: {
        provider: 'cli',
        chatId: 'chat-1',
        threadId: 'thread-1',
      },
      sender: {
        providerUserId: 'user-1',
      },
      text: 'token-1',
      rawText: 'token-1',
      isCommand: false,
      attachments: [],
      interaction: {
        id: 'callback-1',
        token: 'mystery:token-1',
        kind: 'button',
      },
      receivedAt: new Date(0),
      raw: {},
    },
  })

  assert.equal(handled, true)
  assert.deepEqual(calls, [{
    provider: 'cli',
    externalWorkspaceId: null,
    externalUserId: 'user-1',
    externalChatId: 'chat-1',
    token: 'mystery:token-1',
    externalInteractionId: 'callback-1',
    response: { allowed: false },
  }])
  assert.deepEqual(provider.answered, [{
    interactionId: 'callback-1',
    text: 'Denied',
    alert: undefined,
  }])
})

test('interaction router resolves deny, answer, and reject fallback commands through cloud', async () => {
  const provider = new FakeChannelProvider()
  const calls: unknown[] = []
  const cloud = {
    async resolveChannelInteraction(input: unknown) {
      calls.push(input)
      return { interaction: { interactionId: 'interaction-1' }, command: { commandId: 'cmd-1' }, processed: 1 }
    },
  } as CloudGateway
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }).providers[0]
  const metrics = createGatewayMetrics()

  for (const [text, expected] of [
    ['/deny deny-token', { response: { allowed: false } }],
    ['/answer answer-token Ship it', { answers: ['Ship it'] }],
    ['/reject reject-token', { reject: true }],
  ] as const) {
    const handled = await routeGatewayInteraction({
      cloud,
      provider,
      providerConfig: config,
      metrics,
      message: {
        id: `message-${calls.length + 1}`,
        provider: 'cli',
        target: { provider: 'cli', chatId: 'chat-1' },
        sender: { providerUserId: 'user-1' },
        text,
        rawText: text,
        isCommand: true,
        command: text.split(/\s+/)[0]?.slice(1),
        commandArgs: text.split(/\s+/).slice(1).join(' '),
        attachments: [],
        receivedAt: new Date(0),
        raw: {},
      },
    })
    assert.equal(handled, true)
    assert.deepEqual(calls.at(-1), {
      provider: 'cli',
      externalWorkspaceId: null,
      externalUserId: 'user-1',
      externalChatId: 'chat-1',
      token: text.split(/\s+/)[1],
      externalInteractionId: `message-${calls.length}`,
      ...expected,
    })
  }
  assert.equal(metrics.interactionsResolved, 3)
  assert.equal(metrics.providerMetrics.fake?.interactionsResolved, 3)
})

test('interaction router ignores ordinary channel messages', async () => {
  const provider = new FakeChannelProvider()
  const cloud = {} as CloudGateway
  const config = resolveGatewayConfig({
    cloud: {
      baseUrl: 'https://cloud.example.test',
      serviceToken: 'service-token',
    },
    server: {
      adminToken: 'admin-token',
    },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: 'fake-binding',
    }],
  }).providers[0]
  const handled = await routeGatewayInteraction({
    cloud,
    provider,
    providerConfig: config,
    metrics: createGatewayMetrics(),
    message: {
      id: 'message-1',
      provider: 'cli',
      target: { provider: 'cli', chatId: 'chat-1' },
      sender: { providerUserId: 'user-1' },
      text: 'hello',
      rawText: 'hello',
      isCommand: false,
      attachments: [],
      receivedAt: new Date(0),
      raw: {},
    },
  })

  assert.equal(handled, false)
})
