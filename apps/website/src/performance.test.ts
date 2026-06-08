import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createCloudWebBrowserHarness, waitFor } from './browser-test-harness.ts'
import { CLOUD_WEB_THREAD_PAGE_SIZE, filterCloudWebThreads, type CloudWebThreadSession, type CloudWebThreadView } from './thread-workbench.ts'
import { deriveCloudWebWorkbenchAgents, filterCloudWebCapabilities } from './surface-workbench.ts'

const THREAD_COUNT = 10_000

function budget(name: string, durationMs: number, limitMs: number) {
  assert.ok(durationMs <= limitMs, `${name} took ${durationMs.toFixed(1)}ms; budget is ${limitMs}ms`)
}

function makeSessions(count: number): CloudWebThreadSession[] {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `session-${index}`,
    title: `Scale fixture ${index}`,
    profileName: index % 4 === 0 ? 'data-analyst' : 'default',
    status: index % 53 === 0 ? 'running' : 'idle',
    updatedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, index % 60)).toISOString(),
    tags: index % 11 === 0 ? ['finance'] : [],
    smartFilters: index % 19 === 0 ? ['recent'] : [],
  }))
}

function makeViews(sessions: CloudWebThreadSession[]): Record<string, CloudWebThreadView> {
  const entries: Array<[string, CloudWebThreadView]> = []
  for (const session of sessions) {
    const index = Number(session.sessionId.replace('session-', ''))
    if (index % 25 !== 0) continue
    entries.push([session.sessionId, {
      session,
      projection: {
        view: {
          status: session.status,
          profileName: session.profileName,
          updatedAt: session.updatedAt,
          pendingApprovals: index % 100 === 0 ? [{ id: `approval-${index}` }] : [],
          pendingQuestions: index % 175 === 0 ? [{ id: `question-${index}` }] : [],
          projectSource: index % 3 === 0
            ? { kind: 'git', repositoryUrl: `https://github.com/acme/repo-${index}.git` }
            : null,
          tags: session.tags,
          smartFilters: session.smartFilters,
        },
      },
    }])
  }
  return Object.fromEntries(entries)
}

test('cloud web thread filtering handles 10k sessions within bounded budgets', () => {
  const sessions = makeSessions(THREAD_COUNT)
  const views = makeViews(sessions)

  const allStart = performance.now()
  const all = filterCloudWebThreads(sessions, views, {})
  budget('10k default thread filter', performance.now() - allStart, 350)
  assert.equal(all.length, CLOUD_WEB_THREAD_PAGE_SIZE)

  const queryStart = performance.now()
  const queried = filterCloudWebThreads(sessions, views, { query: 'Scale 9999' })
  budget('10k query thread filter', performance.now() - queryStart, 450)
  assert.deepEqual(queried.map((session) => session.sessionId), ['session-9999'])

  const approvalStart = performance.now()
  const approvals = filterCloudWebThreads(sessions, views, { status: 'approval' }, 500)
  budget('10k approval thread filter', performance.now() - approvalStart, 450)
  assert.ok(approvals.length > 50)
  assert.ok(approvals.every((session) => Number(session.sessionId.replace('session-', '')) % 100 === 0))
})

test('cloud web capability and agent fixtures handle hundreds of custom surfaces', () => {
  const tools = Array.from({ length: 600 }, (_, index) => ({
    id: `tool-${index}`,
    label: `Tool ${index}`,
    source: index % 5 === 0 ? 'custom' : 'builtin',
    kind: 'tool',
    agentNames: [`agent-${index % 80}`],
  }))
  const skills = Array.from({ length: 600 }, (_, index) => ({
    id: `skill-${index}`,
    label: `Skill ${index}`,
    source: index % 7 === 0 ? 'custom' : 'builtin',
    kind: index % 13 === 0 ? 'mcp' : 'skill',
    scope: index % 13 === 0 ? 'machine' : 'profile',
    agentNames: [`agent-${index % 80}`],
    toolIds: [`tool-${index % 120}`],
  }))

  const deriveStart = performance.now()
  const agents = deriveCloudWebWorkbenchAgents({ policyAllowedAgents: ['build', 'data-analyst'], tools, skills })
  budget('agent derivation over large capability catalog', performance.now() - deriveStart, 120)
  assert.equal(agents.length, 82)

  const filterStart = performance.now()
  const filtered = filterCloudWebCapabilities([...tools, ...skills], 'custom agent-7')
  budget('capability filtering over large catalog', performance.now() - filterStart, 120)
  assert.ok(filtered.length > 10)
  assert.ok(filtered.every((item) => String(item.source).includes('custom') && item.agentNames?.some((name) => name.includes('agent-7'))))
})

