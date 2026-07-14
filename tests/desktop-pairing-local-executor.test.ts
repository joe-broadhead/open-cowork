import test from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopPairingLocalExecutor } from '../apps/desktop/src/main/desktop-pairing/local-executor.ts'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'

type NativeRequest = { id: string; sessionID: string }
type NativeSession = { id: string; parentID?: string }

function createPairingExecutorFixture(input: {
  permissions?: NativeRequest[]
  questions?: NativeRequest[]
  sessions?: NativeSession[]
}) {
  const permissionReplies: Array<Record<string, unknown>> = []
  const questionReplies: Array<Record<string, unknown>> = []
  const questionRejections: Array<Record<string, unknown>> = []
  const requestedRootSessionIds: string[] = []
  const sessionGets: string[] = []
  const sessions = new Map((input.sessions || []).map((session) => [session.id, session]))
  const client = {
    v2: {
      permission: {
        request: {
          list: async () => ({ data: { data: input.permissions || [] } }),
        },
      },
      question: {
        request: {
          list: async () => ({ data: { data: input.questions || [] } }),
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          sessionGets.push(sessionID)
          const session = sessions.get(sessionID)
          if (!session) throw new Error('session not found')
          return { data: { data: session } }
        },
        permission: {
          reply: async (request: Record<string, unknown>, options: Record<string, unknown>) => {
            permissionReplies.push({ ...request, options })
          },
        },
        question: {
          reply: async (request: Record<string, unknown>, options: Record<string, unknown>) => {
            questionReplies.push({ ...request, options })
          },
          reject: async (request: Record<string, unknown>, options: Record<string, unknown>) => {
            questionRejections.push({ ...request, options })
          },
        },
      },
    },
  }
  const context = {
    getSessionV2Client: async (sessionId: string) => {
      requestedRootSessionIds.push(sessionId)
      return {
        client,
        record: { id: sessionId },
        directory: '/workspace/project',
      }
    },
  } as unknown as IpcHandlerContext

  return {
    executor: createDesktopPairingLocalExecutor(context),
    permissionReplies,
    questionReplies,
    questionRejections,
    requestedRootSessionIds,
    sessionGets,
  }
}

test('paired desktop replies to a delegated permission through its native child session', async () => {
  const fixture = createPairingExecutorFixture({
    permissions: [{ id: 'permission-child', sessionID: 'child-session' }],
    sessions: [{ id: 'child-session', parentID: 'root-session' }],
  })

  await fixture.executor.respondPermission({
    sessionId: 'root-session',
    permissionId: 'permission-child',
    allowed: true,
  })

  assert.deepEqual(fixture.requestedRootSessionIds, ['root-session'])
  assert.deepEqual(fixture.sessionGets, ['child-session'])
  assert.deepEqual(fixture.permissionReplies, [{
    sessionID: 'child-session',
    requestID: 'permission-child',
    reply: 'once',
    options: { throwOnError: true },
  }])
})

test('paired desktop replies to a nested delegated question through its native owning session', async () => {
  const fixture = createPairingExecutorFixture({
    questions: [{ id: 'question-grandchild', sessionID: 'grandchild-session' }],
    sessions: [
      { id: 'grandchild-session', parentID: 'child-session' },
      { id: 'child-session', parentID: 'root-session' },
    ],
  })

  await fixture.executor.replyQuestion({
    sessionId: 'root-session',
    requestId: 'question-grandchild',
    answers: [['Proceed']],
  })

  assert.deepEqual(fixture.requestedRootSessionIds, ['root-session'])
  assert.deepEqual(fixture.sessionGets, ['grandchild-session', 'child-session'])
  assert.deepEqual(fixture.questionReplies, [{
    sessionID: 'grandchild-session',
    requestID: 'question-grandchild',
    questionV2Reply: { answers: [['Proceed']] },
    options: { throwOnError: true },
  }])
})

test('paired desktop rejects a delegated question through its native child session', async () => {
  const fixture = createPairingExecutorFixture({
    questions: [{ id: 'question-child', sessionID: 'child-session' }],
    sessions: [{ id: 'child-session', parentID: 'root-session' }],
  })

  await fixture.executor.rejectQuestion({
    sessionId: 'root-session',
    requestId: 'question-child',
  })

  assert.deepEqual(fixture.requestedRootSessionIds, ['root-session'])
  assert.deepEqual(fixture.questionRejections, [{
    sessionID: 'child-session',
    requestID: 'question-child',
    options: { throwOnError: true },
  }])
})

test('paired desktop cannot answer a pending request owned by an unrelated session tree', async () => {
  const fixture = createPairingExecutorFixture({
    permissions: [{ id: 'permission-other', sessionID: 'other-child' }],
    sessions: [
      { id: 'other-child', parentID: 'other-root' },
      { id: 'other-root' },
    ],
  })

  await assert.rejects(
    fixture.executor.respondPermission({
      sessionId: 'allowed-root',
      permissionId: 'permission-other',
      allowed: true,
    }),
    /not pending for this paired session/,
  )

  assert.deepEqual(fixture.requestedRootSessionIds, ['allowed-root'])
  assert.deepEqual(fixture.sessionGets, ['other-child', 'other-root'])
  assert.deepEqual(fixture.permissionReplies, [])
})
