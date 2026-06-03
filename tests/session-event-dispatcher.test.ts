import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  dispatchRuntimeSessionEvent,
  dropSessionFromDispatcherQueues,
  getRuntimeNotification,
  getSessionPatch,
  publishSessionView,
  setSessionHistoryRefreshHandler,
  shouldPublishSessionView,
} from '../apps/desktop/src/main/session-event-dispatcher.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearSessionRegistryCache,
  toSessionRecord,
  updateSessionRecord,
  upsertSessionRecord,
} from '../apps/desktop/src/main/session-registry.ts'
import { clearThreadIndexServiceCache } from '../apps/desktop/src/main/thread-index/thread-index-service.ts'
import { clearThreadIndexStoreCache } from '../apps/desktop/src/main/thread-index/thread-index-store.ts'

function eventOf(type: string, sessionId?: string | null) {
  return {
    type,
    sessionId: sessionId ?? null,
    data: { type },
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function createWindowCollector(id: number) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  }
  return { win, sent }
}

test('dispatcher derives renderer-safe text patches', () => {
  assert.deepEqual(getSessionPatch({
    type: 'text',
    sessionId: 'session-1',
    data: {
      type: 'text',
      messageId: 'msg-1',
      partId: 'part-1',
      content: 'Hello',
      mode: 'append',
      role: 'assistant',
    },
  }), {
    type: 'message_text',
    sessionId: 'session-1',
    messageId: 'msg-1',
    segmentId: 'part-1',
    content: 'Hello',
    mode: 'append',
    role: 'assistant',
    attachments: undefined,
    eventAt: 0,
  })

  assert.deepEqual(getSessionPatch({
    type: 'text',
    sessionId: 'session-1',
    data: {
      type: 'text',
      taskRunId: 'task-1',
      partId: 'task-part-1',
      content: 'Working',
      mode: 'replace',
    },
  }), {
    type: 'task_text',
    sessionId: 'session-1',
    taskRunId: 'task-1',
    segmentId: 'task-part-1',
    content: 'Working',
    mode: 'replace',
    eventAt: 0,
  })

  assert.equal(getSessionPatch(eventOf('done', 'session-1')), null)
  assert.equal(getSessionPatch(eventOf('error')), null)
})

test('dispatcher batches text patches in event order', async () => {
  const { win, sent } = createWindowCollector(50)

  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-patch-order',
    data: {
      type: 'text',
      messageId: 'message-1',
      partId: 'part-1',
      content: 'first',
      mode: 'append',
    },
  })
  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-patch-order',
    data: {
      type: 'text',
      messageId: 'message-1',
      partId: 'part-1',
      content: 'second',
      mode: 'append',
    },
  })

  assert.equal(sent.some((entry) => entry.channel === 'session:patch'), false)
  await wait(20)

  assert.deepEqual(
    sent.filter((entry) => entry.channel === 'session:patch').map((entry) => (entry.payload as { content?: string }).content),
    ['first', 'second'],
  )
})

test('dispatcher drops queued local and workspace-scoped session patches on deletion', async () => {
  const { win, sent } = createWindowCollector(55)

  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-delete-queued',
    data: {
      type: 'text',
      messageId: 'message-delete-local',
      partId: 'part-delete-local',
      content: 'local stale',
      mode: 'append',
    },
  })
  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-delete-queued',
    workspaceId: 'workspace-remote',
    data: {
      type: 'text',
      messageId: 'message-delete-remote',
      partId: 'part-delete-remote',
      content: 'remote stale',
      mode: 'append',
    },
  })
  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-delete-neighbor',
    workspaceId: 'workspace-remote',
    data: {
      type: 'text',
      messageId: 'message-neighbor',
      partId: 'part-neighbor',
      content: 'neighbor stays',
      mode: 'append',
    },
  })

  dropSessionFromDispatcherQueues('session-delete-queued')
  await wait(30)

  const patchPayloads = sent
    .filter((entry) => entry.channel === 'session:patch')
    .map((entry) => {
      const payload = entry.payload as { sessionId?: string; workspaceId?: string; content?: string }
      return {
        sessionId: payload.sessionId,
        workspaceId: payload.workspaceId,
        content: payload.content,
      }
    })
  assert.deepEqual(patchPayloads, [{
    sessionId: 'session-delete-neighbor',
    workspaceId: 'workspace-remote',
    content: 'neighbor stays',
  }])
})

