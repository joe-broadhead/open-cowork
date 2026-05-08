import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import assert from 'node:assert/strict'
import test from 'node:test'

import { restartRuntimeMcpStatusPolling } from '../apps/desktop/src/main/runtime-mcp-status-polling.ts'

function createFakeMcpClient(status: () => Promise<{ data: unknown }>): OpencodeClient {
  return {
    mcp: {
      status,
      connect: async () => ({}),
    },
  } as unknown as OpencodeClient
}

async function flushPoll() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('runtime MCP status polling publishes the immediate status payload', async () => {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const interval = restartRuntimeMcpStatusPolling({
    client: createFakeMcpClient(async () => ({
      data: {
        charts: { status: 'connected' },
      },
    })),
    runtimeProjectDirectory: null,
    currentInterval: null,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload })
        },
      },
    }) as unknown as BrowserWindow,
    scheduleReconnect: () => assert.fail('reconnect should not be scheduled for a healthy poll'),
  })

  try {
    await flushPoll()
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.channel, 'mcp:status')
    assert.deepEqual(sent[0]?.payload, [
      { name: 'charts', connected: true, rawStatus: 'connected' },
    ])
  } finally {
    clearInterval(interval)
  }
})

test('runtime MCP status polling schedules reconnect when publishing fails', async () => {
  let reconnects = 0
  const interval = restartRuntimeMcpStatusPolling({
    client: createFakeMcpClient(async () => ({
      data: {
        charts: { status: 'connected' },
      },
    })),
    runtimeProjectDirectory: null,
    currentInterval: null,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: () => {
          throw new Error('renderer unavailable')
        },
      },
    }) as unknown as BrowserWindow,
    scheduleReconnect: () => {
      reconnects += 1
    },
  })

  try {
    await flushPoll()
    assert.equal(reconnects, 1)
  } finally {
    clearInterval(interval)
  }
})
