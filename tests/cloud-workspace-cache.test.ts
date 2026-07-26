import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FileCloudWorkspaceCache } from '../apps/desktop/src/main/cloud-workspace-cache.ts'
import type { SessionInfo, SessionView, WorkflowListPayload } from '@open-cowork/shared'

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

const ENCRYPTED_CACHE_PREFIX = Buffer.from('open-cowork-cache:v2:encrypted\n', 'utf8')
const PLAINTEXT_CACHE_PREFIX = Buffer.from('open-cowork-cache:v2:plaintext\n', 'utf8')

function encryptedCachePayload(raw: Buffer) {
  assert.equal(raw.subarray(0, ENCRYPTED_CACHE_PREFIX.length).equals(ENCRYPTED_CACHE_PREFIX), true)
  return raw.subarray(ENCRYPTED_CACHE_PREFIX.length)
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

test('cloud workspace cache reports write failures without error or payload content', () => {
  const path = cachePath()
  const sentinel = 'cache-write-error-secret-sentinel-1234567890'
  const telemetry: Array<{ operation: string, outcome: string, reason: string, encoding: string }> = []
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: {
      mode: 'encrypted',
      encryptString: () => {
        throw new Error(sentinel)
      },
      decryptString: (encrypted) => encrypted.toString('utf8'),
    },
    reporter: (event) => telemetry.push(event),
  })

  assert.throws(
    () => cache.upsertSessionList('cloud:test', [{
      id: 'session-1',
      title: sentinel,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }]),
    new RegExp(sentinel),
  )
  assert.deepEqual(telemetry, [{
    operation: 'write',
    outcome: 'failed',
    reason: 'write_error',
    encoding: 'encrypted',
  }])
  assert.equal(JSON.stringify(telemetry).includes(sentinel), false)
})