test('cloud web browser renders 10k session lists with bounded DOM work', async () => {
  const start = performance.now()
  const harness = await createCloudWebBrowserHarness({
    role: 'admin',
    sessionCount: THREAD_COUNT,
    hydratedViewCount: 10,
  }).start()
  try {
    await waitFor(() => assert.equal(harness.document.querySelectorAll('#thread-list [role="row"]').length, CLOUD_WEB_THREAD_PAGE_SIZE))
    budget('browser bootstrap with 10k sessions', performance.now() - start, 8000)

    const loadMore = harness.document.querySelector('#thread-load-more') as HTMLButtonElement
    loadMore.click()
    await waitFor(() => assert.equal(harness.document.querySelectorAll('#thread-list [role="row"]').length, CLOUD_WEB_THREAD_PAGE_SIZE * 2))

    const filterStart = performance.now()
    const query = harness.document.querySelector('#thread-query') as HTMLInputElement
    query.value = 'Cloud thread 399'
    query.dispatchEvent(new harness.window.Event('input', { bubbles: true }))
    await waitFor(() => {
      assert.equal(harness.document.querySelector('#thread-count')?.textContent, '1')
      assert.match(harness.document.querySelector('#thread-list')?.textContent || '', /Cloud thread 399/)
    })
    budget('browser filter update with 10k sessions', performance.now() - filterStart, 1500)

    const workspaceSource = harness.eventSources.find((source) => source.url === '/api/events')
    assert.ok(workspaceSource, 'workspace SSE source is open')
    const requestCount = harness.requests.length
    workspaceSource.emit('snapshot.required', { type: 'snapshot.required', sequence: 0 })
    await waitFor(() => {
      assert.ok(harness.requests.length > requestCount)
      assert.equal(harness.document.querySelector('#thread-count')?.textContent, '1')
    })
  } finally {
    harness.close()
  }
})

test('cloud web browser keeps large admin surfaces bounded across route transitions', async () => {
  const start = performance.now()
  const harness = await createCloudWebBrowserHarness({
    role: 'admin',
    memberCount: 1_000,
    tokenCount: 1_000,
    deliveryCount: 1_000,
    workflowCount: 1_000,
    workerCount: 1_000,
    auditCount: 1_000,
    usageCount: 1_000,
    artifactCount: 1_000,
  }).start()
  try {
    await waitFor(() => assert.equal(harness.document.querySelectorAll('#member-list .member-row').length, 100))
    await waitFor(() => assert.ok(harness.document.querySelector('#sidebar-thread-list button')))
    ;(harness.document.querySelector('#sidebar-thread-list button') as HTMLButtonElement).click()
    await waitFor(() => assert.equal(harness.document.body.dataset.chatState, 'thread'))
    budget('browser bootstrap with large admin fixtures', performance.now() - start, 8000)

    const routeStart = performance.now()
    for (const label of ['Members', 'Connections', 'Gateway', 'Audit', 'Usage', 'Playbooks', 'Artifacts']) {
      harness.clickText('[data-route-link]', label)
    }
    budget('admin route transitions over large fixtures', performance.now() - routeStart, 1200)

    assert.equal(harness.document.querySelectorAll('#member-list .member-row').length, 100)
    assert.equal(harness.document.querySelectorAll('#token-list > .row').length, 100)
    assert.equal(harness.document.querySelectorAll('#delivery-list > .row').length, 50)
    assert.equal(harness.document.querySelectorAll('#workflow-list [role="row"]').length, 100)
    assert.equal(harness.document.querySelectorAll('#audit-list > .row').length, 100)
    assert.equal(harness.document.querySelectorAll('#artifact-list .artifact-card').length, 100)
  } finally {
    harness.close()
  }
})
