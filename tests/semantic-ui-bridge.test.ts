import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import { configureSemanticUiBridge, ensureSemanticUiBridge, getSemanticUiBridgeEnvironment, stopSemanticUiBridge, updateSemanticUiBridgeState } from '@open-cowork/runtime-host/semantic-ui-bridge'
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSemanticUiStatus } from '../packages/shared/src/semantic-ui.ts'
import { createResourceIdentity } from '../packages/shared/src/resource-identity.ts'
import {
  createSemanticUiLocalActionList,
  executeSemanticUiLocalAction,
} from '../apps/desktop/src/main/semantic-ui-local-actions.ts'
import { stopSessionStatusReconciliation } from '../apps/desktop/src/main/session-status-reconciler.ts'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'

async function post(path: string, token: string, body: Record<string, unknown> = {}) {
  const env = getSemanticUiBridgeEnvironment()
  assert.ok(env.OPEN_COWORK_SEMANTIC_UI_URL)
  const response = await fetch(`${env.OPEN_COWORK_SEMANTIC_UI_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  }
}

test('semantic UI bridge exposes tokenized read-only status and snapshot routes', async () => {
  try {
    configureSemanticUiBridge({
      statusProvider: () => createSemanticUiStatus({
        capturedAt: '2026-06-02T00:00:00.000Z',
        authority: 'desktop-local',
        appReady: true,
        route: null,
        workspace: null,
        activeSession: null,
        runtime: {
          ready: true,
          phase: 'ready',
          error: null,
        },
        pending: {
          approvals: 2,
          questions: 1,
        },
      }),
      // diagnostics-export lives desktop-side and is injected into the bridge;
      // mirror that wiring so the default diagnostics.export action has a builder.
      diagnosticsBundleBuilder: () => 'diagnostics bundle for semantic UI bridge test',
    })
    await ensureSemanticUiBridge()
    const env = getSemanticUiBridgeEnvironment()
    assert.ok(env.OPEN_COWORK_SEMANTIC_UI_TOKEN)

    assert.equal((await post('/status', 'wrong-token-with-enough-entropy-for-tests')).status, 401)

    const status = await post('/status', env.OPEN_COWORK_SEMANTIC_UI_TOKEN)
    assert.equal(status.status, 200)
    assert.equal((status.body.status as { appReady?: boolean }).appReady, true)

    const snapshot = await post('/snapshot', env.OPEN_COWORK_SEMANTIC_UI_TOKEN)
    assert.equal(snapshot.status, 200)
    assert.equal(Boolean(snapshot.body.snapshot), true)

    const actions = await post('/actions/list', env.OPEN_COWORK_SEMANTIC_UI_TOKEN)
    assert.equal(actions.status, 200)
    assert.equal(
      ((actions.body.actions as { actions?: Array<{ id?: string }> }).actions || [])[0]?.id,
      'diagnostics.export',
    )

    const executed = await post('/actions/execute', env.OPEN_COWORK_SEMANTIC_UI_TOKEN, {
      actionId: 'diagnostics.export',
    })
    assert.equal(executed.status, 200)
    const result = executed.body.result as { ok?: boolean; content?: { text?: string } }
    assert.equal(result.ok, true)
    assert.match(result.content?.text || '', /diagnostics/)
  } finally {
    stopSemanticUiBridge()
  }
})

test('semantic UI bridge honors the global disable switch', async () => {
  const previous = process.env.OPEN_COWORK_DISABLE_SEMANTIC_UI_MCP
  process.env.OPEN_COWORK_DISABLE_SEMANTIC_UI_MCP = '1'
  try {
    stopSemanticUiBridge()
    await ensureSemanticUiBridge()
    assert.deepEqual(getSemanticUiBridgeEnvironment(), {})
  } finally {
    if (previous === undefined) delete process.env.OPEN_COWORK_DISABLE_SEMANTIC_UI_MCP
    else process.env.OPEN_COWORK_DISABLE_SEMANTIC_UI_MCP = previous
    stopSemanticUiBridge()
  }
})

test('semantic UI bridge publishes app-owned state without exposing local details', async () => {
  try {
    const workspace = createResourceIdentity({
      authority: 'desktop-cloud',
      kind: 'workspace',
      workspaceId: 'workspace-1',
    })
    const session = createResourceIdentity({
      authority: 'desktop-cloud',
      kind: 'session',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    })

    updateSemanticUiBridgeState({
      capturedAt: '2026-06-02T00:00:00.000Z',
      authority: 'desktop-cloud',
      appReady: true,
      route: session,
      workspace,
      activeSession: session,
      runtime: {
        ready: true,
        phase: 'ready',
        error: 'Authorization: Bearer secret-token-value',
      },
      pending: {
        approvals: 1,
      },
      visibleSurface: '/Users/alice/private-project',
      items: [{
        id: 'active-session',
        kind: 'session',
        label: 'Session for /Users/alice/private-project token=secret-token-value',
        identity: session,
        state: 'ready',
      }],
    })

    await ensureSemanticUiBridge()
    const env = getSemanticUiBridgeEnvironment()
    assert.ok(env.OPEN_COWORK_SEMANTIC_UI_TOKEN)

    const status = await post('/status', env.OPEN_COWORK_SEMANTIC_UI_TOKEN)
    assert.equal(status.status, 200)
    const statusBody = status.body.status as {
      activeSession?: { sessionId?: string }
      pending?: { approvals?: number; questions?: number }
      runtime?: { error?: string }
      workspace?: { workspaceId?: string }
    }
    assert.equal(statusBody.workspace?.workspaceId, 'workspace-1')
    assert.equal(statusBody.activeSession?.sessionId, 'session-1')
    assert.equal(statusBody.pending?.approvals, 1)
    assert.equal(statusBody.pending?.questions, 0)
    assert.equal(statusBody.runtime?.error, '[redacted]')

    const snapshot = await post('/snapshot', env.OPEN_COWORK_SEMANTIC_UI_TOKEN)
    const snapshotText = JSON.stringify(snapshot.body)
    assert.equal(snapshot.status, 200)
    assert.match(snapshotText, /\[redacted\]/)
    assert.doesNotMatch(snapshotText, /\/Users\/alice/)
    assert.doesNotMatch(snapshotText, /secret-token-value/)
  } finally {
    stopSemanticUiBridge()
  }
})

test('semantic UI bridge gates state-dependent approval and question actions', async () => {
  try {
    await ensureSemanticUiBridge()
    const env = getSemanticUiBridgeEnvironment()
    assert.ok(env.OPEN_COWORK_SEMANTIC_UI_TOKEN)

    const unavailable = await post('/actions/execute', env.OPEN_COWORK_SEMANTIC_UI_TOKEN, {
      actionId: 'approval.allow',
      input: { approvalId: 'approval-1' },
    })
    assert.equal(unavailable.status, 200)
    assert.equal((unavailable.body.result as { ok?: boolean; errorCode?: string }).ok, false)
    assert.equal((unavailable.body.result as { errorCode?: string }).errorCode, 'semantic-ui-action-unavailable')

    let executedAction: string | null = null
    configureSemanticUiBridge({
      actionListProvider: () => ({
        schemaVersion: 1,
        capturedAt: '2026-06-02T00:00:00.000Z',
        actions: [
          {
            id: 'approval.allow',
            label: 'Allow approval',
            description: 'Allow the pending local approval.',
            destructive: false,
            requiresAudit: true,
            auditEventType: 'semantic_ui.approval.allow',
            enabled: true,
          },
          {
            id: 'question.answer',
            label: 'Answer question',
            description: 'Answer the pending local question.',
            destructive: false,
            requiresAudit: true,
            enabled: false,
            reasonCode: 'semantic-ui-action-stale',
          },
          {
            id: 'approval.deny',
            label: 'Deny approval',
            description: 'Deny the pending local approval.',
            destructive: true,
            requiresAudit: true,
            enabled: true,
          },
        ],
        redacted: true,
      }),
      actionExecutor: (actionId, input) => {
        executedAction = `${actionId}:${String(input.approvalId || input.questionId || '')}`
        return {
          schemaVersion: 1,
          capturedAt: '2026-06-02T00:00:01.000Z',
          actionId,
          ok: true,
          content: { audited: true },
          redacted: true,
        }
      },
    })

    const disabled = await post('/actions/execute', env.OPEN_COWORK_SEMANTIC_UI_TOKEN, {
      actionId: 'question.answer',
      input: { questionId: 'question-1', answers: ['yes'] },
    })
    assert.equal((disabled.body.result as { ok?: boolean }).ok, false)
    assert.equal((disabled.body.result as { errorCode?: string }).errorCode, 'semantic-ui-action-stale')

    const destructive = await post('/actions/execute', env.OPEN_COWORK_SEMANTIC_UI_TOKEN, {
      actionId: 'approval.deny',
      input: { approvalId: 'approval-1' },
    })
    assert.equal((destructive.body.result as { ok?: boolean }).ok, false)
    assert.equal((destructive.body.result as { errorCode?: string }).errorCode, 'semantic-ui-destructive-confirmation-required')

    const allowed = await post('/actions/execute', env.OPEN_COWORK_SEMANTIC_UI_TOKEN, {
      actionId: 'approval.allow',
      input: { approvalId: 'approval-1' },
    })
    assert.equal((allowed.body.result as { ok?: boolean }).ok, true)
    assert.equal(executedAction, 'approval.allow:approval-1')
  } finally {
    stopSemanticUiBridge()
  }
})

function createLocalActionContext(calls: {
  permissions: Array<{ requestID: string; reply: string }>
  questionReplies: Array<{ requestID: string; answers: string[][] }>
  questionRejects: Array<{ requestID: string }>
}) {
  return {
    getMainWindow: () => null,
    reconcileIdleSession: () => {},
    getSessionV2Client: async () => ({
      record: { id: 'session-local', directory: '/tmp/workspace' },
      directory: '/tmp/workspace',
      client: {
        permission: {
          reply: async (payload: { requestID: string; reply: string }) => {
            calls.permissions.push(payload)
          },
        },
        question: {
          reply: async (payload: { requestID: string; answers: string[][] }) => {
            calls.questionReplies.push(payload)
          },
          reject: async (payload: { requestID: string }) => {
            calls.questionRejects.push(payload)
          },
        },
      },
    }),
  } as unknown as IpcHandlerContext
}

test('semantic UI local action list is state-dependent and product-mode gated', () => {
  const sessionId = 'semantic-ui-list-session'
  try {
    sessionEngine.addApproval({
      id: 'approval-list',
      sessionId,
      tool: 'bash',
      input: {},
      description: 'Run command',
    })
    sessionEngine.setPendingQuestions(sessionId, [{
      id: 'question-list',
      sessionId,
      questions: [{
        header: 'Confirm',
        question: 'Proceed?',
        options: [],
      }],
    }])

    const local = createSemanticUiLocalActionList('desktop-local')
    assert.equal(local.actions.some((action) => action.id === 'approval.allow' && action.enabled), true)
    assert.equal(local.actions.some((action) => action.id === 'question.answer' && action.enabled), true)

    const remote = createSemanticUiLocalActionList('cloud-web')
    assert.equal(remote.actions.find((action) => action.id === 'approval.allow')?.enabled, false)
    assert.equal(remote.actions.find((action) => action.id === 'approval.allow')?.reasonCode, 'semantic-ui-action-product-mode-unsupported')
  } finally {
    sessionEngine.removeSession(sessionId)
    stopSessionStatusReconciliation(sessionId)
  }
})

test('semantic UI local approval action uses OpenCode permission reply and audit metadata', async () => {
  const sessionId = 'semantic-ui-approval-session'
  const calls = { permissions: [], questionReplies: [], questionRejects: [] } as {
    permissions: Array<{ requestID: string; reply: string }>
    questionReplies: Array<{ requestID: string; answers: string[][] }>
    questionRejects: Array<{ requestID: string }>
  }
  try {
    sessionEngine.addApproval({
      id: 'approval-local',
      sessionId,
      tool: 'bash',
      input: { command: 'echo ok' },
      description: 'Run command',
    })

    const result = await executeSemanticUiLocalAction(createLocalActionContext(calls), 'approval.allow', {
      approvalId: 'approval-local',
    })

    assert.equal(result.ok, true)
    assert.deepEqual(calls.permissions, [{ requestID: 'approval-local', reply: 'once' }])
    assert.equal((result.content as { audited?: boolean }).audited, true)
    assert.equal(sessionEngine.getPendingApprovals().some((entry) => entry.approval.id === 'approval-local'), false)

    const stale = await executeSemanticUiLocalAction(createLocalActionContext(calls), 'approval.deny', {
      approvalId: 'approval-local',
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.errorCode, 'semantic-ui-action-stale')
  } finally {
    sessionEngine.removeSession(sessionId)
    stopSessionStatusReconciliation(sessionId)
  }
})

test('semantic UI local question action uses OpenCode question reply path', async () => {
  const sessionId = 'semantic-ui-question-session'
  const calls = { permissions: [], questionReplies: [], questionRejects: [] } as {
    permissions: Array<{ requestID: string; reply: string }>
    questionReplies: Array<{ requestID: string; answers: string[][] }>
    questionRejects: Array<{ requestID: string }>
  }
  try {
    sessionEngine.setPendingQuestions(sessionId, [{
      id: 'question-local',
      sessionId,
      questions: [{
        header: 'Pick',
        question: 'Choose one',
        options: [{ label: 'yes', description: 'Proceed' }],
      }],
    }])

    const result = await executeSemanticUiLocalAction(createLocalActionContext(calls), 'question.answer', {
      questionId: 'question-local',
      answers: [['yes']],
    })

    assert.equal(result.ok, true)
    assert.deepEqual(calls.questionReplies, [{ requestID: 'question-local', answers: [['yes']] }])
    assert.equal((result.content as { auditEventType?: string }).auditEventType, 'semantic_ui.question.answer')
  } finally {
    sessionEngine.removeSession(sessionId)
    stopSessionStatusReconciliation(sessionId)
  }
})