test('cloud workspace full cache preserves ciphertext across transient decrypt failures', () => {
  const path = cachePath()
  const writable = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: encryptedStorage(),
  })
  writable.upsertSessionList('cloud:test', [{
    id: 'session-1',
    title: 'Preserved ciphertext',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  const ciphertext = readFileSync(path)

  let keychainLocked = true
  const storage = encryptedStorage()
  const telemetry: Array<{ operation: string, outcome: string, reason: string, encoding: string }> = []
  const logSentinel = 'decrypt-log-secret-sentinel-1234567890'
  const locked = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: {
      mode: 'encrypted',
      encryptString: storage.encryptString,
      decryptString: (encrypted) => {
        if (keychainLocked) throw new Error(`keychain locked ${logSentinel}`)
        return storage.decryptString(encrypted)
      },
    },
    reporter: (event) => telemetry.push(event),
  })

  assert.equal(locked.listSessions('cloud:test'), null)
  assert.deepEqual(telemetry, [{
    operation: 'decrypt',
    outcome: 'failed',
    reason: 'decrypt_error',
    encoding: 'encrypted',
  }])
  assert.equal(JSON.stringify(telemetry).includes(logSentinel), false)
  locked.upsertSessionList('cloud:test', [{
    id: 'session-overwrite-attempt',
    title: 'Must not overwrite ciphertext',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  locked.beginCacheBatch()
  locked.upsertSessionList('cloud:test', [{
    id: 'session-batch-overwrite-attempt',
    title: 'Batch must not overwrite ciphertext',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  locked.endCacheBatch()
  assert.equal(existsSync(path), true)
  assert.deepEqual(readFileSync(path), ciphertext)

  keychainLocked = false
  assert.equal(locked.listSessions('cloud:test')?.[0]?.title, 'Preserved ciphertext')
  assert.deepEqual(readFileSync(path), ciphertext)
})

test('cloud workspace metadata fallback never overwrites an existing encrypted full cache', () => {
  const path = cachePath()
  const storage = encryptedStorage()
  const full = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: storage,
  })
  full.upsertSessionList('cloud:test', [{
    id: 'session-1',
    title: 'Preserved encrypted cache',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  const ciphertext = readFileSync(path)

  const unavailable = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    encryptionFallback: 'metadata-only',
    secretStorage: {
      mode: 'unavailable',
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8'),
    },
  })
  assert.equal(unavailable.mode, 'metadata-only')
  assert.equal(unavailable.listSessions('cloud:test'), null)
  unavailable.upsertSessionList('cloud:test', [{
    id: 'overwrite-attempt',
    title: 'Must not replace encrypted bytes',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  assert.deepEqual(readFileSync(path), ciphertext)

  const recovered = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: storage,
  })
  assert.equal(recovered.listSessions('cloud:test')?.[0]?.title, 'Preserved encrypted cache')
})

test('cloud workspace metadata fallback preserves legacy unversioned encrypted cache bytes', () => {
  const path = cachePath()
  const storage = encryptedStorage()
  const full = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: storage,
  })
  full.upsertSessionList('cloud:test', [{
    id: 'session-1',
    title: 'Legacy encrypted cache',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  const legacyCiphertext = encryptedCachePayload(readFileSync(path))
  writeFileSync(path, legacyCiphertext)

  const unavailable = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    encryptionFallback: 'metadata-only',
    secretStorage: {
      mode: 'unavailable',
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8'),
    },
  })
  unavailable.upsertSessionList('cloud:test', [{
    id: 'overwrite-attempt',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  assert.deepEqual(readFileSync(path), legacyCiphertext)

  const recovered = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: storage,
  })
  assert.equal(recovered.listSessions('cloud:test')?.[0]?.title, 'Legacy encrypted cache')
  assert.equal(readFileSync(path).subarray(0, ENCRYPTED_CACHE_PREFIX.length).equals(ENCRYPTED_CACHE_PREFIX), true)
})

test('cloud workspace metadata fallback preserves ambiguous legacy ciphertext that parses as JSON', () => {
  const path = cachePath()
  const ambiguousCiphertext = Buffer.from('[]', 'utf8')
  writeFileSync(path, ambiguousCiphertext)

  const telemetry: Array<{ operation: string, outcome: string, reason: string, encoding: string }> = []
  const unavailable = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    encryptionFallback: 'metadata-only',
    secretStorage: {
      mode: 'unavailable',
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8'),
    },
    reporter: (event) => telemetry.push(event),
  })
  assert.equal(unavailable.listSessions('cloud:test'), null)
  assert.deepEqual(telemetry, [{
    operation: 'decrypt',
    outcome: 'blocked',
    reason: 'ambiguous_legacy_format',
    encoding: 'legacy',
  }])
  unavailable.upsertSessionList('cloud:test', [{
    id: 'overwrite-attempt',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])
  assert.deepEqual(readFileSync(path), ambiguousCiphertext)

  const recovered = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: {
      mode: 'encrypted',
      encryptString: (plaintext) => Buffer.from(`re-encrypted:${plaintext}`, 'utf8'),
      decryptString: (encrypted) => {
        assert.deepEqual(encrypted, ambiguousCiphertext)
        return JSON.stringify({
          schemaVersion: 2,
          records: [{
            workspaceId: 'cloud:test',
            sessions: [{
              id: 'session-recovered',
              title: 'Recovered ambiguous ciphertext',
              createdAt: '2026-05-27T10:00:00.000Z',
              updatedAt: '2026-05-27T10:00:00.000Z',
            }],
            views: {},
            workflows: null,
            settings: [],
            artifactsBySession: {},
            updatedAt: '2026-05-27T10:00:00.000Z',
          }],
        })
      },
    },
  })
  assert.equal(recovered.listSessions('cloud:test')?.[0]?.title, 'Recovered ambiguous ciphertext')
  assert.equal(readFileSync(path).subarray(0, ENCRYPTED_CACHE_PREFIX.length).equals(ENCRYPTED_CACHE_PREFIX), true)
})

test('cloud workspace cache blocks writes when corrupt-file quarantine cannot preserve the source', () => {
  const path = cachePath()
  const corrupt = Buffer.concat([PLAINTEXT_CACHE_PREFIX, Buffer.from('{not valid json', 'utf8')])
  writeFileSync(path, corrupt)
  mkdirSync(`${path}.corrupt`)
  const telemetry: Array<{ operation: string, outcome: string, reason: string, encoding: string }> = []
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'metadata-only',
    secretStorage: encryptedStorage(),
    reporter: (event) => telemetry.push(event),
  })

  assert.equal(cache.listSessions('cloud:test'), null)
  cache.upsertSessionList('cloud:test', [{
    id: 'overwrite-attempt',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])

  assert.deepEqual(readFileSync(path), corrupt)
  assert.deepEqual(telemetry, [{
    operation: 'quarantine',
    outcome: 'failed',
    reason: 'quarantine_failed',
    encoding: 'plaintext',
  }])
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

test('cloud workspace cache rejects credential-bearing settings before plaintext metadata persistence', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'metadata-only',
    secretStorage: encryptedStorage(),
  })
  const sentinel = 'cloud-setting-plaintext-secret-sentinel-1234567890'
  const unsafeSettings = [
    'apiKey',
    'githubToken',
    'signingSecret',
    'passwordHash',
    'encryptedPrivateKeyValue',
  ].map((field) => ({
    key: `unsafe-${field}`,
    value: { [field]: sentinel },
    updatedAt: '2026-07-26T00:00:00.000Z',
  }))

  cache.upsertSettings('cloud:test', [{
    key: 'appearance',
    value: { theme: 'dark' },
    updatedAt: '2026-07-26T00:00:00.000Z',
  }, {
    key: 'provider-api-key',
    value: { value: sentinel },
    updatedAt: '2026-07-26T00:00:00.000Z',
  }, ...unsafeSettings])

  assert.equal(cache.getSetting('cloud:test', 'appearance')?.value.theme, 'dark')
  assert.equal(cache.getSetting('cloud:test', 'provider-api-key'), null)
  for (const setting of unsafeSettings) {
    assert.equal(cache.getSetting('cloud:test', setting.key), null)
  }
  const stored = readFileSync(path, 'utf-8')
  assert.equal(stored.includes(sentinel), false)
  assert.equal(stored.includes('provider-api-key'), false)
  for (const setting of unsafeSettings) {
    assert.equal(stored.includes(setting.key), false)
  }
})

