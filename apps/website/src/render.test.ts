import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CLOUD_WEB_ADMIN_SURFACE_MATRIX,
  cloudWebAdminRouteSummary,
  cloudWebAdminSurfaceForRoute,
} from './admin-surface-matrix.ts'
import { CLOUD_WEB_ROUTES, CLOUD_WEB_ROUTE_GROUPS, DEFAULT_CLOUD_WEB_ROUTE, findCloudWebRoute } from './app-shell.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientStateContract } from './client-contract.ts'
import { CLOUD_WEB_ROUTE_API_MATRIX } from './route-api-matrix.ts'
import { cloudWebsiteHtml } from './render.ts'
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
  cloudWebCoworkerInitials,
  cloudWebCoworkerOptionsFromWorkspace,
  cloudWebPromptAssignment,
  cloudWebWorkflowTriggerSummary,
  deriveCloudWebWorkbenchAgents,
  ensureCloudWebCoworkerMention,
  filterCloudWebCapabilities,
  firstCloudWebMentionedCoworker,
} from './surface-workbench.ts'
import {
  CLOUD_WEB_WORKBENCH_PARITY_MATRIX,
  cloudWebWorkbenchParityForRoute,
  cloudWebWorkbenchRouteSummary,
} from './workbench-parity.ts'
import { DEFAULT_WEBSITE_PUBLIC_BRANDING } from './branding.ts'
import { cloudThemePresetOptions } from './cloud-theme.ts'

const html = cloudWebsiteHtml({
  role: 'web',
  profileName: 'default',
  features: {
    chat: true,
    workflows: true,
  },
})

const repositoryTestsDir = new URL('../../../tests/', import.meta.url)

function routeMatrixTestUrl(filename: string) {
  if (filename === 'cloud-continuation-e2e.test.ts') return new URL(filename, repositoryTestsDir)
  return new URL(filename, import.meta.url)
}

const parityAvailabilityDocLabels = {
  shared: 'Shared with Desktop',
  'cloud-only': 'Cloud-only',
  'desktop-only': 'Desktop-only',
  'intentionally-unavailable': 'Unavailable in Cloud',
} as const

