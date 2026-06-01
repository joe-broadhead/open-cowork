import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CLOUD_WEB_ROUTES, CLOUD_WEB_ROUTE_GROUPS, DEFAULT_CLOUD_WEB_ROUTE, findCloudWebRoute } from './app-shell.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientStateContract } from './client-contract.ts'
import { CLOUD_WEB_ROUTE_API_MATRIX } from './route-api-matrix.ts'
import { cloudWebsiteClientScript, cloudWebsiteHtml } from './render.ts'
import { canManageOrg } from './roles.ts'
import {
  CLOUD_WEB_THREAD_PAGE_SIZE,
  cloudWebThreadStatus,
  filterCloudWebThreads,
} from './thread-workbench.ts'
import {
  CLOUD_WEB_RUNTIME_ENTITY_CLASSES,
  cloudWebErrorCategory,
  cloudWebRuntimeCounts,
  cloudWebRuntimeOrder,
  cloudWebSafeArtifactMetadata,
} from './runtime-workbench.ts'
import {
  cloudWebCapabilityPolicyNote,
  cloudWebWorkflowTriggerSummary,
  deriveCloudWebWorkbenchAgents,
  filterCloudWebCapabilities,
} from './surface-workbench.ts'

const html = cloudWebsiteHtml({
  role: 'web',
  profileName: 'default',
  features: {
    chat: true,
    workflows: true,
  },
})

test('cloud website renders workbench and admin shell surfaces', () => {
  assert.match(html, /Open Cowork Cloud/)
  assert.match(html, /Workbench/)
  assert.match(html, /Threads/)
  assert.match(html, /Chat/)
  assert.match(html, /Tools &amp; Skills/)
  assert.match(html, /Artifacts/)
  assert.match(html, /Admin/)
  assert.match(html, /Org/)
  assert.match(html, /Members/)
  assert.match(html, /BYOK/)
  assert.match(html, /Desktop token/)
  assert.match(html, /Gateway token/)
  assert.match(html, /Headless gateway/)
  assert.match(html, /Audit/)
  assert.match(html, /Diagnostics/)
  assert.match(html, /data-route-panel="threads"/)
  assert.match(html, /data-route-panel="byok"/)
})

test('cloud website app shell exposes typed route metadata', () => {
  assert.equal(DEFAULT_CLOUD_WEB_ROUTE, 'threads')
  assert.deepEqual(CLOUD_WEB_ROUTE_GROUPS.map((group) => group.id), ['workbench', 'admin'])
  assert.equal(findCloudWebRoute('threads')?.surface, 'workbench')
  assert.equal(findCloudWebRoute('byok')?.requiresAdmin, true)
  assert.equal(findCloudWebRoute('usage')?.requiresAdmin, false)
})