test('dispatcher bounds queued patches and schedules full-view catch-up on overflow', async () => {
  const { win, sent } = createWindowCollector(51)

  for (let index = 0; index < 520; index += 1) {
    dispatchRuntimeSessionEvent(win as any, {
      type: 'text',
      sessionId: 'session-patch-overflow',
      data: {
        type: 'text',
        messageId: 'message-overflow',
        partId: `part-${index}`,
        content: `chunk-${index}`,
        mode: 'append',
      },
    })
  }

  await wait(80)

  const patchCount = sent.filter((entry) => entry.channel === 'session:patch').length
  assert.equal(patchCount, 0)
  assert.equal(sent.some((entry) => entry.channel === 'session:view'), true)
})

test('dispatcher overflow drops only patches for the recovering session', async () => {
  const { win, sent } = createWindowCollector(52)

  for (let index = 0; index < 511; index += 1) {
    dispatchRuntimeSessionEvent(win as any, {
      type: 'text',
      sessionId: 'session-patch-overflow-scoped',
      data: {
        type: 'text',
        messageId: 'message-overflow-scoped',
        partId: `part-${index}`,
        content: `overflow-${index}`,
        mode: 'append',
      },
    })
  }
  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-patch-neighbor',
    data: {
      type: 'text',
      messageId: 'message-neighbor',
      partId: 'part-neighbor',
      content: 'neighbor',
      mode: 'append',
    },
  })
  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-patch-overflow-scoped',
    data: {
      type: 'text',
      messageId: 'message-overflow-scoped',
      partId: 'part-overflow-trigger',
      content: 'overflow-trigger',
      mode: 'append',
    },
  })

  await wait(80)

  const patchPayloads = sent
    .filter((entry) => entry.channel === 'session:patch')
    .map((entry) => {
      const payload = entry.payload as { sessionId?: string; content?: string }
      return {
        sessionId: payload.sessionId,
        content: payload.content,
      }
    })
  assert.deepEqual(patchPayloads, [{
    sessionId: 'session-patch-neighbor',
    content: 'neighbor',
  }])
  assert.equal(
    sent.some((entry) => entry.channel === 'session:view' && (entry.payload as { sessionId?: string }).sessionId === 'session-patch-overflow-scoped'),
    true,
  )
})

test('dispatcher flushes queued session patches before a full view is queued', async () => {
  const { win, sent } = createWindowCollector(53)

  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-view-recovers-patches',
    data: {
      type: 'text',
      messageId: 'message-view-recovers',
      partId: 'part-before-view',
      content: 'before-view',
      mode: 'append',
    },
  })
  dispatchRuntimeSessionEvent(win as any, {
    type: 'busy',
    sessionId: 'session-view-recovers-patches',
    data: { type: 'busy' },
  })
  dispatchRuntimeSessionEvent(win as any, {
    type: 'text',
    sessionId: 'session-view-recovers-patches',
    data: {
      type: 'text',
      messageId: 'message-view-recovers',
      partId: 'part-after-view-queued',
      content: 'after-view-queued',
      mode: 'append',
    },
  })

  await wait(80)

  const sessionEvents = sent
    .filter((entry) => entry.channel === 'session:patch' || entry.channel === 'session:view')
    .map((entry) => ({
      channel: entry.channel,
      sessionId: (entry.payload as { sessionId?: string }).sessionId,
      content: (entry.payload as { content?: string }).content,
    }))
  assert.deepEqual(sessionEvents, [
    {
      channel: 'session:patch',
      sessionId: 'session-view-recovers-patches',
      content: 'before-view',
    },
    {
      channel: 'session:patch',
      sessionId: 'session-view-recovers-patches',
      content: 'after-view-queued',
    },
    {
      channel: 'session:view',
      sessionId: 'session-view-recovers-patches',
      content: undefined,
    },
  ])
})