function markdownTableCell(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

function parityDocRow(entry: (typeof CLOUD_WEB_WORKBENCH_PARITY_MATRIX)[number]) {
  const routes = entry.cloudRouteIds.map((routeId) => `\`${routeId}\``).join(', ')
  return `| ${markdownTableCell(entry.label)} | ${parityAvailabilityDocLabels[entry.availability]} | ${routes} | ${markdownTableCell(entry.cloudAffordance)} | ${markdownTableCell(entry.boundary)} |`
}

function adminSurfaceDocRow(entry: (typeof CLOUD_WEB_ADMIN_SURFACE_MATRIX)[number]) {
  return `| ${markdownTableCell(entry.label)} | \`${entry.routeId}\` | ${markdownTableCell(entry.desktopSurface)} | ${markdownTableCell(entry.cloudAffordance)} | ${markdownTableCell(entry.sensitiveBoundary)} |`
}

test('cloud website renders Studio and admin shell surfaces', () => {
  assert.match(html, /Open Cowork Cloud/)
  assert.match(html, /Studio/)
  assert.match(html, /Projects/)
  assert.match(html, /Home/)
  assert.match(html, /Coworkers/)
  assert.match(html, /Playbooks/)
  assert.match(html, /Channels/)
  assert.match(html, /Tools &amp; Skills/)
  assert.match(html, /Artifacts/)
  assert.match(html, /Admin controls/)
  assert.match(html, /data-admin-nav/)
  assert.match(html, /Org/)
  assert.match(html, /Members/)
  assert.match(html, /BYOK/)
  assert.match(html, /Desktop token/)
  assert.match(html, /Gateway token/)
  assert.match(html, /Headless gateway/)
  assert.match(html, /Audit/)
  assert.match(html, /Diagnostics/)
  assert.match(html, /data-route-panel="threads"/)
  assert.match(html, /data-route-panel="channels"/)
  assert.match(html, /data-route-panel="byok"/)
  assert.match(html, /data-route-panel="chat"(?=[^>]*data-requires-auth="false")(?![^>]* hidden)[^>]*>/)
  assert.match(html, /data-route-panel="org"(?=[^>]*data-requires-auth="false")(?=[^>]* hidden)[^>]*>/)
  assert.match(html, /What shall we cowork on today\?/)
  assert.match(html, /class="cloud-composer chat-composer-shell"/)
  assert.match(html, /class="composer-toolbar"/)
  assert.match(html, /data-workbench-pane="threads"/)
  assert.match(html, /data-workbench-layout="true"/)
  assert.match(html, /data-workbench-pane="conversation"/)
  assert.match(html, /data-workbench-pane="review"/)
  assert.match(html, /data-action-cluster="true"/)
  assert.match(html, /data-diff-view="true"/)
  assert.match(html, /\.ui-badge\s*\{/)
  assert.match(html, /\.ui-badge--danger\s*\{/)
  assert.match(html, /id="chat-inspector"[\s\S]*hidden/)
  assert.match(html, /class="composer-lead-row" data-has-lead="false"/)
  assert.match(html, /Lead coworker: profile default/)
  assert.match(html, /id="composer-agent-chips"/)
  assert.match(html, /color-scheme: dark/)
  assert.match(html, /font-family: 'Mona Sans Variable'/)
  assert.match(html, /\/assets\/fonts\/mona-sans-latin-wght-normal\.woff2/)
  assert.match(html, /id="open-cowork-cloud-react-root" data-cloud-react-root="true" data-react-status="ssr"/)
  assert.match(html, /data-cloud-react-shell="ssr"/)
  assert.match(html, /data-cloud-react-shell-content="ssr"/)
  assert.match(html, /<script type="module" src="\/assets\/open-cowork-cloud-react\.js" data-cloud-react-client="vite"><\/script>/)
  assert.match(html, /--color-base: #0c0d0f;/)
  assert.match(html, /--accent: #2f6bf0;/)
  assert.match(html, /--accent-2: #5a8cf5;/)
  assert.match(html, /--accent-text: #5a8cf5;/)
  assert.match(html, /--accent-action-foreground: #000000;/)
  assert.match(html, /--accent-gradient: linear-gradient\(150deg,var\(--accent-2\),var\(--accent\)\);/)
  assert.match(html, /--accent-action-fill: linear-gradient\(rgba\(255,255,255,0\.01\),rgba\(255,255,255,0\.01\)\), var\(--accent-gradient\);/)
  assert.match(html, /--cloud-shell-sidebar-w: 248px;/)
  assert.match(html, /font-variant-numeric: tabular-nums;/)
  assert.match(html, /\.nav-links a\[data-active="true"\]/)
  assert.match(html, /box-shadow: var\(--ring-selected\);/)
  assert.match(html, /\.admin-nav:not\(\[open\]\) \.nav-links/)
  assert.match(html, /class="cloud-theme-switcher"/)
  assert.doesNotMatch(html, /body\[data-surface="workbench"\] \.topbar\s*\{[\s\S]*display: none;/)
  assert.match(html, /\.agent-card,/)
  assert.match(html, /\.capability-card/)
  assert.match(html, /\.agent-chip\[data-active="true"\]/)
  assert.match(html, /\.panel \{[\s\S]*border-radius: var\(--radius-lg\);/)
  assert.match(html, /\.pill\[data-kind="info"\]/)
  assert.match(html, /\.message-bubble\[data-role="user"\]/)
  assert.match(html, /\.message-bubble\[data-role="system"\]/)
  assert.match(html, /\.message-bubble\[data-role="error"\]/)
  assert.match(html, /--focus: rgba\(47, 107, 240, 0\.52\);/)
  assert.match(html, /--warn: #e0913a;/)
  assert.match(html, /--danger: #d6587e;/)
  assert.match(html, /--ok: #3f9a8f;/)
  assert.match(html, /"workbenchParity":/)
  assert.match(html, /"adminSurfaces":/)
  assert.match(html, /data-parity-route="threads"/)
  assert.match(html, /data-parity-route="chat"/)
  assert.match(html, /data-admin-surface-route="byok"/)
  assert.match(html, /Provider keys are never rendered after submission/)
  assert.match(html, /Local Filesystem/)
  assert.match(html, /Local Stdio MCPs/)
})

test('cloud website app shell exposes typed route metadata', () => {
  assert.equal(DEFAULT_CLOUD_WEB_ROUTE, 'chat')
  assert.deepEqual(CLOUD_WEB_ROUTE_GROUPS.map((group) => group.id), ['workbench', 'admin'])
  assert.deepEqual(CLOUD_WEB_ROUTE_GROUPS.map((group) => group.label), ['Studio', 'Admin'])
  assert.equal(findCloudWebRoute('chat')?.requiresAuth, false)
  assert.equal(findCloudWebRoute('threads')?.surface, 'workbench')
  assert.equal(findCloudWebRoute('byok')?.requiresAdmin, true)
  assert.equal(findCloudWebRoute('usage')?.requiresAdmin, false)
})

test('cloud website desktop parity matrix covers every Studio route and documented boundary', () => {
  const workbenchRoutes = CLOUD_WEB_ROUTES.filter((route) => route.surface === 'workbench')
  const routeApiIds = new Set(CLOUD_WEB_ROUTE_API_MATRIX.map((entry) => entry.routeId))
  const doc = readFileSync(fileURLToPath(new URL('../../../docs/cloud-web-workbench.md', import.meta.url)), 'utf8')

  assert.match(doc, /Desktop\/Cloud Studio Parity Matrix/)
  assert.ok(CLOUD_WEB_WORKBENCH_PARITY_MATRIX.some((entry) => entry.availability === 'shared'))
  assert.ok(CLOUD_WEB_WORKBENCH_PARITY_MATRIX.some((entry) => entry.availability === 'cloud-only'))
  assert.ok(CLOUD_WEB_WORKBENCH_PARITY_MATRIX.some((entry) => entry.availability === 'desktop-only'))
  assert.ok(CLOUD_WEB_WORKBENCH_PARITY_MATRIX.some((entry) => entry.availability === 'intentionally-unavailable'))

  for (const route of workbenchRoutes) {
    const entries = cloudWebWorkbenchParityForRoute(route.id)
    const sharedEntry = entries.find((entry) => entry.availability === 'shared')
    assert.ok(entries.length > 0, `${route.id} has Desktop/Cloud parity entries`)
    assert.ok(sharedEntry, `${route.id} has at least one shared Desktop concept`)
    assert.equal(route.summary, sharedEntry.cloudAffordance, `${route.id} summary is parity-derived`)
    assert.equal(route.summary, cloudWebWorkbenchRouteSummary(route.id, 'fallback'), `${route.id} helper returns the same summary`)
    assert.ok(routeApiIds.has(route.id), `${route.id} is covered by route/API matrix`)
  }

  for (const entry of CLOUD_WEB_WORKBENCH_PARITY_MATRIX) {
    assert.ok(entry.desktopSurface, `${entry.conceptId} names its Desktop surface`)
    assert.ok(entry.cloudAffordance, `${entry.conceptId} names its Cloud Web affordance`)
    assert.ok(entry.boundary, `${entry.conceptId} documents its product boundary`)
    assert.ok(entry.cloudRouteIds.length > 0, `${entry.conceptId} maps to at least one Cloud route`)
    assert.ok(doc.includes(parityDocRow(entry)), `docs list exact parity row for ${entry.label}`)
    for (const routeId of entry.cloudRouteIds) {
      assert.ok(CLOUD_WEB_ROUTES.some((route) => route.id === routeId), `${entry.conceptId} references existing route ${routeId}`)
    }
    for (const filename of entry.tests) {
      assert.ok(existsSync(fileURLToPath(routeMatrixTestUrl(filename))), `${entry.conceptId} listed test file exists: ${filename}`)
    }
    if (entry.availability === 'desktop-only' || entry.availability === 'intentionally-unavailable') {
      assert.ok(entry.disabledReason, `${entry.conceptId} explains why Cloud Web does not expose it`)
    }
  }
})

test('cloud website admin surface matrix covers every admin route and documented boundary', () => {
  const adminRoutes = CLOUD_WEB_ROUTES.filter((route) => route.surface === 'admin')
  const routeApiIds = new Set(CLOUD_WEB_ROUTE_API_MATRIX.map((entry) => entry.routeId))
  const doc = readFileSync(fileURLToPath(new URL('../../../docs/cloud-web-workbench.md', import.meta.url)), 'utf8')

  assert.match(doc, /Admin\/Settings Surface Matrix/)
  assert.deepEqual(CLOUD_WEB_ADMIN_SURFACE_MATRIX.map((entry) => entry.routeId).sort(), adminRoutes.map((route) => route.id).sort())

  for (const route of adminRoutes) {
    const entry = cloudWebAdminSurfaceForRoute(route.id)
    assert.ok(entry, `${route.id} has an admin surface entry`)
    assert.equal(route.summary, entry.cloudAffordance, `${route.id} summary is admin-surface-derived`)
    assert.equal(route.summary, cloudWebAdminRouteSummary(route.id, 'fallback'), `${route.id} helper returns the same summary`)
    assert.ok(routeApiIds.has(route.id), `${route.id} is covered by route/API matrix`)
  }

  for (const entry of CLOUD_WEB_ADMIN_SURFACE_MATRIX) {
    assert.ok(entry.desktopSurface, `${entry.routeId} names its Desktop analog`)
    assert.ok(entry.cloudAffordance, `${entry.routeId} names its Cloud Web affordance`)
    assert.ok(entry.sensitiveBoundary, `${entry.routeId} documents its sensitive boundary`)
    assert.ok(entry.disabledReason, `${entry.routeId} documents disabled behavior`)
    assert.ok(doc.includes(adminSurfaceDocRow(entry)), `docs list exact admin surface row for ${entry.label}`)
    for (const filename of entry.tests) {
      assert.ok(existsSync(fileURLToPath(routeMatrixTestUrl(filename))), `${entry.routeId} listed test file exists: ${filename}`)
    }
  }
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
    for (const filename of entry.tests) {
      assert.ok(existsSync(fileURLToPath(routeMatrixTestUrl(filename))), `${entry.routeId} listed test file exists: ${filename}`)
    }
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
  assert.equal(CLOUD_WEB_ROUTE_API_MATRIX.find((entry) => entry.routeId === 'chat')?.requiredRole, 'public')
  assert.match(CLOUD_WEB_ROUTE_API_MATRIX.find((entry) => entry.routeId === 'chat')?.states.loading || '', /default public route/)
  assert.doesNotMatch(CLOUD_WEB_ROUTE_API_MATRIX.find((entry) => entry.routeId === 'org')?.states.loading || '', /fallback/)
  for (const routeId of ['members', 'audit', 'usage', 'gateway', 'connections', 'policy', 'workflows', 'channels', 'artifacts', 'diagnostics']) {
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
  assert.match(html, /"adminSurfaces":/)
  assert.doesNotMatch(html, /<script[^>]*>[\s\S]*const bootstrap = JSON\.parse/)
  assert.match(html, /<script type="module" src="\/assets\/open-cowork-cloud-react\.js" data-cloud-react-client="vite"><\/script>/)
  const stateContract: CloudWebClientStateContract = {
    authStatus: 'loading',
    activeRoute: DEFAULT_CLOUD_WEB_ROUTE,
    workspace: null,
    csrfToken: null,
    selectedSessionId: null,
    sessionSelectionGeneration: 0,
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
    channels: {
      agents: [],
      bindings: [],
      deliveries: [],
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
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'artifactsIndex')?.path, '/api/artifacts')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'launchpadFeed')?.path, '/api/launchpad/feed')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'capabilitiesCatalog')?.path, '/api/capabilities')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'workflows')?.path, '/api/workflows?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'workflowRun')?.path, '/api/workflows/:workflowId/run')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'coordinationBoard')?.path, '/api/coordination/board')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'coordinationProjects')?.path, '/api/coordination/projects?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'coordinationProjectCreate')?.method, 'POST')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'coordinationTasks')?.path, '/api/coordination/tasks?limit=500')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'coordinationTaskMove')?.path, '/api/coordination/tasks/:taskId/move')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'coordinationTaskWorkTarget')?.path, '/api/coordination/tasks/:taskId/work-target')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'projectSourceValidate')?.path, '/api/project-sources/validate')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'projectSnapshots')?.path, '/api/project-sources/snapshots')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'adminPolicy')?.path, '/api/admin/policy')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'byokSave')?.path, '/api/byok/:providerId')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'byokValidate')?.path, '/api/byok/:providerId/validate')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'byokDisable')?.method, 'DELETE')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'apiTokens')?.path, '/api/api-tokens?limit=100')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'apiTokenCreate')?.path, '/api/api-tokens')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'apiTokenRevoke')?.path, '/api/api-tokens/:tokenId')
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
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'channelAgentCreate')?.path, '/api/channels/agents')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'channelBindingCreate')?.path, '/api/channels/bindings')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'channelDeliveries')?.path, '/api/channels/deliveries?limit=50')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'channelDeliveryRetry')?.path, '/api/channels/deliveries/:deliveryId/retry')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'channelDeliveryDeadLetter')?.path, '/api/channels/deliveries/:deliveryId/dead-letter')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'billingCheckout')?.path, '/api/billing/checkout')
  assert.equal(CLOUD_WEB_CLIENT_ENDPOINTS.find((endpoint) => endpoint.id === 'billingPortal')?.path, '/api/billing/portal')
})