test('cloud website route/API matrix covers every route and real endpoint id', () => {
  const routes = new Map(CLOUD_WEB_ROUTES.map((route) => [route.id, route]))
  const endpoints = new Set(CLOUD_WEB_CLIENT_ENDPOINTS.map((endpoint) => endpoint.id))
  assert.deepEqual(CLOUD_WEB_ROUTE_API_MATRIX.map((entry) => entry.routeId).sort(), CLOUD_WEB_ROUTES.map((route) => route.id).sort())
  for (const entry of CLOUD_WEB_ROUTE_API_MATRIX) {
    const route = routes.get(entry.routeId)
    assert.ok(route, `route exists for matrix entry ${entry.routeId}`)
    assert.equal(entry.surface, route.surface)
    assert.ok(entry.endpointIds.length > 0, `${entry.routeId} lists backing endpoint ids`)
    assert.ok(entry.states.loading && entry.states.empty && entry.states.error, `${entry.routeId} defines loading/empty/error states`)
    assert.ok(entry.disabledBehavior, `${entry.routeId} defines disabled behavior`)
    assert.ok(entry.pagination, `${entry.routeId} defines pagination/cursor behavior`)
    assert.ok(entry.paginationContract, `${entry.routeId} defines structured pagination contract`)
    assert.equal(typeof entry.paginationContract.implemented, 'boolean', `${entry.routeId} declares pagination implementation status`)
    assert.ok(['cursor', 'bounded-page', 'local-bounded', 'not-applicable', 'deferred'].includes(entry.paginationContract.mode), `${entry.routeId} declares a known pagination mode`)
    assert.ok(['implemented', 'not-applicable', 'deferred'].includes(entry.paginationContract.cursor), `${entry.routeId} declares cursor state`)
    if (entry.paginationContract.mode === 'bounded-page' || entry.paginationContract.mode === 'local-bounded' || entry.paginationContract.limit !== null) {
      assert.ok(
        typeof entry.paginationContract.limit === 'number' && entry.paginationContract.limit > 0,
        `${entry.routeId} declares a positive list limit`,
      )
    }
    assert.ok(entry.redaction, `${entry.routeId} defines redaction behavior`)
    assert.ok(entry.redactionContract, `${entry.routeId} defines structured redaction contract`)
    assert.equal(entry.redactionContract.rawSecretsAllowed, false, `${entry.routeId} forbids raw secrets`)
    assert.ok(entry.redactionContract.browserSanitizer, `${entry.routeId} names the browser/server sanitizer boundary`)
    assert.ok(entry.tests.length > 0, `${entry.routeId} lists test coverage`)
    for (const endpointId of entry.endpointIds) {
      assert.ok(endpoints.has(endpointId), `${entry.routeId} references known endpoint ${endpointId}`)
    }
  }

  const doc = readFileSync(fileURLToPath(new URL('../../../docs/cloud-web-workbench.md', import.meta.url)), 'utf8')
  assert.match(doc, /Route\/API Matrix/)
  for (const route of CLOUD_WEB_ROUTES) {
    assert.match(doc, new RegExp('`' + route.id + '`'), `Cloud Web Workbench docs list ${route.id}`)
  }
  assert.doesNotMatch(doc, /backend cursoring is deferred until the sessions API exposes cursors/)
  assert.match(CLOUD_WEB_ROUTE_API_MATRIX.find((entry) => entry.routeId === 'threads')?.pagination || '', /cursor pages/)
  assert.equal(CLOUD_WEB_ROUTE_API_MATRIX.find((entry) => entry.routeId === 'threads')?.paginationContract.cursor, 'implemented')
  for (const routeId of ['members', 'audit', 'usage', 'gateway', 'connections', 'policy', 'workflows', 'artifacts', 'diagnostics']) {
    const entry = CLOUD_WEB_ROUTE_API_MATRIX.find((candidate) => candidate.routeId === routeId)
    assert.ok(entry, `${routeId} has a route matrix entry`)
    assert.ok(entry.paginationContract.limit === null || entry.paginationContract.limit <= 100, `${routeId} is browser-bounded`)
    assert.equal(entry.redactionContract.rawSecretsAllowed, false, `${routeId} forbids raw secrets`)
  }
})

test('cloud website bootstrap exposes typed client endpoint metadata', () => {
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'config')?.path, '/api/config')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'workspace')?.path, '/api/workspace')
  assert.match(html, /"api":/)
  assert.match(html, /"routeMatrix":/)
  assert.match(cloudWebsiteClientScript(), /endpoint\(id, fallback\)/)
  const stateContract: CloudWebClientStateContract = {
    authStatus: 'loading',
    activeRoute: DEFAULT_CLOUD_WEB_ROUTE,
    workspace: null,
    csrfToken: null,
    selectedSessionId: null,
    sessions: [],
    sessionList: {
      nextCursor: null,
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
      lastSyncedAt: null,
      totalEstimate: null,
      error: null,
    },
    sessionViews: {},
    runtimeActions: {},
    artifactPanel: {
      sessionId: null,
      artifactId: null,
      metadata: null,
      status: 'idle',
      error: null,
    },
    capabilities: {
      tools: [],
      skills: [],
      error: null,
    },
    workflows: {
      workflows: [],
      runs: [],
      error: null,
    },
    usageSummary: null,
    deliveries: [],
    diagnostics: null,
    diagnosticsError: null,
    admin: {
      policy: null,
      members: [],
      workerPools: [],
      workers: [],
      auditEvents: [],
      error: null,
      workerError: null,
    },
    selectedWorkflowId: null,
    workspaceEvents: {
      status: 'idle',
      cursor: 0,
      error: null,
    },
    sessionEvents: {
      status: 'idle',
      sessionId: null,
      cursor: 0,
      error: null,
    },
  }
  assert.equal(stateContract.workspaceEvents.status, 'idle')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'sessions')?.path, '/api/sessions')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'sessionView')?.path, '/api/sessions/:sessionId/view')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'sessionPermissionRespond')?.path, '/api/sessions/:sessionId/permission-respond')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'sessionQuestionReply')?.path, '/api/sessions/:sessionId/question-reply')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'sessionQuestionReject')?.path, '/api/sessions/:sessionId/question-reject')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'sessionArtifact')?.path, '/api/sessions/:sessionId/artifacts/:artifactId')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'capabilitiesCatalog')?.path, '/api/capabilities')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'workflows')?.path, '/api/workflows?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'workflowRun')?.path, '/api/workflows/:workflowId/run')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'projectSourceValidate')?.path, '/api/project-sources/validate')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'projectSnapshots')?.path, '/api/project-sources/snapshots')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminPolicy')?.path, '/api/admin/policy')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'apiTokens')?.path, '/api/api-tokens?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminMembers')?.path, '/api/admin/members?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminMemberInvite')?.method, 'POST')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminMemberUpdate')?.path, '/api/admin/members/:accountId/update')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminAudit')?.path, '/api/admin/audit?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminWorkerPools')?.path, '/api/admin/worker-pools?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminWorkers')?.path, '/api/admin/workers?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminWorkerHeartbeats')?.path, '/api/admin/workers/:workerId/heartbeats?limit=50')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'usageSummary')?.path, '/api/usage/summary?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'diagnostics')?.path, '/api/diagnostics')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'runtimeStatus')?.path, '/api/runtime/status')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'workerHeartbeats')?.path, '/api/workers/heartbeats')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'channelDeliveries')?.path, '/api/channels/deliveries?limit=50')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'channelDeliveryRetry')?.path, '/api/channels/deliveries/:deliveryId/retry')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'channelDeliveryDeadLetter')?.path, '/api/channels/deliveries/:deliveryId/dead-letter')
})