test('history refresh flushes queued session patches before publishing the refreshed view', async () => {
  const { win, sent } = createWindowCollector(54)
  setSessionHistoryRefreshHandler(async () => undefined)

  try {
    dispatchRuntimeSessionEvent(win as any, {
      type: 'text',
      sessionId: 'session-history-refresh-patches',
      data: {
        type: 'text',
        messageId: 'message-history-refresh',
        partId: 'part-before-history',
        content: 'before-history-refresh',
        mode: 'append',
      },
    })
    dispatchRuntimeSessionEvent(win as any, eventOf('history_refresh', 'session-history-refresh-patches'))

    await wait(30)

    const sessionEvents = sent
      .filter((entry) => entry.channel === 'session:patch' || entry.channel === 'session:view')
      .map((entry) => ({
        channel: entry.channel,
        sessionId: (entry.payload as { sessionId?: string }).sessionId,
        content: (entry.payload as { content?: string }).content,
      }))
    assert.deepEqual(sessionEvents, [
      {
        channel: 'session:patch',
        sessionId: 'session-history-refresh-patches',
        content: 'before-history-refresh',
      },
      {
        channel: 'session:view',
        sessionId: 'session-history-refresh-patches',
        content: undefined,
      },
    ])
  } finally {
    setSessionHistoryRefreshHandler(null)
  }
})

test('dispatcher derives renderer-safe reasoning patches without forcing full view publishes', () => {
  assert.deepEqual(getSessionPatch({
    type: 'reasoning',
    sessionId: 'session-1',
    data: {
      type: 'reasoning',
      messageId: 'msg-1',
      partId: 'reasoning-1',
      content: 'I compared the rows.',
      mode: 'replace',
    },
  }), {
    type: 'message_reasoning',
    sessionId: 'session-1',
    messageId: 'msg-1',
    segmentId: 'reasoning-1',
    content: 'I compared the rows.',
    mode: 'replace',
    eventAt: 0,
  })

  assert.deepEqual(getSessionPatch({
    type: 'reasoning',
    sessionId: 'session-1',
    data: {
      type: 'reasoning',
      taskRunId: 'task-1',
      partId: 'task-reasoning-1',
      content: 'Inspecting fixtures.',
      mode: 'append',
    },
  }), {
    type: 'task_reasoning',
    sessionId: 'session-1',
    taskRunId: 'task-1',
    segmentId: 'task-reasoning-1',
    content: 'Inspecting fixtures.',
    mode: 'append',
    eventAt: 0,
  })

  assert.equal(shouldPublishSessionView(eventOf('reasoning', 'session-1')), false)
})

test('dispatcher publishes session views for non-text session state transitions', () => {
  assert.equal(shouldPublishSessionView(eventOf('text', 'session-1')), false)
  assert.equal(shouldPublishSessionView(eventOf('history_refresh', 'session-1')), false)
  assert.equal(shouldPublishSessionView(eventOf('busy', 'session-1')), true)
  assert.equal(shouldPublishSessionView(eventOf('tool_call', 'session-1')), true)
  assert.equal(shouldPublishSessionView(eventOf('error', 'session-1')), true)
  assert.equal(shouldPublishSessionView(eventOf('done', 'session-1')), true)
  assert.equal(shouldPublishSessionView(eventOf('busy')), false)
  assert.equal(shouldPublishSessionView({
    ...eventOf('tool_call', 'session-1'),
    workspaceId: 'cloud:test',
  }), false)
})

