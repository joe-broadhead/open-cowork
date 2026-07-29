import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import { runtimeState } from '@open-cowork/runtime-host/runtime-state'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { stopSessionStatusReconciliation } from '../apps/desktop/src/main/session-status-reconciler.ts'
import type { CloudWorkspaceSessionAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import {
  createIpcHandlerHarness as createBaseContext,
  emptySessionView,
  installCloudWorkspace,
} from './support/ipc-handler-harness.ts'

test('permission:respond can answer a reopened approval using the hydrated session id', async () => {
  const { context, handlers } = createBaseContext()
  const replies: Array<Record<string, unknown>> = []
  let requestedSessionId: string | null = null

  context.getSessionV2Client = async (sessionId) => {
    requestedSessionId = sessionId
    return {
      client: {
        v2: {
          session: {
            permission: {
              reply: async (payload: Record<string, unknown>) => {
                replies.push(payload)
              },
            },
          },
        },
      } as any,
      record: null,
    }
  }

  registerSessionHandlers(context)
  const handler = handlers.get('permission:respond')

  assert.ok(handler, 'expected permission:respond handler to be registered')
  await handler({}, 'perm-1', true, 'session-reopened')

  assert.equal(requestedSessionId, 'session-reopened')
  assert.deepEqual(replies, [{
    sessionID: 'session-reopened',
    requestID: 'perm-1',
    reply: 'once',
  }])
})

test('permission:respond rejects malformed ids, sessions, and non-boolean decisions before runtime access', async () => {
  const { context, handlers } = createBaseContext()
  let runtimeAccesses = 0
  context.getSessionV2Client = async () => {
    runtimeAccesses += 1
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('permission:respond')
  assert.ok(handler, 'expected permission:respond handler to be registered')

  await assert.rejects(() => handler({}, 'perm-1', 'false', 'session-1'), /must be a boolean/)
  await assert.rejects(() => handler({}, '   ', true, 'session-1'), /request id is required/)
  await assert.rejects(() => handler({}, 'perm-1', true, '   '), /Session id is required/)
  assert.equal(runtimeAccesses, 0)
})

test('permission:respond routes cloud approvals through the cloud workspace adapter', async () => {
  const { context, handlers } = createBaseContext()
  const permissionResponses: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => emptySessionView({
      revision: 10,
      lastEventAt: 10,
    }) as any,
    promptSession: async () => {},
    abortSession: async () => {},
    respondToPermission: async (sessionId, permissionId, allowed) => {
      permissionResponses.push({ sessionId, permissionId, allowed })
    },
  }
  installCloudWorkspace(context, adapter)
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 301,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
      },
    },
  } as any)
  context.getSessionV2Client = async () => {
    throw new Error('local runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('permission:respond')
  assert.ok(handler, 'expected permission:respond handler to be registered')

  await handler({ sender: { id: 301 } }, 'permission-cloud', true, 'cloud-session-1', { workspaceId: 'cloud:test' })

  assert.deepEqual(permissionResponses, [{
    sessionId: 'cloud-session-1',
    permissionId: 'permission-cloud',
    allowed: true,
  }])
  assert.deepEqual(sentViews, [{
    sessionId: 'cloud-session-1',
    workspaceId: 'cloud:test',
    view: await adapter.getSessionView('cloud-session-1'),
  }])
})

test('question:reply clears the answered request locally so queued questions advance', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'question-ipc-reply-session'
  const replies: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({ sessionId, data: { type: 'busy' } })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-1',
        questions: [{
          header: 'First',
          question: 'Pick the first answer',
          options: [{ label: 'A', description: 'Alpha' }],
        }],
      },
    })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-2',
        questions: [{
          header: 'Second',
          question: 'Pick the second answer',
          options: [{ label: 'B', description: 'Beta' }],
        }],
      },
    })

    context.getMainWindow = () => ({
      isDestroyed: () => false,
      webContents: {
        id: 101,
        send: (channel: string, payload: unknown) => {
          if (channel === 'session:view') sentViews.push(payload)
        },
      },
    } as any)
    context.getSessionV2Client = async () => ({
      client: {
        v2: {
          session: {
            question: {
              reply: async (payload: Record<string, unknown>) => {
                replies.push(payload)
              },
            },
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('question:reply')
    assert.ok(handler, 'expected question:reply handler to be registered')

    await handler({}, sessionId, 'question-1', [['A']])

    const view = sessionEngine.getSessionView(sessionId)
    assert.deepEqual(replies, [{
      sessionID: sessionId,
      requestID: 'question-1',
      questionV2Reply: { answers: [['A']] },
    }])
    assert.equal(view.pendingQuestions.length, 1)
    assert.equal(view.pendingQuestions[0]?.id, 'question-2')
    assert.equal(view.isAwaitingQuestion, true)

    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(sentViews.length > 0, true)
  } finally {
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
  }
})

test('question:reply routes cloud answers through the cloud workspace adapter', async () => {
  const { context, handlers } = createBaseContext()
  const questionReplies: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => emptySessionView({
      revision: 11,
      lastEventAt: 11,
    }) as any,
    promptSession: async () => {},
    abortSession: async () => {},
    replyToQuestion: async (sessionId, requestId, answers) => {
      questionReplies.push({ sessionId, requestId, answers })
    },
  }
  installCloudWorkspace(context, adapter)
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 302,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
      },
    },
  } as any)
  context.getSessionV2Client = async () => {
    throw new Error('local runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('question:reply')
  assert.ok(handler, 'expected question:reply handler to be registered')

  await handler({ sender: { id: 302 } }, 'cloud-session-1', 'question-cloud', [['Yes']], { workspaceId: 'cloud:test' })

  assert.deepEqual(questionReplies, [{
    sessionId: 'cloud-session-1',
    requestId: 'question-cloud',
    answers: [['Yes']],
  }])
  assert.deepEqual(sentViews, [{
    sessionId: 'cloud-session-1',
    workspaceId: 'cloud:test',
    view: await adapter.getSessionView('cloud-session-1'),
  }])
})