test('cloud website keeps existing admin dashboard surfaces available', () => {
  assert.match(html, /Slack team ID/)
  assert.match(html, /Inbound address/)
  assert.match(html, /Webhook delivery URL/)
  assert.match(html, /Delivery backlog/)
  assert.match(html, /KMS secret ref/)
  assert.match(html, /Quota windows/)
  assert.match(html, /Recent totals/)
  assert.match(html, /id="billing-plan-select"/)
  assert.match(html, /id="diagnostics-health"/)
  assert.match(html, /id="admin-worker-summary"/)
  assert.match(html, /Billing/)
  assert.match(html, /Usage/)
})

test('cloud website renders deployer public branding', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'data-analyst',
    features: {
      chat: true,
      workflows: false,
    },
  }, {
    productName: 'Acme Cowork',
    shortName: 'AC',
    logoUrl: 'https://assets.acme.example/cowork/logo.png',
    supportUrl: 'https://support.acme.example/cowork',
    privacyUrl: 'https://legal.acme.example/privacy',
    theme: {
      accent: '#0f6b4b',
    },
    dashboard: {
      title: 'Acme workspace',
      subtitle: 'Manage Acme clients.',
      connectionsDescription: 'Issue scoped Acme tokens.',
    },
    managedOrgConnectionLabels: {
      desktopToken: 'Acme Desktop token',
      gatewayToken: 'Acme Gateway token',
      apiToken: 'Acme API token',
      cloudUrl: 'Acme Cloud URL',
    },
  })

  assert.match(branded, /<title>Acme Cowork<\/title>/)
  assert.match(branded, /https:\/\/assets\.acme\.example\/cowork\/logo\.png/)
  assert.match(branded, /Acme workspace/)
  assert.match(branded, /Issue scoped Acme tokens/)
  assert.match(branded, /Acme Desktop token/)
  assert.match(branded, /--accent: #0f6b4b;/)
  assert.match(branded, /https:\/\/support\.acme\.example\/cowork/)
  assert.match(branded, /https:\/\/legal\.acme\.example\/privacy/)
})

test('cloud website drops unsafe public branding URLs', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: 'Acme Cowork',
    logoUrl: 'http://assets.example.test/logo.png',
    supportUrl: 'javascript:alert(1)',
    privacyUrl: 'mailto:privacy@example.test',
  })

  assert.doesNotMatch(branded, /http:\/\/assets\.example\.test/)
  assert.doesNotMatch(branded, /javascript:alert/)
  assert.doesNotMatch(branded, /mailto:privacy/)
})

test('cloud website serializes bootstrap JSON for raw script parsing', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: '</script><img src=x onerror=alert(1)>',
    shortName: 'OC',
  })

  const match = branded.match(/<script[^>]+id="open-cowork-cloud-bootstrap"[^>]*>(.*?)<\/script>/s)
  assert.ok(match)
  assert.doesNotMatch(match[1], /<\/script>/i)
  assert.equal(JSON.parse(match[1]).publicBranding.productName, '</script><img src=x onerror=alert(1)>')
})

