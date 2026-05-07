import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { getMcpStatus, subscribeToEvents } from '../apps/desktop/src/main/events.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'

type IntervalId = ReturnType<typeof setInterval>

function createFakeClient(stream: AsyncIterable<unknown>): OpencodeClient {
  return {
    event: {
      subscribe: async () => ({ stream }),
    },
  } as unknown as OpencodeClient
}

function createFakeMcpClient(status: () => Promise<{ data: unknown }>): OpencodeClient {
  return {
    mcp: {
      status,
    },
  } as unknown as OpencodeClient
}

async function* emptyStream() {
  for (const value of [] as unknown[]) yield value
  // Completes immediately.
}

async function* throwingStream() {
  for (const value of [] as unknown[]) yield value
  throw new Error('stream failed')
}

async function withTrackedIntervals(fn: (state: {
  created: IntervalId[]
  cleared: IntervalId[]
}) => Promise<void>) {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const created: IntervalId[] = []
  const cleared: IntervalId[] = []

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = { handler, timeout, args, index: created.length + 1 } as unknown as IntervalId
    created.push(id)
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id?: IntervalId) => {
    if (id) cleared.push(id)
  }) as typeof clearInterval

  try {
    await fn({ created, cleared })
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
}

async function withCapturedLogs(fn: (lines: string[]) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-events-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const originalConsoleLog = console.log
  const lines: string[] = []

  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
    clearConfigCaches()
    console.log = ((line?: unknown) => {
      lines.push(String(line ?? ''))
    }) as typeof console.log
    await fn(lines)
  } finally {
    console.log = originalConsoleLog
    closeLogger()
    await delay(25)
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
}

test('subscribeToEvents clears its sweep interval when the stream ends unexpectedly', async () => {
  await withTrackedIntervals(async ({ created, cleared }) => {
    await assert.rejects(
      subscribeToEvents(createFakeClient(emptyStream()), () => null),
      /SSE stream ended unexpectedly/,
    )

    assert.equal(created.length, 1)
    assert.deepEqual(cleared, created)
  })
})

test('subscribeToEvents clears its sweep interval when an aborted stream ends', async () => {
  const controller = new AbortController()
  controller.abort()

  await withTrackedIntervals(async ({ created, cleared }) => {
    await subscribeToEvents(createFakeClient(emptyStream()), () => null, controller.signal)

    assert.equal(created.length, 1)
    assert.deepEqual(cleared, created)
  })
})

test('subscribeToEvents clears its sweep interval when stream iteration throws', async () => {
  await withTrackedIntervals(async ({ created, cleared }) => {
    await assert.rejects(
      subscribeToEvents(createFakeClient(throwingStream()), () => null),
      /stream failed/,
    )

    assert.equal(created.length, 1)
    assert.deepEqual(cleared, created)
  })
})

test('getMcpStatus logs connected, auth-required, and failed MCP groups', async () => {
  await withCapturedLogs(async (lines) => {
    const entries = await getMcpStatus(createFakeMcpClient(async () => ({
      data: {
        charts: { status: 'connected' },
        sheets: { status: 'failed', error: 'Non-200 status code (403)' },
        broken: { status: 'failed' },
      },
    })))

    assert.deepEqual(entries.map((entry) => ({
      name: entry.name,
      connected: entry.connected,
      rawStatus: entry.rawStatus,
    })), [
      { name: 'charts', connected: true, rawStatus: 'connected' },
      { name: 'sheets', connected: false, rawStatus: 'auth_required' },
      { name: 'broken', connected: false, rawStatus: 'failed' },
    ])
    assert.ok(
      lines.some((line) => line.includes('[mcp] Status: 1/3 connected needs-auth=[sheets] failed=[broken=failed]')),
      `expected grouped MCP status log, got ${JSON.stringify(lines)}`,
    )
  })
})

test('getMcpStatus logs SDK failures before returning an empty list', async () => {
  await withCapturedLogs(async (lines) => {
    const entries = await getMcpStatus(createFakeMcpClient(async () => {
      throw new Error('status endpoint unavailable')
    }))

    assert.deepEqual(entries, [])
    assert.ok(
      lines.some((line) => line.includes('[error] mcp.status() failed: status endpoint unavailable')),
      `expected mcp.status failure log, got ${JSON.stringify(lines)}`,
    )
  })
})