test('dispatcher never publishes local full views for cloud workspace events', async () => {
  const { win, sent } = createWindowCollector(55)

  dispatchRuntimeSessionEvent(win as any, {
    type: 'tool_call',
    sessionId: 'cloud-session-view-skip',
    workspaceId: 'cloud:test',
    data: {
      type: 'tool_call',
      id: 'tool-1',
      name: 'read',
      status: 'running',
    },
  })

  await wait(40)

  assert.equal(sent.some((entry) => entry.channel === 'session:view'), false)
})

test('publishSessionView refuses cloud workspace views from the local session engine', () => {
  const { win, sent } = createWindowCollector(56)

  publishSessionView(win as any, 'cloud-session-view-direct', 'cloud:test')

  assert.equal(sent.some((entry) => entry.channel === 'session:view'), false)
})

test('dispatcher derives notifications for completion and global errors', () => {
  assert.deepEqual(getRuntimeNotification(eventOf('done', 'session-1')), {
    type: 'done',
    sessionId: 'session-1',
    synthetic: false,
  })

  assert.deepEqual(getRuntimeNotification({
    type: 'done',
    sessionId: 'session-2',
    data: { type: 'done', synthetic: true },
  }), {
    type: 'done',
    sessionId: 'session-2',
    synthetic: true,
  })

  assert.deepEqual(getRuntimeNotification({
    type: 'error',
    sessionId: null,
    data: { type: 'error', message: 'Runtime disconnected' },
  }), {
    type: 'error',
    sessionId: null,
    message: 'Runtime disconnected',
  })

  assert.equal(getRuntimeNotification(eventOf('error', 'session-1')), null)
  assert.equal(getRuntimeNotification(eventOf('busy', 'session-1')), null)
})

test('history refresh publishes SDK-owned session metadata after registry sync', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-dispatcher-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearSessionRegistryCache()

  try {
    upsertSessionRecord(toSessionRecord({
      id: 'session-title-sync',
      title: 'New session',
      createdAt: '2026-05-18T14:00:00.000Z',
      updatedAt: '2026-05-18T14:00:00.000Z',
      opencodeDirectory: userDataDir,
    }))
    setSessionHistoryRefreshHandler(async (sessionId) => {
      updateSessionRecord(sessionId, {
        title: 'SDK generated title',
        updatedAt: '2026-05-18T14:00:05.000Z',
      })
    })

    const sent: Array<{ channel: string; payload: unknown }> = []
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 42,
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    }

    dispatchRuntimeSessionEvent(win as any, eventOf('history_refresh', 'session-title-sync'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.ok(sent.some((entry) => entry.channel === 'session:view'))
    assert.deepEqual(
      sent.find((entry) => entry.channel === 'session:updated')?.payload,
      {
        id: 'session-title-sync',
        workspaceId: 'local',
        title: 'SDK generated title',
        parentSessionId: null,
        changeSummary: null,
        revertedMessageId: null,
        composerModelId: null,
        composerReasoningVariant: null,
      },
    )
  } finally {
    setSessionHistoryRefreshHandler(null)
    clearThreadIndexServiceCache()
    clearThreadIndexStoreCache()
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
  }
})

test('dispatcher keeps renderer events flowing when thread index scheduling is unavailable', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-dispatcher-locked-index-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearThreadIndexServiceCache()
  clearThreadIndexStoreCache()
  clearConfigCaches()

  const dbPath = join(userDataDir, 'thread-index.sqlite')
  mkdirSync(userDataDir, { recursive: true })
  const lockDb = new DatabaseSync(dbPath)
  lockDb.exec('create table if not exists lock_probe (id integer); begin exclusive;')

  try {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 43,
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    }

    assert.doesNotThrow(() => {
      dispatchRuntimeSessionEvent(win as any, eventOf('done', 'session-locked-index'))
    })
    assert.deepEqual(sent.find((entry) => entry.channel === 'runtime:notification')?.payload, {
      type: 'done',
      sessionId: 'session-locked-index',
      synthetic: false,
    })
  } finally {
    lockDb.exec('rollback;')
    lockDb.close()
    clearThreadIndexServiceCache()
    clearThreadIndexStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