test('cloud website client avoids persistent browser secret storage', () => {
  const script = cloudWebsiteClientScript()
  assert.equal(script.includes('localStorage'), false)
  assert.equal(script.includes('sessionStorage'), false)
  assert.equal(script.includes('indexedDB'), false)
})

test('cloud website binds actions through the client script', () => {
  assert.equal(html.includes('onclick='), false)
  assert.doesNotThrow(() => new Function(cloudWebsiteClientScript()))
  assert.match(cloudWebsiteClientScript(), /signin-inline/)
  assert.match(cloudWebsiteClientScript(), /\/api\/config/)
  assert.match(cloudWebsiteClientScript(), /\/api\/workspace/)
  assert.match(cloudWebsiteClientScript(), /\/api\/sessions/)
  assert.match(cloudWebsiteClientScript(), /\/view/)
  assert.match(cloudWebsiteClientScript(), /new EventSource/)
  assert.match(cloudWebsiteClientScript(), /sessionEventTypes/)
  assert.match(cloudWebsiteClientScript(), /createCloudSessionFromForm/)
  assert.match(cloudWebsiteClientScript(), /promptSelectedSession/)
  assert.match(cloudWebsiteClientScript(), /respondToPermission/)
  assert.match(cloudWebsiteClientScript(), /answerQuestion/)
  assert.match(cloudWebsiteClientScript(), /rejectQuestion/)
  assert.match(cloudWebsiteClientScript(), /openArtifact/)
  assert.match(cloudWebsiteClientScript(), /safeArtifactMetadata/)
  assert.match(cloudWebsiteClientScript(), /safeOperationalMetadata/)
  assert.match(cloudWebsiteClientScript(), /safeOperationalText/)
  assert.match(cloudWebsiteClientScript(), /renderWorkbenchAgents/)
  assert.match(cloudWebsiteClientScript(), /renderCapabilities/)
  assert.match(cloudWebsiteClientScript(), /renderWorkflows/)
  assert.match(cloudWebsiteClientScript(), /startAgentThread/)
  assert.match(cloudWebsiteClientScript(), /createWorkflowFromForm/)
  assert.match(cloudWebsiteClientScript(), /runWorkflow/)
  assert.match(cloudWebsiteClientScript(), /setRoute/)
  assert.match(cloudWebsiteClientScript(), /providerSettingsFromForm/)
  assert.match(cloudWebsiteClientScript(), /updateBindingProviderFields/)
  assert.match(cloudWebsiteClientScript(), /renderMembers/)
  assert.match(cloudWebsiteClientScript(), /renderAdminPolicy/)
  assert.match(cloudWebsiteClientScript(), /adminWorkerPools/)
  assert.match(cloudWebsiteClientScript(), /renderAudit/)
  assert.match(cloudWebsiteClientScript(), /inviteMember/)
  assert.match(cloudWebsiteClientScript(), /updateMember/)
  assert.match(cloudWebsiteClientScript(), /loadGatewayOps/)
  assert.match(cloudWebsiteClientScript(), /retryDelivery/)
  assert.match(cloudWebsiteClientScript(), /deadLetterDelivery/)
  assert.match(cloudWebsiteClientScript(), /loadDiagnostics/)
  assert.match(cloudWebsiteClientScript(), /exportUsageEvents/)
})

