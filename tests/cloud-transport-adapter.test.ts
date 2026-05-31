import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createHttpSseCloudTransportAdapter,
  type CloudTransportEventSource,
  type CloudTransportFetch,
} from '../apps/desktop/src/main/cloud/transport-adapter.ts'
import { CLOUD_SESSION_EVENT_TYPES } from '../packages/shared/dist/cloud-session-projection.js'

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

test('cloud transport adapter maps session commands to HTTP routes with CSRF', async () => {
  const requests: Array<{ url: string, init?: Parameters<CloudTransportFetch>[1] }> = []
  const fetcher: CloudTransportFetch = async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/api/config')) {
      return jsonResponse({
        role: 'web',
        profileName: 'full',
        features: { chat: true },
        allowedAgents: null,
        allowedTools: null,
        allowedMcps: null,
      })
    }
    if (url.endsWith('/api/sessions')) {
      if (init?.method === 'POST') {
        return jsonResponse({ session: { sessionId: 'session-1' }, projection: null }, 201)
      }
      return jsonResponse({ sessions: [{ sessionId: 'session-1' }] })
    }
    if (url.includes('/api/sessions?')) {
      return jsonResponse({
        sessions: [{ sessionId: 'session-2' }],
        nextCursor: 'cursor-2',
        totalEstimate: 2,
      })
    }
    if (url.endsWith('/api/import/sessions')) {
      return jsonResponse({
        session: { sessionId: 'session-imported' },
        projection: {
          messages: [{ id: 'm1', role: 'user', content: 'imported', createdAt: '2026-05-27T10:00:00.000Z' }],
          origin: {
            kind: 'local-session-import',
            sourceFingerprint: 'sha256:import',
            importedAt: '2026-05-27T10:00:00.000Z',
            itemCounts: { messages: 1, artifacts: 0, attachments: 0, projectSource: 0, excluded: 1 },
          },
        },
      }, 201)
    }
    if (url.endsWith('/api/sessions/session-1/prompt')) {
      return jsonResponse({ command: { commandId: 'cmd-1' }, processed: 0, view: { session: {}, projection: null } }, 202)
    }
    if (url.endsWith('/api/sessions/session-1/question-reply')) {
      return jsonResponse({ command: { commandId: 'cmd-2' }, processed: 0 }, 202)
    }
    if (url.endsWith('/api/sessions/session-1/question-reject')) {
      return jsonResponse({ command: { commandId: 'cmd-3' }, processed: 0 }, 202)
    }
    if (url.endsWith('/api/sessions/session-1/permission-respond')) {
      return jsonResponse({ command: { commandId: 'cmd-4' }, processed: 0 }, 202)
    }
    if (url.endsWith('/api/sessions/session-1/artifacts')) {
      if (init?.method === 'POST') {
        return jsonResponse({
          artifact: {
            artifactId: 'artifact-2',
            sessionId: 'session-1',
            filename: 'upload.txt',
            contentType: 'text/plain',
            size: 5,
            key: 'tenant/session/artifact-2/upload.txt',
            createdAt: '2026-05-27T10:02:00.000Z',
          },
        }, 201)
      }
      return jsonResponse({
        artifacts: [{
          artifactId: 'artifact-1',
          sessionId: 'session-1',
          filename: 'result.txt',
          contentType: 'text/plain',
          size: 5,
          key: 'tenant/session/artifact-1/result.txt',
          createdAt: '2026-05-27T10:01:00.000Z',
        }],
      })
    }
    if (url.endsWith('/api/sessions/session-1/artifacts/artifact-1')) {
      return jsonResponse({
        artifact: {
          artifactId: 'artifact-1',
          sessionId: 'session-1',
          filename: 'result.txt',
          contentType: 'text/plain',
          size: 5,
          key: 'tenant/session/artifact-1/result.txt',
          createdAt: '2026-05-27T10:01:00.000Z',
          dataBase64: Buffer.from('hello').toString('base64'),
        },
      })
    }
    if (url.endsWith('/api/workflows')) {
      return jsonResponse({ workflows: [{ id: 'workflow-1' }], runs: [] })
    }
    if (url.endsWith('/api/workflows/workflow-1')) {
      return jsonResponse({ workflow: { id: 'workflow-1', status: 'active' } })
    }
    if (url.endsWith('/api/workflows/workflow-1/run')) {
      return jsonResponse({ run: { id: 'run-1', workflowId: 'workflow-1', status: 'running' } }, 202)
    }
    if (url.endsWith('/api/workflows/workflow-1/pause')) {
      return jsonResponse({ workflow: { id: 'workflow-1', status: 'paused' } })
    }
    if (url.includes('/api/threads?')) {
      return jsonResponse({
        threads: [{
          sessionId: 'session-1',
          title: 'Cloud thread',
          profileName: 'default',
          status: 'running',
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:01:00.000Z',
          tags: [{
            tagId: 'tag-1',
            name: 'Important',
            color: '#123456',
            createdAt: '2026-05-27T10:00:00.000Z',
            updatedAt: '2026-05-27T10:00:00.000Z',
          }],
        }],
      })
    }
    if (url.endsWith('/api/threads/tags')) {
      if (init?.method === 'POST') {
        return jsonResponse({ tag: { tagId: 'tag-2', name: 'New', color: '#abcdef' } }, 201)
      }
      return jsonResponse({ tags: [{ tagId: 'tag-1', name: 'Important', color: '#123456' }] })
    }
    if (url.endsWith('/api/threads/tags/tag-1')) {
      if (init?.method === 'DELETE') return jsonResponse({ deleted: true })
      return jsonResponse({ tag: { tagId: 'tag-1', name: 'Renamed', color: '#654321' } })
    }
    if (url.endsWith('/api/threads/tags/tag-1/apply') || url.endsWith('/api/threads/tags/tag-1/remove')) {
      return jsonResponse({ ok: true })
    }
    if (url.endsWith('/api/threads/smart-filters')) {
      if (init?.method === 'POST') {
        return jsonResponse({ filter: { filterId: 'filter-2', name: 'New filter', query: {}, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' } }, 201)
      }
      return jsonResponse({ filters: [{ filterId: 'filter-1', name: 'Mine', query: {}, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }] })
    }
    if (url.endsWith('/api/threads/smart-filters/filter-1')) {
      if (init?.method === 'DELETE') return jsonResponse({ deleted: true })
      return jsonResponse({ filter: { filterId: 'filter-1', name: 'Updated', query: {}, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' } })
    }
    if (url.endsWith('/api/runtime/status')) {
      return jsonResponse({
        role: 'web',
        profileName: 'full',
        canExecute: false,
        commandProcessing: 'delegated',
        checkpoints: false,
        heartbeats: [],
      })
    }
    if (url.endsWith('/api/capabilities/tools')) {
      return jsonResponse({
        tools: [{
          id: 'read',
          name: 'Read',
          description: 'Read files',
          kind: 'built-in',
          source: 'builtin',
          patterns: ['read'],
          agentNames: ['build'],
        }],
      })
    }
    if (url.endsWith('/api/capabilities/tools/read')) {
      return jsonResponse({
        tool: {
          id: 'read',
          name: 'Read',
          description: 'Read files',
          kind: 'built-in',
          source: 'builtin',
          patterns: ['read'],
          agentNames: ['build'],
        },
      })
    }
    if (url.endsWith('/api/capabilities/skills')) {
      return jsonResponse({
        skills: [{
          name: 'analysis',
          label: 'Analysis',
          description: 'Analyze data',
          source: 'builtin',
          toolIds: ['read'],
          agentNames: ['data-analyst'],
        }],
      })
    }
    if (url.endsWith('/api/capabilities/skills/analysis/bundle')) {
      return jsonResponse({
        bundle: {
          name: 'analysis',
          source: 'builtin',
          content: '# Analysis',
          files: [{ path: 'examples/report.md', content: 'report example' }],
        },
      })
    }
    if (url.endsWith('/api/settings')) {
      return jsonResponse({
        settings: [{
          key: 'portable-settings',
          value: { selectedProviderId: 'anthropic' },
          updatedAt: '2026-05-27T10:00:00.000Z',
        }],
      })
    }
    if (url.endsWith('/api/settings/portable-settings')) {
      if (init?.method === 'PUT') {
        return jsonResponse({
          setting: {
            key: 'portable-settings',
            value: JSON.parse(init.body || '{}').value,
            updatedAt: '2026-05-27T10:01:00.000Z',
          },
        })
      }
      return jsonResponse({
        setting: {
          key: 'portable-settings',
          value: { selectedProviderId: 'anthropic' },
          updatedAt: '2026-05-27T10:00:00.000Z',
        },
      })
    }
    return jsonResponse({ error: 'not found' }, 404)
  }
  const transport = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cloud.example.test/',
    fetch: fetcher,
    csrfToken: 'csrf-token',
    credentials: 'include',
  })

  assert.equal((await transport.getConfig()).profileName, 'full')
  assert.equal((await transport.getRuntimeStatus()).commandProcessing, 'delegated')
  assert.deepEqual((await transport.listSessions()).map((session) => session.sessionId), ['session-1'])
  assert.deepEqual(await transport.listSessionsPage?.({
    limit: 25,
    cursor: 'cursor-1',
    status: 'running',
    profileName: 'full',
    query: 'revenue',
  }), {
    sessions: [{ sessionId: 'session-2' }],
    nextCursor: 'cursor-2',
    totalEstimate: 2,
  })
  assert.equal((await transport.createSession()).session.sessionId, 'session-1')
  assert.equal((await transport.importSession({
    source: { kind: 'local-session', fingerprint: 'sha256:import', title: 'Imported' },
    title: 'Imported',
    selection: { includeMessages: true },
    itemCounts: { messages: 1, artifacts: 0, attachments: 0, projectSource: 0, excluded: 1 },
    messages: [{ id: 'm1', role: 'user', content: 'imported', order: 1 }],
  })).session.sessionId, 'session-imported')
  assert.equal((await transport.promptSession('session-1', { text: 'hello' })).processed, 0)
  assert.equal((await transport.replyToQuestion('session-1', { requestId: 'q1', answers: ['A'] })).processed, 0)
  assert.equal((await transport.rejectQuestion('session-1', { requestId: 'q2' })).processed, 0)
  assert.equal((await transport.respondToPermission('session-1', { permissionId: 'p1', response: { allowed: true } })).processed, 0)
  assert.equal((await transport.listWorkflows?.())?.workflows[0]?.id, 'workflow-1')
  assert.equal((await transport.getWorkflow?.('workflow-1'))?.id, 'workflow-1')
  assert.equal((await transport.runWorkflow?.('workflow-1'))?.id, 'run-1')
  assert.equal((await transport.pauseWorkflow?.('workflow-1'))?.status, 'paused')
  assert.equal((await transport.searchThreads?.({ tagIds: ['tag-1'], limit: 10 }))?.threads[0]?.tags[0]?.id, 'tag-1')
  assert.equal((await transport.threadFacets?.({ tagIds: ['tag-1'] }))?.tags[0]?.value, 'tag-1')
  assert.equal((await transport.listThreadTags?.())?.[0]?.id, 'tag-1')
  assert.equal((await transport.createThreadTag?.({ name: 'New' }))?.id, 'tag-2')
  assert.equal((await transport.updateThreadTag?.('tag-1', { name: 'Renamed', color: '#654321' }))?.name, 'Renamed')
  assert.equal(await transport.applyThreadTags?.(['session-1'], ['tag-1']), true)
  assert.equal(await transport.removeThreadTags?.(['session-1'], ['tag-1']), true)
  assert.equal(await transport.deleteThreadTag?.('tag-1'), true)
  assert.equal((await transport.listThreadSmartFilters?.())?.[0]?.id, 'filter-1')
  assert.equal((await transport.createThreadSmartFilter?.({ name: 'New filter', query: {} }))?.id, 'filter-2')
  assert.equal((await transport.updateThreadSmartFilter?.('filter-1', { name: 'Updated', query: {} }))?.name, 'Updated')
  assert.equal(await transport.deleteThreadSmartFilter?.('filter-1'), true)
  const artifact = (await transport.listArtifacts?.('session-1'))?.[0]
  assert.equal(artifact?.cloudArtifactId, 'artifact-1')
  assert.equal(artifact?.filePath, 'cloud-artifact://artifact-1/result.txt')
  assert.equal((await transport.uploadArtifact?.('session-1', {
    filename: 'upload.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('hello').toString('base64'),
  }))?.cloudArtifactId, 'artifact-2')
  const attachment = await transport.readArtifactAttachment?.('session-1', artifact?.filePath || 'artifact-1')
  assert.equal(attachment?.mime, 'text/plain')
  assert.equal(attachment?.filename, 'result.txt')
  assert.equal(attachment?.url, `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`)
  assert.equal((await transport.listCapabilityTools?.())?.[0]?.id, 'read')
  assert.equal((await transport.getCapabilityTool?.('read'))?.name, 'Read')
  assert.equal((await transport.listCapabilitySkills?.())?.[0]?.name, 'analysis')
  assert.equal((await transport.getCapabilitySkillBundle?.('analysis'))?.name, 'analysis')
  assert.equal(await transport.readCapabilitySkillBundleFile?.('analysis', 'examples/report.md'), 'report example')
  assert.equal((await transport.listSettings?.())?.[0]?.key, 'portable-settings')
  assert.equal((await transport.getSetting?.('portable-settings'))?.value.selectedProviderId, 'anthropic')
  assert.equal((await transport.setSetting?.('portable-settings', { selectedProviderId: 'openai' }))?.value.selectedProviderId, 'openai')

  const mutating = requests.filter((request) => request.init?.method === 'POST')
  const putRequests = requests.filter((request) => request.init?.method === 'PUT')
  assert.equal(mutating.every((request) => request.init?.headers?.['x-csrf-token'] === 'csrf-token'), true)
  assert.equal(mutating.every((request) => request.init?.credentials === 'include'), true)
  assert.equal(putRequests.every((request) => request.init?.headers?.['x-csrf-token'] === 'csrf-token'), true)
  assert.deepEqual(
    mutating.map((request) => new URL(request.url).pathname),
    [
      '/api/sessions',
      '/api/import/sessions',
      '/api/sessions/session-1/prompt',
      '/api/sessions/session-1/question-reply',
      '/api/sessions/session-1/question-reject',
      '/api/sessions/session-1/permission-respond',
      '/api/workflows/workflow-1/run',
      '/api/workflows/workflow-1/pause',
      '/api/threads/tags',
      '/api/threads/tags/tag-1/apply',
      '/api/threads/tags/tag-1/remove',
      '/api/threads/smart-filters',
      '/api/sessions/session-1/artifacts',
    ],
  )
})

test('cloud transport adapter builds Last-Event-ID compatible SSE URLs and subscriptions', () => {
  const instances: Array<{
    url: string
    init?: { withCredentials?: boolean }
    listeners: Map<string, (event: { data: string }) => void>
    onmessage: ((event: { data: string }) => void) | null
    onerror: ((event: unknown) => void) | null
    closed: boolean
  }> = []
  const EventSourceImpl: CloudTransportEventSource = class {
    readonly url: string
    readonly init?: { withCredentials?: boolean }
    readonly listeners = new Map<string, (event: { data: string }) => void>()
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    closed = false

    constructor(
      url: string,
      init?: { withCredentials?: boolean },
    ) {
      this.url = url
      this.init = init
      instances.push(this)
    }

    addEventListener(type: string, listener: (event: { data: string }) => void) {
      this.listeners.set(type, listener)
    }

    close() {
      this.closed = true
    }
  }
  const transport = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cloud.example.test',
    eventSource: EventSourceImpl,
    credentials: 'include',
  })
  const events: unknown[] = []
  const subscription = transport.subscribeSessionEvents('session 1', {
    afterSequence: 42,
    onEvent: (event) => events.push(event),
  })

  assert.equal(
    transport.sessionEventsUrl('session 1', 42),
    'https://cloud.example.test/api/sessions/session%201/events?after=42',
  )
  assert.equal(
    transport.workspaceEventsUrl(42),
    'https://cloud.example.test/api/events?after=42',
  )
  assert.equal(instances[0]?.url, 'https://cloud.example.test/api/sessions/session%201/events?after=42')
  assert.equal(instances[0]?.init?.withCredentials, true)
  assert.deepEqual([...instances[0]!.listeners.keys()].sort(), [...CLOUD_SESSION_EVENT_TYPES].sort())
  instances[0]?.listeners.get('assistant.message')?.({
    data: JSON.stringify({
      sequence: 43,
      eventId: 'event-43',
      type: 'assistant.message',
      payload: { content: 'hello' },
    }),
  })
  assert.deepEqual(events, [{
    sequence: 43,
    eventId: 'event-43',
    type: 'assistant.message',
    payload: { content: 'hello' },
  }])
  subscription.close()
  assert.equal(instances[0]?.closed, true)

  const workspaceEvents: unknown[] = []
  const workspaceSubscription = transport.subscribeWorkspaceEvents({
    afterSequence: 44,
    onEvent: (event) => workspaceEvents.push(event),
  })
  assert.equal(instances[1]?.url, 'https://cloud.example.test/api/events?after=44')
  assert.deepEqual([...instances[1]!.listeners.keys()].sort(), [...CLOUD_SESSION_EVENT_TYPES].sort())
  instances[1]?.listeners.get('session.created')?.({
    data: JSON.stringify({
      sequence: 45,
      eventId: 'event-45',
      sessionId: 'session-2',
      type: 'session.created',
      payload: { title: 'New cloud session' },
    }),
  })
  assert.deepEqual(workspaceEvents, [{
    sequence: 45,
    eventId: 'event-45',
    sessionId: 'session-2',
    type: 'session.created',
    payload: { title: 'New cloud session' },
  }])
  workspaceSubscription.close()
  assert.equal(instances[1]?.closed, true)
})