test('cloud workspace metadata-only cache drops arbitrary chart payloads', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'metadata-only',
    secretStorage: encryptedStorage(),
  })
  const sentinel = 'cloud-chart-plaintext-secret-sentinel-1234567890'

  cache.upsertArtifactList('cloud:test', 'session-1', [{
    id: 'chart-artifact',
    toolId: 'charts',
    toolName: 'charts.render',
    filePath: 'cloud-artifact://chart-artifact/chart.svg',
    filename: 'chart.svg',
    order: 1,
    source: 'cloud',
    chart: {
      format: 'vega-lite',
      spec: {
        mark: 'bar',
        data: { apiKey: sentinel },
      },
    },
  }])

  const artifact = cache.listArtifacts('cloud:test', 'session-1')?.[0]
  assert.equal(artifact?.id, 'chart-artifact')
  assert.equal(artifact?.chart, undefined)
  const stored = readFileSync(path, 'utf-8')
  assert.equal(stored.includes(sentinel), false)
  assert.equal(stored.includes('"chart"'), false)
})

test('cloud workspace cache serializer rejects secret-bearing workflow fields', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'metadata-only',
    secretStorage: encryptedStorage(),
  })
  const sentinel = 'workflow-cache-secret-sentinel-1234567890'
  cache.upsertWorkflowList('cloud:test', {
    workflows: [{
      id: 'workflow-secret-test',
      title: 'Secret-free summary',
      instructions: 'Run safely.',
      agentName: 'build',
      skillNames: [],
      toolIds: [],
      steps: [],
      status: 'active',
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{
        id: 'webhook',
        type: 'webhook',
        enabled: true,
        webhookSecret: sentinel,
      }, {
        id: 'schedule',
        type: 'schedule',
        enabled: true,
        schedule: {
          type: 'daily',
          timezone: 'UTC',
          runAtHour: 9,
          webhookSecret: sentinel,
          nested: { token: sentinel },
        },
      }],
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      nextRunAt: null,
      lastRunAt: null,
      latestRunId: null,
      latestRunStatus: null,
      latestRunSessionId: null,
      latestRunSummary: null,
      webhookUrl: 'https://example.test/webhook',
    }],
    runs: [{
      id: 'run-secret-test',
      workflowId: 'workflow-secret-test',
      sessionId: null,
      triggerType: 'webhook',
      triggerPayload: {
        authorization: sentinel,
        nested: { token: sentinel },
      },
      status: 'completed',
      title: 'Secret-bearing webhook run',
      summary: null,
      error: null,
      createdAt: '2026-07-26T00:00:00.000Z',
      startedAt: '2026-07-26T00:00:00.000Z',
      finishedAt: '2026-07-26T00:01:00.000Z',
    }],
    webhookSecretReveal: {
      workflowId: 'workflow-secret-test',
      triggerId: 'webhook',
      secret: sentinel,
    },
  } as unknown as WorkflowListPayload)

  const cached = cache.getWorkflowList('cloud:test')
  assert.equal('webhookSecret' in (cached?.workflows[0]?.triggers[0] || {}), false)
  assert.equal('webhookSecret' in (cached?.workflows[0]?.triggers[1]?.schedule || {}), false)
  assert.equal('webhookSecretReveal' in (cached || {}), false)
  assert.equal(cached?.runs[0]?.triggerPayload, null)
  assert.equal(readFileSync(path, 'utf-8').includes(sentinel), false)
})

