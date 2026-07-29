import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChannelAdapter,
  ChannelMessage,
} from '../channels/provider.js'
import {
  withChannelEgressTelemetry,
  type ChannelEgressTelemetryRecord,
} from '../channels/egress-telemetry.js'
import {
  clearRuntimeMetricsForTest,
  renderPrometheusMetrics,
} from '../runtime-metrics.js'

function adapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: 'telegram',
    capabilities: {} as ChannelAdapter['capabilities'],
    async start() {},
    async stop() {},
    async sendMessage() {},
    onMessage(_handler: (message: ChannelMessage) => Promise<void>) {},
    ...overrides,
  } as ChannelAdapter
}

function recorder(): {
  records: ChannelEgressTelemetryRecord[]
  record: (record: ChannelEgressTelemetryRecord) => void
} {
  const records: ChannelEgressTelemetryRecord[] = []
  return {
    records,
    record(record) {
      records.push(record)
    },
  }
}

describe('ChannelAdapter egress telemetry', () => {
  afterEach(() => clearRuntimeMetricsForTest())

  it('records one attempt and one successful egress-request latency for the durable-native selection', async () => {
    const sent = vi.fn(async () => undefined)
    const telemetry = recorder()
    const times = [100, 117]
    const channel = withChannelEgressTelemetry(adapter({ sendMessage: sent }), {
      stack: 'durable-native',
      record: telemetry.record,
      now: () => times.shift() ?? 117,
    })

    await channel.sendMessage('chat-1', 'hello', { threadId: 'thread-1' })

    expect(sent).toHaveBeenCalledOnce()
    expect(telemetry.records).toEqual([
      {
        provider: 'telegram',
        stack: 'durable-native',
        direction: 'outbound',
        outcome: 'attempt',
      },
      {
        provider: 'telegram',
        stack: 'durable-native',
        direction: 'outbound',
        outcome: 'success',
        latencyMs: 17,
      },
    ])
  })

  it('records one operation when a monorepo structured send delegates to the raw adapter sendMessage', async () => {
    const rawSend = vi.fn(async () => undefined)
    const telemetry = recorder()
    const raw = adapter({
      sendMessage: rawSend,
      async sendStructuredMessage(chatId, message, options) {
        await this.sendMessage!(chatId, message.fallback.plainText || message.title, options)
      },
    })
    const channel = withChannelEgressTelemetry(raw, {
      stack: 'monorepo-provider',
      record: telemetry.record,
      now: () => 200,
    })

    await channel.sendStructuredMessage?.('chat-2', {
      kind: 'progress',
      title: 'Progress',
      blocks: [],
      fallback: { plainText: 'Still working' },
    })

    expect(rawSend).toHaveBeenCalledOnce()
    expect(telemetry.records).toEqual([
      {
        provider: 'telegram',
        stack: 'monorepo-provider',
        direction: 'outbound',
        outcome: 'attempt',
      },
      {
        provider: 'telegram',
        stack: 'monorepo-provider',
        direction: 'outbound',
        outcome: 'success',
        latencyMs: 0,
      },
    ])
  })

  it('records provider failures as errors because the wrapper does not schedule retries', async () => {
    const transientTelemetry = recorder()
    const transient = withChannelEgressTelemetry(adapter({
      async sendCommandMenu() {
        throw Object.assign(new Error('provider temporarily unavailable'), { status: 503 })
      },
    }), {
      stack: 'durable-native',
      record: transientTelemetry.record,
      now: () => 300,
    })

    await expect(transient.sendCommandMenu?.('chat-3', 'Choose', [])).rejects.toThrow(
      'provider temporarily unavailable',
    )
    expect(transientTelemetry.records.map(({ outcome }) => outcome)).toEqual([
      'attempt',
      'error',
    ])

    const terminalTelemetry = recorder()
    const terminal = withChannelEgressTelemetry(adapter({
      async sendMessage() {
        throw Object.assign(new Error('invalid destination'), { status: 400 })
      },
    }), {
      stack: 'monorepo-provider',
      record: terminalTelemetry.record,
      now: () => 400,
    })

    await expect(terminal.sendMessage('chat-4', 'hello')).rejects.toThrow(
      'invalid destination',
    )
    expect(terminalTelemetry.records.map(({ outcome }) => outcome)).toEqual([
      'attempt',
      'error',
    ])
  })

  it('never infers a retry from provider error details or records those details', async () => {
    const cases: unknown[] = [
      Object.assign(new Error('secret rate limit detail'), { status: 429 }),
      Object.assign(new Error('secret outage detail'), { statusCode: 503 }),
      Object.assign(new Error('secret socket detail'), { code: 'ECONNRESET' }),
      Object.assign(new Error('secret request detail'), { status: 400 }),
      new Error('secret novel provider detail'),
    ]

    for (const failure of cases) {
      const telemetry = recorder()
      const channel = withChannelEgressTelemetry(adapter({
        async sendMessage() {
          throw failure
        },
      }), {
        stack: 'durable-native',
        record: telemetry.record,
        now: () => 500,
      })

      await expect(channel.sendMessage('private-chat-id', 'private body')).rejects.toBe(failure)
      expect(telemetry.records.map((record) => record.outcome)).toEqual(['attempt', 'error'])
      expect(JSON.stringify(telemetry.records)).not.toMatch(
        /secret|private-chat-id|private body|status|code|message/,
      )
    }
  })

  it('renders synthetic durable-native and monorepo-provider operations through the common contract', async () => {
    const native = withChannelEgressTelemetry(adapter(), {
      stack: 'durable-native',
    })
    const monorepo = withChannelEgressTelemetry(adapter({
      name: 'discord',
    }), {
      stack: 'monorepo-provider',
    })

    await native.sendMessage('private-native-id', 'private body')
    await monorepo.sendMessage('private-monorepo-id', 'another private body')

    const metrics = renderPrometheusMetrics()
    expect(metrics).toContain('direction="outbound",outcome="attempt",provider_kind="telegram",schema_version="2",stack="durable-native"')
    expect(metrics).toContain('direction="outbound",outcome="success",provider_kind="discord",schema_version="2",stack="monorepo-provider"')
    expect(metrics).toMatch(/open_cowork_channel_operation_latency_ms_count\{direction="outbound",outcome="success",provider_kind="telegram",schema_version="2"[^}]*\} 1/)
    expect(metrics).not.toMatch(/private-native-id|private-monorepo-id|private body|another private body/)
  })

  it('preserves lifecycle and provider-specific methods while leaving absent optional sends absent', async () => {
    let active = false
    const start = vi.fn(async () => { active = true })
    const stop = vi.fn(async () => { active = false })
    const verifyWebhook = vi.fn(() => 'challenge')
    const raw = Object.assign(adapter({
      start,
      stop,
      isActive: () => active,
    }), { verifyWebhook })
    const channel = withChannelEgressTelemetry(raw, {
      stack: 'durable-native',
      record: recorder().record,
    }) as typeof raw

    await channel.start()

    expect(start).toHaveBeenCalledOnce()
    expect(channel.isActive?.()).toBe(true)
    expect(channel.verifyWebhook()).toBe('challenge')
    expect(channel.sendStructuredMessage).toBeUndefined()
    expect(channel.sendCommandMenu).toBeUndefined()

    await channel.stop()
    expect(stop).toHaveBeenCalledOnce()
    expect(channel.isActive?.()).toBe(false)
  })
})