test('cloud website exposes shared theme presets with tenant branding precedence', () => {
  const match = html.match(/<script[^>]+id="open-cowork-cloud-bootstrap"[^>]*>(.*?)<\/script>/s)
  assert.ok(match)
  const bootstrap = JSON.parse(match[1])
  assert.equal(bootstrap.theme.defaultPreset, 'mercury')
  assert.equal(bootstrap.theme.defaultScheme, 'dark')
  assert.equal(bootstrap.theme.defaultAccent, 'azure')
  assert.equal(bootstrap.theme.defaultDensity, 'regular')
  assert.equal(bootstrap.theme.tenantBrandingLocked, false)
  assert.equal(bootstrap.theme.presets.length, 18)
  assert.equal(bootstrap.theme.accents.length, 6)
  assert.deepEqual(bootstrap.theme.presets.map((preset: { id: string }) => preset.id), cloudThemePresetOptions().map((preset) => preset.id))
  assert.match(html, /id="cloud-theme-preset"/)
  assert.match(html, /id="cloud-theme-scheme"/)
  assert.match(html, /id="cloud-theme-accent"/)
  assert.match(html, /id="cloud-theme-density"/)
  assert.match(html, /<option value="mercury" selected>Mercury<\/option>/)
  assert.match(html, /<option value="dark" selected>Mercury<\/option>/)
  assert.match(html, /<option value="azure" selected>Azure<\/option>/)
  assert.match(html, /<option value="regular" selected>Regular<\/option>/)

  const defaultedBranding = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: { chat: true },
    publicBranding: DEFAULT_WEBSITE_PUBLIC_BRANDING,
  })
  const defaultedBrandingMatch = defaultedBranding.match(/<script[^>]+id="open-cowork-cloud-bootstrap"[^>]*>(.*?)<\/script>/s)
  assert.ok(defaultedBrandingMatch)
  assert.equal(JSON.parse(defaultedBrandingMatch[1]).theme.tenantBrandingLocked, false)
  assert.doesNotMatch(defaultedBranding, /<select(?=[^>]*id="cloud-theme-preset")(?=[^>]*data-tenant-branding-locked="true")(?=[^>]* disabled)[^>]*>/)
  assert.doesNotMatch(defaultedBranding, /<select(?=[^>]*id="cloud-theme-density")(?=[^>]* disabled)[^>]*>/)

  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: { chat: true },
  }, {
    productName: 'Locked Brand',
    theme: { accent: '#0f6b4b' },
  })
  const brandedMatch = branded.match(/<script[^>]+id="open-cowork-cloud-bootstrap"[^>]*>(.*?)<\/script>/s)
  assert.ok(brandedMatch)
  assert.equal(JSON.parse(brandedMatch[1]).theme.tenantBrandingLocked, true)
  assert.match(branded, /<select(?=[^>]*id="cloud-theme-preset")(?=[^>]*data-tenant-branding-locked="true")(?=[^>]* disabled)[^>]*>/)
  assert.doesNotMatch(branded, /<select(?=[^>]*id="cloud-theme-density")(?=[^>]* disabled)[^>]*>/)
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
      accentHover: '#13845d',
      elevated: '#101820',
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
  assert.match(branded, /--color-accent: #0f6b4b;/)
  assert.match(branded, /--color-accent-hover: #13845d;/)
  assert.match(branded, /--color-elevated: #101820;/)
  assert.match(branded, /--accent: #0f6b4b;/)
  assert.match(branded, /https:\/\/support\.acme\.example\/cowork/)
  assert.match(branded, /https:\/\/legal\.acme\.example\/privacy/)
})

test('cloud website preserves legacy partial public branding themes', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: 'Legacy Cowork',
    shortName: 'LC',
    theme: {
      background: '#f5f6f3',
      surface: '#ffffff',
      mutedSurface: '#ecefed',
      border: '#d8ddd7',
      text: '#18211c',
      mutedText: '#66736b',
      accent: '#0f6b4b',
      accentStrong: '#13845d',
    },
  })

  assert.match(branded, /--color-elevated: #ffffff;/)
  assert.match(branded, /color-scheme: light/)
  assert.match(branded, /--surface: #ffffff;/)
  assert.match(branded, /--muted-surface: #ecefed;/)
  assert.match(branded, /--color-accent-hover: #13845d;/)
  assert.match(branded, /--color-accent-foreground: #ffffff;/)
  assert.match(branded, /--focus: rgba\(45, 107, 86, 0\.28\);/)
  assert.match(branded, /--warn: #8a5a14;/)
  assert.match(branded, /--danger: #9d3630;/)
  assert.match(branded, /--ok: #1f6b46;/)
  assert.match(branded, /--bg-image: none;/)
  assert.doesNotMatch(branded, /--surface: #242021;/)
})

test('cloud website classifies shorthand and rgb light branding tokens', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: 'Shorthand Cowork',
    shortName: 'SC',
    theme: {
      background: '#fff',
      surface: 'rgb(255, 255, 255)',
      text: 'rgb(24, 33, 28)',
      accent: '#2d6b56',
    },
  })

  assert.match(branded, /color-scheme: light/)
  assert.match(branded, /--color-base: #fff;/)
  assert.match(branded, /--color-elevated: rgb\(255, 255, 255\);/)
  assert.match(branded, /--text: rgb\(24, 33, 28\);/)
  assert.match(branded, /--accent-text: #2d6b56;/)
  assert.match(branded, /--focus: rgba\(45, 107, 86, 0\.28\);/)
  assert.doesNotMatch(branded, /color-scheme: dark/)

  const named = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: 'Named Cowork',
    shortName: 'NC',
    theme: {
      background: 'white',
      surface: 'hsl(0, 0%, 100%)',
      text: 'black',
      accent: '#2d6b56',
    },
  })

  assert.match(named, /color-scheme: light/)
  assert.match(named, /--color-base: white;/)
  assert.match(named, /--color-elevated: hsl\(0, 0%, 100%\);/)
  assert.match(named, /--text: black;/)
  assert.match(named, /--accent-text: #2d6b56;/)
  assert.match(named, /--focus: rgba\(45, 107, 86, 0\.28\);/)
})

test('cloud website emits complex public branding active-surface tokens', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: 'Active Cowork',
    shortName: 'AC',
    theme: {
      surfaceActive: 'color-mix(in srgb, #fff 20%, #000)',
    },
  })

  assert.match(branded, /--color-surface-active: color-mix\(in srgb, #fff 20%, #000\);/)
})

test('cloud website preserves dark defaults for partial dark branding overrides', () => {
  const branded = cloudWebsiteHtml({
    role: 'owner',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  }, {
    productName: 'Dark Cowork',
    shortName: 'DC',
    theme: {
      background: '#101010',
    },
  })

  assert.match(branded, /color-scheme: dark/)
  assert.match(branded, /--color-base: #101010;/)
  assert.match(branded, /--color-elevated: #1f2329;/)
  assert.match(branded, /--text: #eceef1;/)
  assert.match(branded, /--focus: rgba\(47, 107, 240, 0\.52\);/)
  assert.doesNotMatch(branded, /--color-elevated: #ffffff;/)
  assert.doesNotMatch(branded, /--text: #18211c;/)
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
  assert.doesNotMatch(html, /sessionStorage|indexedDB/)
  assert.match(html, /id="open-cowork-cloud-bootstrap" type="application\/json"/)
})

test('cloud website binds actions through the React module client', () => {
  assert.equal(html.includes('onclick='), false)
  assert.match(html, /data-cloud-react-root="true"/)
  assert.match(html, /data-cloud-react-shell="ssr"/)
  assert.match(html, /data-route-link="chat"/)
  assert.match(html, /id="signin-inline"/)
  assert.match(html, /id="prompt-form"/)
  assert.match(html, /id="member-invite-form"/)
  assert.match(html, /id="binding-form"/)
  assert.match(html, /id="prepare-diagnostics"/)
})

test('cloud website renders chat-first controls without local host path affordances', () => {
  assert.match(html, /id="thread-list"/)
  assert.match(html, /id="session-form"/)
  assert.match(html, /id="thread-objective-state"/)
  assert.match(html, /Objectives are projected from selected Cloud chats/)
  assert.match(html, /Git repository URL/)
  assert.match(html, /Uploaded snapshot/)
  assert.match(html, /id="prompt-form"/)
  assert.match(html, /id="composer-agent"/)
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
  assert.match(html, /Artifact library/)
  assert.match(html, /id="artifact-detail"/)
  assert.match(html, /id="member-list"/)
  assert.match(html, /id="member-invite-form"/)
  assert.match(html, /id="admin-policy-overview"/)
  assert.match(html, /id="admin-project-policy"/)
  assert.match(html, /id="audit-list"/)
  assert.doesNotMatch(html, /\/Users\//)
  assert.doesNotMatch(html, /name="localPath"/)
  assert.doesNotMatch(html, /name="stdioCommand"/)
  assert.match(html, /Local Stdio MCPs/)
  assert.match(html, /Cloud Web cannot spawn local stdio MCP processes/)
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
  assert.deepEqual(cloudWebCoworkerOptionsFromWorkspace({
    policy: {
      allowedAgents: [
        {
          name: 'build',
          label: 'Build',
          role: 'Implementation lead',
          status: 'available',
          toolIds: ['shell', 'git'],
          skillNames: ['review'],
        },
      ],
    },
  }, 'studio'), [{
    name: 'build',
    displayName: 'Build',
    role: 'Implementation lead',
    availability: 'available',
    capabilityHint: '2 tools - 1 skill - profile studio',
    custom: false,
  }])
  assert.equal(cloudWebCoworkerInitials('data-analyst'), 'DA')
  assert.equal(firstCloudWebMentionedCoworker('Please ask @data-analyst for help', ['build', 'data-analyst']), 'data-analyst')
  assert.equal(firstCloudWebMentionedCoworker('Please ask @data-analyst.', ['build', 'data-analyst']), 'data-analyst')
  assert.equal(firstCloudWebMentionedCoworker('Please ask @agent.v1.', ['agent', 'agent.v1']), 'agent.v1')
  assert.equal(firstCloudWebMentionedCoworker('Please ask @unknown for help', ['build']), '')
  assert.equal(ensureCloudWebCoworkerMention('Continue the work.', 'build'), '@build Continue the work.')
  assert.equal(ensureCloudWebCoworkerMention('@data-analyst Continue the work.', 'build'), '@build Continue the work.')
  assert.equal(ensureCloudWebCoworkerMention('@data-analyst: Continue the work.', 'build'), '@build Continue the work.')
  assert.equal(ensureCloudWebCoworkerMention('@data-analyst. Continue the work.', 'build'), '@build Continue the work.')
  assert.deepEqual(
    cloudWebPromptAssignment('@data-analyst inspect metrics', ['build', 'data-analyst'], 'build'),
    { agent: 'data-analyst', text: 'inspect metrics', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('@data-analyst: inspect metrics', ['build', 'data-analyst'], 'build'),
    { agent: 'data-analyst', text: 'inspect metrics', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('@data-analyst, inspect metrics', ['build', 'data-analyst'], 'build'),
    { agent: 'data-analyst', text: 'inspect metrics', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('@data-analyst. inspect metrics', ['build', 'data-analyst'], 'build'),
    { agent: 'data-analyst', text: 'inspect metrics', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('@agent.v1. inspect metrics', ['agent', 'agent.v1'], 'agent'),
    { agent: 'agent.v1', text: 'inspect metrics', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('inspect metrics with @data-analyst', ['build', 'data-analyst'], 'build'),
    { agent: 'build', text: 'inspect metrics with @data-analyst', source: 'selected' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('inspect metrics with @data-analyst', ['build', 'data-analyst'], ''),
    { agent: 'data-analyst', text: 'inspect metrics with @data-analyst', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('Please ask @data-analyst.', ['build', 'data-analyst'], ''),
    { agent: 'data-analyst', text: 'Please ask @data-analyst.', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('Please ask @agent.v1.', ['agent', 'agent.v1'], ''),
    { agent: 'agent.v1', text: 'Please ask @agent.v1.', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('inspect metrics', ['build'], 'capability-coworker'),
    { agent: 'capability-coworker', text: 'inspect metrics', source: 'selected' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('@capability-coworker inspect metrics', ['build'], 'capability-coworker'),
    { agent: 'capability-coworker', text: 'inspect metrics', source: 'mention' },
  )
  assert.deepEqual(
    cloudWebPromptAssignment('@capability-coworker', ['build'], 'capability-coworker'),
    { agent: 'capability-coworker', text: '', source: 'mention' },
  )
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
  assert.equal(cloudWebRuntimeCounts({ lastError: 'Provider timeout' }).error, 1)
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
  assert.match(html, /data-requires-admin="true"/)
  assert.match(html, /data-admin-control="true"/)
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