test('cloud website renders cloud thread controls without local host path affordances', () => {
  assert.match(html, /id="thread-list"/)
  assert.match(html, /id="session-form"/)
  assert.match(html, /Git repository URL/)
  assert.match(html, /Uploaded snapshot/)
  assert.match(html, /id="prompt-form"/)
  assert.match(html, /id="chat-timeline"/)
  assert.match(html, /id="workbench-agent-list"/)
  assert.match(html, /id="capability-filter"/)
  assert.match(html, /id="tool-list"/)
  assert.match(html, /id="skill-list"/)
  assert.match(html, /id="workflow-form"/)
  assert.match(html, /id="workflow-list"/)
  assert.match(html, /id="workflow-detail"/)
  assert.match(html, /id="artifact-list"/)
  assert.match(html, /id="artifact-history"/)
  assert.match(html, /id="artifact-detail"/)
  assert.match(html, /id="member-list"/)
  assert.match(html, /id="member-invite-form"/)
  assert.match(html, /id="admin-policy-overview"/)
  assert.match(html, /id="admin-project-policy"/)
  assert.match(html, /id="audit-list"/)
  assert.doesNotMatch(html, /\/Users\//)
  assert.doesNotMatch(html, /local stdio MCP/i)
})

test('cloud website surface helper derives agents, filters capabilities, and summarizes workflow triggers', () => {
  const agents = deriveCloudWebWorkbenchAgents({
    policyAllowedAgents: ['build'],
    tools: [
      { id: 'charts', agentNames: ['data-analyst'], source: 'builtin' },
      { id: 'custom-tool', agentNames: ['custom-agent'], source: 'custom' },
    ],
    skills: [
      { name: 'analysis', agentNames: ['data-analyst'], toolIds: ['charts'], source: 'builtin' },
      { name: 'custom-skill', agentNames: ['custom-agent'], source: 'custom' },
    ],
  })
  assert.deepEqual(agents.map((agent) => agent.name), ['build', 'custom-agent', 'data-analyst'])
  assert.equal(agents.find((agent) => agent.name === 'custom-agent')?.custom, true)
  assert.equal(agents.find((agent) => agent.name === 'data-analyst')?.toolCount, 1)
  assert.equal(agents.find((agent) => agent.name === 'data-analyst')?.skillCount, 1)

  const capabilities = filterCloudWebCapabilities([
    { id: 'charts', label: 'Charts', agentNames: ['data-analyst'], source: 'builtin' },
    { id: 'repo', label: 'Repository', agentNames: ['build'], source: 'builtin' },
  ], 'data charts')
  assert.deepEqual(capabilities.map((capability) => capability.id), ['charts'])
  assert.match(cloudWebCapabilityPolicyNote({ kind: 'mcp', scope: 'machine' }), /Machine-scoped/)
  assert.equal(cloudWebWorkflowTriggerSummary({ triggers: [{ type: 'manual', enabled: true }, { type: 'schedule', enabled: false }] }), 'manual')
  assert.equal(cloudWebWorkflowTriggerSummary({ triggers: [{ type: 'schedule', enabled: true }, { type: 'webhook', enabled: true }] }), 'schedule, webhook')
})

test('cloud website runtime helper covers all runtime entity classes', () => {
  assert.deepEqual(CLOUD_WEB_RUNTIME_ENTITY_CLASSES, [
    'message',
    'taskRun',
    'toolCall',
    'pendingApproval',
    'resolvedApproval',
    'pendingQuestion',
    'resolvedQuestion',
    'artifact',
    'todo',
    'error',
    'usage',
    'context',
  ])
  const counts = cloudWebRuntimeCounts({
    messages: [{ id: 'message-1' }],
    taskRuns: [{ id: 'task-1' }],
    toolCalls: [{ id: 'tool-1' }],
    pendingApprovals: [{ id: 'approval-1' }],
    resolvedApprovals: [{ id: 'approval-1' }],
    pendingQuestions: [{ id: 'question-1' }],
    resolvedQuestions: [{ id: 'question-1' }],
    artifacts: [{ artifactId: 'artifact-1' }],
    todos: [{ id: 'todo-1' }],
    errors: [{ id: 'error-1' }],
    sessionCost: 0.13,
    sessionTokens: { input: 10, output: 5, reasoning: 2, cacheRead: 1, cacheWrite: 1 },
    contextState: 'measured',
  })
  assert.equal(counts.message, 1)
  assert.equal(counts.taskRun, 1)
  assert.equal(counts.toolCall, 1)
  assert.equal(counts.pendingApproval, 1)
  assert.equal(counts.resolvedApproval, 1)
  assert.equal(counts.pendingQuestion, 1)
  assert.equal(counts.resolvedQuestion, 1)
  assert.equal(counts.artifact, 1)
  assert.equal(counts.todo, 1)
  assert.equal(counts.error, 1)
  assert.equal(counts.usage, 1)
  assert.equal(counts.context, 1)
  assert.equal(cloudWebRuntimeCounts({ contextState: 'idle' }).context, 0)
})

test('cloud website runtime helper preserves order and classifies errors', () => {
  assert.equal(cloudWebRuntimeOrder({ order: 42 }, 7), 42)
  assert.equal(cloudWebRuntimeOrder({}, 7), 7)
  assert.equal(cloudWebErrorCategory('Policy blocked by profile'), 'policy')
  assert.equal(cloudWebErrorCategory('Unauthorized token'), 'auth')
  assert.equal(cloudWebErrorCategory('Quota exceeded'), 'quota')
  assert.equal(cloudWebErrorCategory('Billing subscription inactive'), 'billing')
  assert.equal(cloudWebErrorCategory('Provider API key invalid'), 'provider')
  assert.equal(cloudWebErrorCategory('Runtime crashed'), 'runtime')
})

test('cloud website artifact metadata redacts transient artifact bodies and URLs', () => {
  assert.deepEqual(cloudWebSafeArtifactMetadata({
    artifactId: 'artifact-1',
    filename: 'result.txt',
    dataBase64: 'YQ==',
    signedUrl: 'https://object.example.test/signed?token=secret',
    downloadUrl: 'https://object.example.test/download?token=secret',
    key: 'tenant/session/artifact-1/result.txt',
    bucket: 'open-cowork-prod-artifacts',
    token: 'secret',
  }), {
    artifactId: 'artifact-1',
    filename: 'result.txt',
  })
  assert.match(cloudWebsiteClientScript(), /URL\.createObjectURL/)
  assert.match(cloudWebsiteClientScript(), /URL\.revokeObjectURL/)
})

test('cloud website thread helper handles status filters and thousands-sized lists', () => {
  const sessions = Array.from({ length: CLOUD_WEB_THREAD_PAGE_SIZE + 25 }, (_, index) => ({
    sessionId: `session-${index}`,
    title: index === 50 ? 'Design review' : `Thread ${index}`,
    profileName: index % 2 === 0 ? 'default' : 'data-analyst',
    status: 'idle',
    updatedAt: new Date(Date.UTC(2026, 4, 29, 12, 0, index % 60)).toISOString(),
    tags: index === 50 ? ['customer-a'] : [],
  }))
  const views = {
    'session-50': {
      projection: {
        view: {
          status: 'running',
          pendingApprovals: [{ id: 'approval-1' }],
          projectSource: { kind: 'git', repositoryUrl: 'https://github.com/acme/app.git' },
        },
      },
    },
    'session-51': {
      projection: {
        view: {
          status: 'running',
          pendingQuestions: [{ id: 'question-1' }],
          projectSource: { kind: 'snapshot', title: 'Browser upload' },
        },
      },
    },
  }

  assert.equal(cloudWebThreadStatus(sessions[50], views['session-50'].projection.view), 'approval')
  assert.equal(cloudWebThreadStatus(sessions[51], views['session-51'].projection.view), 'question')
  assert.equal(filterCloudWebThreads(sessions, views).length, CLOUD_WEB_THREAD_PAGE_SIZE)
  assert.deepEqual(filterCloudWebThreads(sessions, views, { status: 'approval' }).map((session) => session.sessionId), ['session-50'])
  assert.deepEqual(filterCloudWebThreads(sessions, views, { project: 'snapshot' }).map((session) => session.sessionId), ['session-51'])
  assert.deepEqual(filterCloudWebThreads(sessions, views, { query: 'design customer-a app' }).map((session) => session.sessionId), ['session-50'])
})

test('cloud website disables dynamic admin actions for member roles', () => {
  const script = cloudWebsiteClientScript()
  assert.match(script, /Validate', \(\) => validateByok\(secret\.providerId\), 'secondary', adminLocked\(\)\)/)
  assert.match(script, /Revoke', \(\) => revokeToken\(token\.tokenId\), 'danger', adminLocked\(\)\)/)
  assert.match(html, /data-requires-admin="true"/)
})

test('cloud website renders signed-out, member, admin, and policy-disabled states', () => {
  const member = cloudWebsiteHtml({
    role: 'member',
    profileName: 'default',
    features: {
      chat: false,
      workflows: false,
    },
  })
  assert.match(member, /<strong id="role-name">member<\/strong>/)
  assert.match(member, /Admin actions are disabled for this role/)
  assert.match(member, /data-route-panel="members"[^>]+data-requires-admin="true"/)
  assert.match(member, /<span class="pill" data-kind="warn">disabled<\/span>/)

  const owner = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  })
  assert.match(owner, /<strong id="role-name">admin<\/strong>/)
  assert.match(owner, /data-route-panel="diagnostics"/)
  assert.match(owner, /signed-out-only/)
})

test('cloud website role helper gates admin controls', () => {
  assert.equal(canManageOrg('owner'), true)
  assert.equal(canManageOrg('admin'), true)
  assert.equal(canManageOrg('member'), false)
  assert.equal(canManageOrg(null), false)
})
