import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FileCloudWorkspaceCache } from '../apps/desktop/src/main/cloud-workspace-cache.ts'
import type { SessionInfo, SessionView } from '@open-cowork/shared'

function cachePath() {
  return join(mkdtempSync(join(tmpdir(), 'open-cowork-cloud-cache-')), 'cloud-workspace-cache.json')
}

function encryptedStorage() {
  return {
    mode: 'encrypted' as const,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${Buffer.from(plaintext, 'utf-8').toString('base64')}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const raw = encrypted.toString('utf-8')
      assert.ok(raw.startsWith('encrypted:'))
      return Buffer.from(raw.slice('encrypted:'.length), 'base64').toString('utf-8')
    },
  }
}

function emptyView(message = 'hello'): SessionView {
  return {
    messages: [{
      id: 'message-1',
      role: 'user',
      content: message,
      order: 1,
    }],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 0,
    lastEventAt: 0,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  }
}

test('cloud workspace full cache encrypts cached session views', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: encryptedStorage(),
  })

  cache.upsertSessionList('cloud:test', [{
    id: 'session-1',
    title: 'Cloud thread',
    directory: null,
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  cache.upsertSessionView('cloud:test', 'session-1', emptyView('secret message'))

  assert.equal(cache.listSessions('cloud:test')?.[0]?.id, 'session-1')
  assert.equal(cache.getSessionView('cloud:test', 'session-1')?.messages[0]?.content, 'secret message')
  const stored = readFileSync(path, 'utf-8')
  assert.equal(stored.includes('secret message'), false)
})

test('cloud workspace metadata-only cache strips session views', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'metadata-only',
    secretStorage: encryptedStorage(),
  })

  cache.upsertSessionList('cloud:test', [{
    id: 'session-1',
    title: 'Cloud thread',
    directory: null,
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  cache.upsertSessionView('cloud:test', 'session-1', emptyView('should not persist'))

  assert.equal(cache.listSessions('cloud:test')?.[0]?.title, 'Cloud thread')
  assert.equal(cache.getSessionView('cloud:test', 'session-1'), null)
  const stored = readFileSync(path, 'utf-8')
  assert.equal(stored.includes('should not persist'), false)
})

test('cloud workspace cache preserves safe project source summaries only', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'metadata-only',
    secretStorage: encryptedStorage(),
  })
  const session = {
    id: 'session-1',
    title: 'Cloud thread',
    directory: null,
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    projectSource: {
      kind: 'git',
      repositoryUrl: ' https://github.com/acme/project.git?token=query-secret#fragment-secret ',
      ref: ' main ',
      subdirectory: ' apps/web ',
      credentialRef: 'credential-secret',
    },
  } as unknown as SessionInfo

  cache.upsertSessionList('cloud:test', [session])

  assert.deepEqual(cache.listSessions('cloud:test')?.[0]?.projectSource, {
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/project.git',
    ref: 'main',
    subdirectory: 'apps/web',
  })
  const stored = readFileSync(path, 'utf-8')
  assert.equal(stored.includes('credential-secret'), false)
  assert.equal(stored.includes('query-secret'), false)
  assert.equal(stored.includes('fragment-secret'), false)
})

test('cloud workspace cache persists portable product metadata without message bodies', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'metadata-only',
    secretStorage: encryptedStorage(),
  })

  cache.setEventCursor('cloud:test', 'session:session-1', 4)
  cache.setEventCursor('cloud:test', 'session:session-1', 3)
  cache.upsertWorkflowList('cloud:test', {
    workflows: [{
      id: 'workflow-1',
      title: 'Daily report',
      instructions: 'Summarize',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      status: 'active',
      projectDirectory: null,
      draftSessionId: null,
      triggers: [],
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
      nextRunAt: null,
      lastRunAt: null,
      latestRunId: null,
      latestRunStatus: null,
      latestRunSessionId: null,
      latestRunSummary: null,
      webhookUrl: null,
    }],
    runs: [],
  })
  cache.upsertSettings('cloud:test', [{
    key: 'custom-agents',
    value: { items: [{ name: 'Data Analyst' }] },
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  cache.upsertArtifactList('cloud:test', 'session-1', [{
    id: 'artifact-1',
    toolId: 'cloud-artifact',
    toolName: 'cloud.artifact',
    filePath: 'cloud-artifact://artifact-1/result.txt',
    filename: 'result.txt',
    order: 1,
    source: 'cloud',
    cloudArtifactId: 'artifact-1',
    mime: 'text/plain',
  }])
  cache.upsertSessionView('cloud:test', 'session-1', emptyView('do not store this body'))

  assert.equal(cache.getEventCursor('cloud:test', 'session:session-1'), 4)
  assert.equal(cache.getWorkflowList('cloud:test')?.workflows[0]?.id, 'workflow-1')
  assert.equal(cache.getSetting('cloud:test', 'custom-agents')?.value.items instanceof Array, true)
  assert.equal(cache.listArtifacts('cloud:test', 'session-1')?.[0]?.cloudArtifactId, 'artifact-1')
  assert.equal(cache.getSessionView('cloud:test', 'session-1'), null)

  const stored = readFileSync(path, 'utf-8')
  assert.equal(stored.includes('do not store this body'), false)
})

test('cloud workspace disabled cache does not persist state', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'disabled',
    secretStorage: encryptedStorage(),
  })

  cache.upsertSessionList('cloud:test', [{
    id: 'session-1',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])

  assert.equal(cache.listSessions('cloud:test'), null)
})

test('cloud workspace full cache degrades when encrypted storage is unavailable', () => {
  const unavailableStorage = {
    mode: 'unavailable' as const,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8'),
  }
  const metadataOnly = new FileCloudWorkspaceCache({
    path: cachePath(),
    mode: 'full',
    encryptionFallback: 'metadata-only',
    secretStorage: unavailableStorage,
  })
  metadataOnly.upsertSessionView('cloud:test', 'session-1', emptyView('body'))
  assert.equal(metadataOnly.mode, 'metadata-only')
  assert.equal(metadataOnly.getSessionView('cloud:test', 'session-1'), null)

  const disabled = new FileCloudWorkspaceCache({
    path: cachePath(),
    mode: 'full',
    encryptionFallback: 'disabled',
    secretStorage: unavailableStorage,
  })
  disabled.upsertSessionList('cloud:test', [{
    id: 'session-1',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  assert.equal(disabled.mode, 'disabled')
  assert.equal(disabled.listSessions('cloud:test'), null)

  assert.throws(
    () => new FileCloudWorkspaceCache({
      path: cachePath(),
      mode: 'full',
      encryptionFallback: 'fail-startup',
      secretStorage: unavailableStorage,
    }),
    /Secure storage unavailable/,
  )
})

test('cloud workspace cache can reset a cursor after replay snapshot recovery', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'metadata-only',
    secretStorage: encryptedStorage(),
  })

  cache.setEventCursor('cloud:test', 'workspace', 100)
  cache.setEventCursor('cloud:test', 'workspace', 90)
  assert.equal(cache.getEventCursor('cloud:test', 'workspace'), 100)

  cache.resetEventCursor('cloud:test', 'workspace')
  assert.equal(cache.getEventCursor('cloud:test', 'workspace'), 0)
})