test('cloud transport adapter authenticates SSE subscriptions with bearer headers', async () => {
  const requests: Array<{ url: string, init?: Parameters<CloudTransportFetch>[1] }> = []
  const fetcher: CloudTransportFetch = async (url, init) => {
    requests.push({ url, init })
    return {
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            'event: assistant.message',
            'data: {"sequence":7,"eventId":"event-7","type":"assistant.message","payload":{"content":"hello"}}',
            '',
            '',
          ].join('\n')))
          controller.close()
        },
      }),
    }
  }
  const EventSourceImpl: CloudTransportEventSource = class {
    constructor() {
      throw new Error('EventSource should not be used when bearer headers are configured.')
    }
    close() {}
    addEventListener() {}
    onmessage = null
    onerror = null
  }
  const transport = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cloud.example.test',
    fetch: fetcher,
    eventSource: EventSourceImpl,
    credentials: 'include',
    headers: {
      authorization: 'Bearer cloud-token',
    },
  })
  const delivered = new Promise<unknown>((resolve, reject) => {
    const subscription = transport.subscribeSessionEvents('session-1', {
      onEvent: (event) => {
        subscription.close()
        resolve(event)
      },
      onError: reject,
    })
  })

  assert.deepEqual(await delivered, {
    sequence: 7,
    eventId: 'event-7',
    type: 'assistant.message',
    payload: { content: 'hello' },
  })
  assert.equal(requests[0]?.url, 'https://cloud.example.test/api/sessions/session-1/events')
  assert.equal(requests[0]?.init?.headers?.authorization, 'Bearer cloud-token')
  assert.equal(requests[0]?.init?.headers?.accept, 'text/event-stream')
  assert.equal(requests[0]?.init?.credentials, 'include')
})