test('cloud workspace cache migration removes credential-bearing partitions while preserving unrelated transcripts', () => {
  const path = cachePath()
  const sentinel = 'legacy-workflow-cache-secret-sentinel-1234567890'
  const settingSentinel = 'legacy-setting-cache-secret-sentinel-1234567890'
  const transcriptSentinel = 'legacy-workflow-transcript-secret-sentinel-1234567890'
  const ordinaryTranscriptSentinel = 'legacy-ordinary-transcript-secret-sentinel-1234567890'
  const unsafeOrdinaryView = emptyView('Unsafe ordinary transcript')
  unsafeOrdinaryView.toolCalls = [{
    id: 'tool-workflow-create',
    name: 'mcp__workflows__create_workflow',
    input: {},
    status: 'complete',
    output: {
      webhookSecretReveal: {
        secret: sentinel,
      },
    },
    order: 2,
  }]
  writeFileSync(path, JSON.stringify([{
    workspaceId: 'cloud:test',
    sessions: [
      {
        id: 'session-1',
        title: 'Preserved thread',
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      },
      {
        id: 'session-workflow',
        title: 'Workflow setup',
        kind: 'workflow_draft',
        workflowId: 'legacy-workflow',
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      },
      {
        id: 'session-unsafe',
        title: 'Credential-bearing ordinary thread',
        kind: 'interactive',
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
      },
    ],
    views: {
      'session-1': emptyView(ordinaryTranscriptSentinel),
      'session-workflow': emptyView(transcriptSentinel),
      'session-unsafe': unsafeOrdinaryView,
    },
    workflows: {
      workflows: [{
        id: 'legacy-workflow',
        title: 'Legacy',
        draftSessionId: 'session-workflow',
        triggers: [{ id: 'webhook', type: 'webhook', enabled: true, webhookSecret: sentinel }],
      }],
      runs: [],
    },
    settings: [{
      key: 'appearance',
      value: { theme: 'dark' },
      updatedAt: '2026-07-26T00:00:00.000Z',
    }, {
      key: 'provider-settings',
      value: { nested: { clientSecret: settingSentinel } },
      updatedAt: '2026-07-26T00:00:00.000Z',
    }],
    artifactsBySession: {
      'session-1': [{
        id: 'artifact-1',
        filePath: 'cloud://artifact-1',
        filename: 'report.txt',
        order: 0,
      }],
    },
    updatedAt: '2026-07-26T00:00:00.000Z',
  }]))

  const storage = encryptedStorage()
  const telemetry: Array<{ operation: string, outcome: string, reason: string, encoding: string }> = []
  const cache = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: storage,
    reporter: (event) => telemetry.push(event),
  })
  assert.equal(cache.listSessions('cloud:test')?.[0]?.title, 'Preserved thread')
  assert.equal(cache.getWorkflowList('cloud:test'), null)
  assert.equal(cache.getSessionView('cloud:test', 'session-1')?.messages[0]?.content, ordinaryTranscriptSentinel)
  assert.equal(cache.getSessionView('cloud:test', 'session-workflow'), null)
  assert.equal(cache.getSessionView('cloud:test', 'session-unsafe'), null)
  assert.equal(cache.getSetting('cloud:test', 'appearance')?.value.theme, 'dark')
  assert.equal(cache.getSetting('cloud:test', 'provider-settings'), null)
  assert.equal(cache.listArtifacts('cloud:test', 'session-1')?.[0]?.id, 'artifact-1')
  assert.deepEqual(telemetry, [{
    operation: 'migrate_v1',
    outcome: 'completed',
    reason: 'sensitive_views_removed',
    encoding: 'plaintext',
  }])
  const migrated = storage.decryptString(encryptedCachePayload(readFileSync(path)))
  assert.match(migrated, /"schemaVersion": 2/)
  assert.equal(migrated.includes(sentinel), false)
  assert.equal(migrated.includes(settingSentinel), false)
  assert.equal(migrated.includes(transcriptSentinel), false)
  assert.equal(migrated.includes(ordinaryTranscriptSentinel), true)

  const reopenedTelemetry: Array<{ operation: string, outcome: string, reason: string, encoding: string }> = []
  const reopened = new FileCloudWorkspaceCache({
    path,
    mode: 'full',
    secretStorage: storage,
    reporter: (event) => reopenedTelemetry.push(event),
  })
  assert.equal(reopened.getSessionView('cloud:test', 'session-1')?.messages[0]?.content, ordinaryTranscriptSentinel)
  assert.deepEqual(reopenedTelemetry, [])
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

test('cloud workspace cache batches sync upserts into one durable write (P1-E)', () => {
  const path = cachePath()
  const cache = new FileCloudWorkspaceCache({ path, mode: 'metadata-only', secretStorage: encryptedStorage() })
  const session = (id: string, title: string) => ({ id, title, directory: null, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' })
  cache.upsertSessionList('cloud:test', [session('session-1', 'One')])

  cache.beginCacheBatch()
  cache.upsertSessionList('cloud:test', [session('session-1', 'One'), session('session-2', 'Two')])
  // The in-memory read reflects the buffered change immediately…
  assert.equal(cache.listSessions('cloud:test')?.length, 2)
  // …but nothing is written to disk until the batch ends (the coalescing that avoids O(n^2)).
  assert.equal(readFileSync(path, 'utf-8').includes('"Two"'), false)

  cache.endCacheBatch()
  // The single coalesced write persisted the full batch.
  assert.equal(readFileSync(path, 'utf-8').includes('"Two"'), true)
  const reopened = new FileCloudWorkspaceCache({ path, mode: 'metadata-only', secretStorage: encryptedStorage() })
  assert.equal(reopened.listSessions('cloud:test')?.length, 2)
})