test('session:file-snippet rejects oversized files before reading snippet contents', async () => {
  const { context, handlers } = createBaseContext()
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-snippet-'))
  try {
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'))
    upsertSessionRecord(toSessionRecord({
      id: 'session-large-snippet',
      title: 'Large snippet',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: root,
    }))

    registerSessionHandlers(context)
    const handler = handlers.get('session:file-snippet')

    assert.ok(handler, 'expected session:file-snippet handler to be registered')
    await assert.rejects(
      () => handler({}, {
        sessionId: 'session-large-snippet',
        filePath: 'large.txt',
        startLine: 1,
        endLine: 2,
      }),
      /too large/,
    )
  } finally {
    clearSessionRegistryCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('question:reply rejects malformed answers before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionV2Client = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('question:reply')
  assert.ok(handler, 'expected question:reply handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-question-bounds', 'question-1', 'not-an-array'),
    /Question answers must be an array/,
  )
  assert.equal(clientRequested, false)
})

test('command:run rejects oversized command names before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('command:run')
  assert.ok(handler, 'expected command:run handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-command-bounds', 'x'.repeat(257)),
    /Command name exceeds 256 bytes/,
  )
  assert.equal(clientRequested, false)
})

test('command:list uses the selected project directory for V2 command discovery', async () => {
  const projectDirectory = join(tmpdir(), 'open-cowork-command-project')
  const calls: Array<{ input: unknown; options: unknown }> = []
  const scopedClient = {
    v2: {
      command: {
        async list(input: unknown, options: unknown) {
          calls.push({ input, options })
          return {
            data: {
              data: [{ name: 'project-review', description: 'Review this project' }],
            },
          }
        },
      },
    },
  }
  const previousClient = runtimeState.getClient()
  const previousDirectoryClients = [...runtimeState.getDirectoryClients()]
  runtimeState.setClient(scopedClient as Parameters<typeof runtimeState.setClient>[0])
  runtimeState.setDirectoryClient(projectDirectory, scopedClient as Parameters<typeof runtimeState.setClient>[0])

  try {
    const { context, handlers } = createBaseContext()
    context.resolveContextDirectory = (options) => options?.directory || null
    registerSessionHandlers(context)
    const handler = handlers.get('command:list')
    assert.ok(handler, 'expected command:list handler to be registered')

    assert.deepEqual(await handler({}, { directory: projectDirectory }), [{
      name: 'project-review',
      description: 'Review this project',
      source: undefined,
    }])
    assert.deepEqual(calls, [{
      input: { location: { directory: projectDirectory } },
      options: { throwOnError: true },
    }])
  } finally {
    runtimeState.clearDirectoryClients()
    for (const [directory, client] of previousDirectoryClients) {
      runtimeState.setDirectoryClient(directory, client)
    }
    runtimeState.setClient(previousClient)
  }
})

test('session:rename rejects empty titles before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:rename')
  assert.ok(handler, 'expected session:rename handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-rename-bounds', '   '),
    /Session title is required/,
  )
  assert.equal(clientRequested, false)
})

test('question:reject clears the rejected request locally', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'question-ipc-reject-session'
  const rejects: Array<Record<string, unknown>> = []

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({ sessionId, data: { type: 'busy' } })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-reject',
        questions: [{
          header: 'Reject',
          question: 'Should this be dismissed?',
          options: [{ label: 'Dismiss', description: 'Dismiss it' }],
        }],
      },
    })

    context.getMainWindow = () => ({
      isDestroyed: () => false,
      webContents: {
        id: 102,
        send: () => {},
      },
    } as any)
    context.getSessionV2Client = async () => ({
      client: {
        v2: {
          session: {
            question: {
              reject: async (payload: Record<string, unknown>) => {
                rejects.push(payload)
              },
            },
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('question:reject')
    assert.ok(handler, 'expected question:reject handler to be registered')

    await handler({}, sessionId, 'question-reject')

    const view = sessionEngine.getSessionView(sessionId)
    assert.deepEqual(rejects, [{
      sessionID: sessionId,
      requestID: 'question-reject',
    }])
    assert.equal(view.pendingQuestions.length, 0)
    assert.equal(view.isAwaitingQuestion, false)

    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
  }
})

test('question:reject routes cloud dismissals through the cloud workspace adapter', async () => {
  const { context, handlers } = createBaseContext()
  const questionRejects: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { sessions: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => emptySessionView({
      revision: 12,
      lastEventAt: 12,
    }) as any,
    promptSession: async () => {},
    abortSession: async () => {},
    rejectQuestion: async (sessionId, requestId) => {
      questionRejects.push({ sessionId, requestId })
    },
  }
  installCloudWorkspace(context, adapter)
  context.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 303,
      send: (channel: string, payload: unknown) => {
        if (channel === 'session:view') sentViews.push(payload)
      },
    },
  } as any)
  context.getSessionV2Client = async () => {
    throw new Error('local runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('question:reject')
  assert.ok(handler, 'expected question:reject handler to be registered')

  await handler({ sender: { id: 303 } }, 'cloud-session-1', 'question-cloud', { workspaceId: 'cloud:test' })

  assert.deepEqual(questionRejects, [{
    sessionId: 'cloud-session-1',
    requestId: 'question-cloud',
  }])
  assert.deepEqual(sentViews, [{
    sessionId: 'cloud-session-1',
    workspaceId: 'cloud:test',
    view: await adapter.getSessionView('cloud-session-1'),
  }])
})
