import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build as buildEsbuild } from 'esbuild'
import { CLOUD_WEB_CLIENT_ENDPOINTS } from './client-contract.ts'
import { CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE } from './app-shell.ts'
import { cloudWebsiteHtml } from './render.ts'
import {
  iso,
  makeAuditEvents,
  makeDeliveries,
  makeLaunchpadFeed,
  makeMembers,
  makeSession,
  makeSessionView,
  makeTokens,
  makeUsageEvents,
  makeWorkers,
  makeWorkflows,
} from './browser-test-fixtures.ts'

const require = createRequire(import.meta.url)
const { JSDOM, VirtualConsole } = require('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => any
  VirtualConsole: new () => { on(event: string, listener: (error: Error) => void): void }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
let reactClientScriptPromise: Promise<string> | null = null

function bundledReactClientScript() {
  reactClientScriptPromise ||= buildEsbuild({
    entryPoints: [resolve(repoRoot, 'apps/website/src/react-client.tsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'OpenCoworkCloudReactTest',
    target: 'es2022',
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    plugins: [{
      name: 'open-cowork-source-alias',
      setup(build) {
        build.onResolve({ filter: /^@open-cowork\/ui$/ }, () => ({
          path: resolve(repoRoot, 'packages/ui/src/index.ts'),
        }))
        build.onResolve({ filter: /^@open-cowork\/ui\/app-api$/ }, () => ({
          path: resolve(repoRoot, 'packages/ui/src/AppApiProvider.tsx'),
        }))
        build.onResolve({ filter: /^@open-cowork\/shared$/ }, () => ({
          path: resolve(repoRoot, 'packages/shared/src/index.ts'),
        }))
      },
    }],
  }).then((result) => result.outputFiles[0]?.text || '')
  return reactClientScriptPromise
}

type MockRole = 'owner' | 'admin' | 'member'
type MockRequest = { method: string, path: string, body: unknown, headers: Record<string, string> }

type MockEventSource = {
  url: string
  close(): void
  emit(type: string, payload: Record<string, unknown>): void
  closed: boolean
}

type BrowserHarnessOptions = {
  role?: MockRole
  signedOut?: boolean
  features?: Record<string, boolean>
  sessionCount?: number
  hydratedViewCount?: number
  memberCount?: number
  tokenCount?: number
  deliveryCount?: number
  workflowCount?: number
  workerCount?: number
  auditCount?: number
  usageCount?: number
  artifactCount?: number
  promptFailure?: { status: number, error: string, policyCode?: string }
  projectSourceDenied?: boolean
  signupMode?: string
  billingEnabled?: boolean
  allowedAgents?: string[] | null
}
function parseJsonBody(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export async function waitFor(assertion: () => void, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await delay(20)
    }
  }
  throw lastError
}

export function createCloudWebBrowserHarness(options: BrowserHarnessOptions = {}) {
  const role = options.role || 'admin'
  const allowedAgents = options.allowedAgents === undefined ? ['build', 'plan', 'chief-of-staff', 'data-analyst'] : options.allowedAgents
  const features = {
    chat: true,
    workflows: true,
    agents: true,
    customSkills: true,
    customMcps: true,
    ...options.features,
  }
  const html = cloudWebsiteHtml({
    role,
    profileName: 'default',
    features,
  }, {
    productName: 'Acme Cowork Cloud',
    shortName: 'AC',
  }, 'test-nonce')
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => {
    const message = String(error?.message || '')
    if (!message.includes('navigation to another Document') && !message.includes('Not implemented: navigation')) {
      throw error
    }
  })
  const dom = new JSDOM(html, {
    url: 'https://cloud.example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  })
  const { window } = dom
  const document = window.document
  const bootstrap = JSON.parse(document.getElementById('open-cowork-cloud-bootstrap')?.textContent || '{}')

  const sessions = Array.from({ length: options.sessionCount || 1 }, (_, index) => makeSession(index + 1))
  const hydratedViewCount = options.hydratedViewCount ?? sessions.length
  const artifactCount = options.artifactCount || 1
  const views: Record<string, any> = Object.fromEntries(
    sessions.slice(0, hydratedViewCount).map((session, index) => [session.sessionId, makeSessionView(session, index + 10, artifactCount)]),
  )
  const requests: MockRequest[] = []
  const eventSources: MockEventSource[] = []
  const state: Record<string, any> = {
    byok: [
      { providerId: 'anthropic', credentialKind: 'kms_ref', last4: '1234', status: 'active', updatedAt: iso(1), lastValidatedAt: null },
    ],
    tokens: makeTokens(options.tokenCount || 1),
    members: makeMembers(options.memberCount || 2),
    agents: [
      { agentId: 'agent-1', name: 'On-call coding agent', profileName: 'default', status: 'active' },
    ],
    bindings: [
      { bindingId: 'binding-1', agentId: 'agent-1', provider: 'telegram', displayName: 'Team Telegram', status: 'active', settings: { defaultChatId: 'chat-1' } },
    ],
    deliveries: makeDeliveries(options.deliveryCount || 1),
    workerPools: [
      { poolId: 'pool-1', name: 'Primary worker pool', mode: 'self_hosted', status: 'active', region: 'test-region', maxWorkers: 3, maxConcurrentWork: 6, updatedAt: iso(4) },
    ],
    workers: makeWorkers(options.workerCount || 2),
    workerHeartbeats: [
      { workerId: 'worker-1', poolId: 'pool-1', version: 'test', currentLoad: 1, activeWorkIds: ['session-1'], receivedAt: iso(5) },
    ],
    workflows: makeWorkflows(options.workflowCount || 1),
    runs: Array.from({ length: Math.min(options.workflowCount || 1, 60) }, (_, index) => ({
      id: `run-${index + 1}`,
      workflowId: `workflow-${index + 1}`,
      title: index === 0 ? 'Daily review run' : `Workflow run ${index + 1}`,
      status: 'completed',
      sessionId: 'session-1',
      triggerType: 'manual',
      createdAt: iso(index + 6),
      summary: 'Done',
    })),
    auditEvents: makeAuditEvents(options.auditCount || 1),
    usageEvents: makeUsageEvents(options.usageCount || 1),
  }

  const makeRequestRecord = (input: string | URL | Request, init: RequestInit = {}) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const url = new URL(raw, 'https://cloud.example.test')
    const headers = new Headers(init.headers || {})
    return {
      method: String(init.method || 'GET').toUpperCase(),
      path: `${url.pathname}${url.search}`,
      pathname: url.pathname,
      body: parseJsonBody(init.body),
      headers: Object.fromEntries(headers.entries()),
    }
  }

  const limitFromRequest = (request: ReturnType<typeof makeRequestRecord>, fallback: number, max = 500) => {
    const params = new URL(request.path, 'https://cloud.example.test').searchParams
    const parsed = Number(params.get('limit') || fallback)
    return Math.min(Math.max(Math.floor(Number.isFinite(parsed) ? parsed : fallback), 1), max)
  }

  async function handleFetch(input: string | URL | Request, init: RequestInit = {}) {
    const request = makeRequestRecord(input, init)
    requests.push(request)
    if (options.signedOut && request.pathname !== '/api/config') {
      return jsonResponse({ error: 'Authentication required' }, 401)
    }

    if (request.method === 'GET' && request.pathname === '/auth/me') {
      return jsonResponse({
        principal: { userId: 'user-1', accountId: 'acct-1', orgId: 'org-1', tenantId: 'org-1', email: `${role}@example.test`, role },
        csrfToken: 'csrf-token',
      })
    }
    if (request.method === 'POST' && request.pathname === '/auth/logout') {
      return jsonResponse({ ok: true })
    }
    if (request.method === 'GET' && request.pathname === '/api/config') {
      return jsonResponse({ ...bootstrap, features })
    }
    if (request.method === 'GET' && request.pathname === '/api/workspace') {
      return jsonResponse({
        orgId: 'org-1',
        tenantId: 'org-1',
        orgName: 'Acme Cloud',
        email: `${role}@example.test`,
        role,
        profileName: 'default',
        policy: {
          allowedAgents,
          allowedTools: ['shell', 'repo.search'],
          allowedMcps: null,
        },
      })
    }
    if (request.method === 'GET' && request.pathname === '/api/byok') return jsonResponse({ secrets: state.byok })
    if (request.method === 'POST' && request.pathname.startsWith('/api/byok/')) {
      const providerId = decodeURIComponent(request.pathname.split('/')[3] || 'unknown')
      state.byok = [{ providerId, credentialKind: (request.body as Record<string, unknown>)?.kmsRef ? 'kms_ref' : 'api_key', last4: '9999', status: 'active', updatedAt: iso(8), lastValidatedAt: null }]
      return jsonResponse({ secret: state.byok[0] })
    }
    if (request.method === 'DELETE' && request.pathname.startsWith('/api/byok/')) {
      const providerId = decodeURIComponent(request.pathname.split('/')[3] || 'unknown')
      state.byok = state.byok.map((secret: any) => secret.providerId === providerId ? { ...secret, status: 'disabled', disabledAt: iso(12) } : secret)
      return jsonResponse({ ok: true })
    }
    if (request.method === 'GET' && request.pathname === '/api/api-tokens') return jsonResponse({ tokens: state.tokens.slice(0, limitFromRequest(request, 100)) })
    if (request.method === 'POST' && request.pathname === '/api/api-tokens') {
      const body = request.body as Record<string, unknown>
      const channelBindingIds = Array.isArray(body?.channelBindingIds) ? body.channelBindingIds : []
      const token = {
        tokenId: `token-${state.tokens.length + 1}`,
        name: body?.name || 'API token',
        scopes: body?.scopes || ['desktop'],
        channelBindingIds,
        last4: 'wxyz',
        lastUsedAt: null,
        revokedAt: null,
      }
      state.tokens = [token, ...state.tokens]
      return jsonResponse({ token, plaintext: 'occ_created_token_value' })
    }
    if (request.method === 'DELETE' && request.pathname.startsWith('/api/api-tokens/')) {
      const tokenId = decodeURIComponent(request.pathname.split('/')[3] || '')
      state.tokens = state.tokens.map((token: any) => token.tokenId === tokenId ? { ...token, revokedAt: iso(13) } : token)
      return jsonResponse({ ok: true })
    }
    if (request.method === 'GET' && request.pathname === '/api/billing/subscription') {
      if (options.billingEnabled === false) {
        return jsonResponse({ enabled: false, mode: 'self-host' })
      }
      return jsonResponse({
        enabled: true,
        active: true,
        mode: 'managed',
        providerId: 'stripe',
        subscription: { planKey: 'pro', status: 'active', seats: 1, currentPeriodEnd: iso(30) },
        plans: [{ planKey: 'pro', label: 'Pro', default: true, entitlements: { maxPromptsPerHour: 100 } }],
        entitlements: { maxPromptsPerHour: 100 },
      })
    }
    if (request.method === 'POST' && request.pathname === '/api/billing/checkout') {
      return jsonResponse({ url: 'https://billing.example.test/checkout' })
    }
    if (request.method === 'GET' && request.pathname === '/api/usage/events') {
      return jsonResponse({ events: state.usageEvents.slice(0, limitFromRequest(request, 20)) })
    }
    if (request.method === 'GET' && request.pathname === '/api/usage/summary') {
      return jsonResponse({
        eventSampleLimit: 100,
        quotas: [{ quotaKey: 'prompts', label: 'Prompts/hour', enabled: true, used: 1, limit: 100, unit: 'count', resetAt: iso(59) }],
        totals: [{ eventType: 'prompt', quantity: 1, unit: 'count' }],
      })
    }
    if (request.method === 'GET' && request.pathname === '/api/admin/policy') {
      return jsonResponse({
        policy: {
          org: { orgId: 'org-1', name: 'Acme Cloud' },
          signup: { mode: options.signupMode || 'invite', allowedEmailDomains: ['example.test'] },
          profile: { name: 'default', label: 'Default' },
          features,
          allowedAgents,
          allowedTools: ['shell'],
          allowedMcps: null,
          projectSources: { git: { allowedHosts: ['github.com'] }, uploadedSnapshots: { enabled: true, maxFiles: 100, maxBytes: 1024 * 1024 }, managedWorkspaces: { enabled: false } },
          runtime: { machineRuntimeConfig: 'disabled', localStdioMcps: 'disabled', hostProjectDirectories: 'disabled' },
          gateway: { channelsEnabled: true, webhooksEnabled: true },
          byok: { allowedProviderIds: ['anthropic'], kmsRefsEnabled: true, envRefsEnabled: false },
        },
      })
    }
    if (request.method === 'GET' && request.pathname === '/api/admin/members') return jsonResponse({ members: state.members.slice(0, limitFromRequest(request, 100)) })
    if (request.method === 'POST' && request.pathname === '/api/admin/members') {
      state.members = [{ accountId: `acct-${state.members.length + 1}`, email: (request.body as Record<string, unknown>)?.email, role: (request.body as Record<string, unknown>)?.role || 'member', status: 'invited', updatedAt: iso(9) }, ...state.members]
      return jsonResponse({ member: state.members[0] })
    }
    const memberUpdateMatch = request.pathname.match(/^\/api\/admin\/members\/([^/]+)\/update$/)
    if (request.method === 'POST' && memberUpdateMatch) {
      const accountId = decodeURIComponent(memberUpdateMatch[1])
      state.members = state.members.map((member: any) => member.accountId === accountId ? { ...member, ...(request.body as Record<string, unknown>), updatedAt: iso(14) } : member)
      return jsonResponse({ member: state.members.find((member: any) => member.accountId === accountId) })
    }
    if (request.method === 'GET' && request.pathname === '/api/admin/audit') {
      return jsonResponse({ events: state.auditEvents.slice(0, limitFromRequest(request, 100)) })
    }
    if (request.method === 'GET' && request.pathname === '/api/admin/worker-pools') return jsonResponse({ pools: state.workerPools.slice(0, limitFromRequest(request, 100)) })
    if (request.method === 'GET' && request.pathname === '/api/admin/workers') return jsonResponse({ workers: state.workers.slice(0, limitFromRequest(request, 100)) })
    const workerHeartbeatsMatch = request.pathname.match(/^\/api\/admin\/workers\/([^/]+)\/heartbeats$/)
    if (request.method === 'GET' && workerHeartbeatsMatch) {
      const workerId = decodeURIComponent(workerHeartbeatsMatch[1])
      return jsonResponse({ heartbeats: state.workerHeartbeats.filter((heartbeat: any) => heartbeat.workerId === workerId) })
    }
    if (request.method === 'GET' && request.pathname === '/api/channels/agents') return jsonResponse({ agents: state.agents.slice(0, limitFromRequest(request, 100)) })
    if (request.method === 'POST' && request.pathname === '/api/channels/agents') {
      const agent = { agentId: `agent-${state.agents.length + 1}`, name: (request.body as Record<string, unknown>)?.name || 'Agent', profileName: (request.body as Record<string, unknown>)?.profileName || 'default', status: 'active' }
      state.agents = [agent, ...state.agents]
      return jsonResponse({ agent })
    }
    if (request.method === 'GET' && request.pathname === '/api/channels/bindings') return jsonResponse({ bindings: state.bindings.slice(0, limitFromRequest(request, 100)) })
    if (request.method === 'POST' && request.pathname === '/api/channels/bindings') {
      const binding = { bindingId: `binding-${state.bindings.length + 1}`, ...(request.body as Record<string, unknown>), status: 'auth_required' }
      state.bindings = [binding, ...state.bindings]
      return jsonResponse({ binding })
    }
    if (request.method === 'GET' && request.pathname === '/api/channels/deliveries') return jsonResponse({ deliveries: state.deliveries.slice(0, limitFromRequest(request, 50)) })
    if (request.method === 'POST' && request.pathname.includes('/retry')) {
      state.deliveries = state.deliveries.map((delivery: any) => ({ ...delivery, status: delivery.deliveryId === request.pathname.split('/')[4] ? 'pending' : delivery.status }))
      return jsonResponse({ delivery: state.deliveries[0] })
    }
    if (request.method === 'POST' && request.pathname.includes('/dead-letter')) {
      state.deliveries = state.deliveries.map((delivery: any) => ({ ...delivery, status: delivery.deliveryId === request.pathname.split('/')[4] ? 'dead' : delivery.status }))
      return jsonResponse({ delivery: state.deliveries[0] })
    }
    if (request.method === 'GET' && request.pathname === '/api/diagnostics') {
      return jsonResponse({
        generatedAt: iso(10),
        redaction: 'secrets-redacted',
        runtime: { role: 'web', commandProcessing: 'disabled', heartbeatCount: 2 },
        byok: { configuredProviders: 1 },
        gateway: { agents: { total: state.agents.length }, deliverySampleLimit: 200, token: 'leaked-secret' },
        objectStore: { signedUrl: 'https://object.example.test/signed?token=leaked-secret' },
      })
    }
    if (request.method === 'GET' && request.pathname === '/api/capabilities') {
      return jsonResponse({
        tools: [
          { id: 'shell', label: 'Shell', kind: 'tool', source: 'builtin', agentNames: ['build'] },
          { id: 'custom-tool', label: 'Custom tool', kind: 'tool', source: 'custom', agentNames: ['data-analyst'] },
        ],
        skills: [
          { id: 'analysis', label: 'Analysis', kind: 'skill', source: 'builtin', agentNames: ['data-analyst'], toolIds: ['shell'] },
          { id: 'local-mcp', label: 'Local MCP', kind: 'mcp', scope: 'machine', source: 'custom', agentNames: ['build'] },
        ],
      })
    }
    if (request.method === 'GET' && request.pathname === '/api/workflows') return jsonResponse({ workflows: state.workflows.slice(0, limitFromRequest(request, 100)), runs: state.runs.slice(0, 50) })
    if (request.method === 'POST' && request.pathname === '/api/workflows') {
      const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? request.body as Record<string, any>
        : {}
      const workflow = {
        id: `workflow-${state.workflows.length + 1}`,
        title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Created workflow',
        status: 'active',
        agentName: typeof body.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : 'build',
        instructions: typeof body.instructions === 'string' ? body.instructions : '',
        skillNames: Array.isArray(body.skillNames) ? body.skillNames : [],
        toolIds: Array.isArray(body.toolIds) ? body.toolIds : [],
        triggers: Array.isArray(body.triggers) ? body.triggers : [],
        createdAt: iso(12),
        updatedAt: iso(12),
      }
      state.workflows = [workflow, ...state.workflows]
      return jsonResponse({ workflow }, 201)
    }
    const workflowRunMatch = request.pathname.match(/^\/api\/workflows\/([^/]+)\/run$/)
    if (request.method === 'POST' && workflowRunMatch) {
      const workflow = state.workflows.find((entry: any) => entry.id === workflowRunMatch[1]) || state.workflows[0]
      const session = makeSession(900)
      session.sessionId = 'workflow-run-session'
      session.title = 'Workflow run thread'
      sessions.unshift(session)
      views[session.sessionId] = makeSessionView(session, 90)
      const run = { id: 'run-2', workflowId: workflow.id, status: 'running', sessionId: session.sessionId, createdAt: iso(11), triggerType: 'manual' }
      state.runs = [run, ...state.runs]
      return jsonResponse({ workflow: { ...workflow, latestRunStatus: 'running', latestRunSessionId: session.sessionId }, run })
    }
    const workflowArchiveMatch = request.pathname.match(/^\/api\/workflows\/([^/]+)\/archive$/)
    if (request.method === 'POST' && workflowArchiveMatch) {
      const workflowId = decodeURIComponent(workflowArchiveMatch[1])
      state.workflows = state.workflows.map((workflow: any) => workflow.id === workflowId ? { ...workflow, status: 'archived' } : workflow)
      return jsonResponse({ workflow: state.workflows.find((workflow: any) => workflow.id === workflowId) })
    }
    if (request.method === 'POST' && request.pathname === '/api/project-sources/validate') {
      if (options.projectSourceDenied) return jsonResponse({ allowed: false, reason: 'Project source blocked by policy.' })
      return jsonResponse({ allowed: true })
    }
    if (request.method === 'POST' && request.pathname === '/api/project-sources/snapshots') {
      return jsonResponse({ projectSource: { kind: 'snapshot', snapshotId: 'snapshot-1', title: 'Browser upload' } })
    }
    if (request.method === 'GET' && request.pathname === '/api/launchpad/feed') return jsonResponse(makeLaunchpadFeed(sessions, views))
    if (request.method === 'GET' && request.pathname === '/api/sessions') {
      const params = new URL(request.path, 'https://cloud.example.test').searchParams, limit = Math.min(Math.max(Math.floor(Number(params.get('limit') || sessions.length)) || sessions.length, 1), 500)
      const offset = params.get('cursor')?.startsWith('offset:') ? Number(params.get('cursor')?.slice('offset:'.length)) : 0
      const nextOffset = offset + limit, page = sessions.slice(offset, nextOffset)
      return jsonResponse({ sessions: page, nextCursor: nextOffset < sessions.length ? `offset:${nextOffset}` : null, totalEstimate: sessions.length })
    }
    if (request.method === 'POST' && request.pathname === '/api/sessions') {
      const session = makeSession(1000 + sessions.length)
      session.sessionId = `created-${sessions.length + 1}`
      session.title = 'Created browser thread'
      session.profileName = String((request.body as Record<string, unknown>)?.profileName || 'default')
      sessions.unshift(session)
      views[session.sessionId] = makeSessionView(session, 100 + sessions.length)
      return jsonResponse(views[session.sessionId])
    }
    const sessionViewMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/view$/)
    if (request.method === 'GET' && sessionViewMatch) {
      const sessionId = decodeURIComponent(sessionViewMatch[1])
      if (!views[sessionId]) {
        const session = sessions.find((entry) => entry.sessionId === sessionId)
        if (session) views[sessionId] = makeSessionView(session, 10, artifactCount)
      }
      return jsonResponse(views[sessionId] || { error: 'Not found' }, views[sessionId] ? 200 : 404)
    }
    const sessionEventsMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)
    if (request.method === 'GET' && sessionEventsMatch) return jsonResponse({ ok: true })
    const promptMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
    if (request.method === 'POST' && promptMatch) {
      if (options.promptFailure) {
        return jsonResponse({ error: options.promptFailure.error, policyCode: options.promptFailure.policyCode, verdict: { reason: options.promptFailure.error } }, options.promptFailure.status)
      }
      const sessionId = decodeURIComponent(promptMatch[1])
      const view = views[sessionId]
      const projection = view.projection.view
      projection.messages = [
        ...projection.messages,
        { id: `${sessionId}-prompt`, role: 'user', content: (request.body as Record<string, unknown>)?.text || 'Prompt', order: 20 },
        { id: `${sessionId}-answer`, role: 'assistant', content: 'Live answer from cloud.', order: 21 },
      ]
      view.projection.sequence += 1
      return jsonResponse({ view })
    }
    const permissionMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/permission-respond$/)
    if (request.method === 'POST' && permissionMatch) {
      const view = views[decodeURIComponent(permissionMatch[1])]
      const permissionId = (request.body as Record<string, unknown>)?.permissionId
      const response = (request.body as Record<string, { allowed?: boolean }>)?.response || {}
      const pending = view.projection.view.pendingApprovals.find((entry: { id: string }) => entry.id === permissionId)
      view.projection.view.pendingApprovals = view.projection.view.pendingApprovals.filter((entry: { id: string }) => entry.id !== permissionId)
      view.projection.view.resolvedApprovals.push({ ...pending, allowed: Boolean(response.allowed), order: 22 })
      view.projection.sequence += 1
      return jsonResponse({ ok: true })
    }
    const questionReplyMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/question-reply$/)
    if (request.method === 'POST' && questionReplyMatch) {
      const view = views[decodeURIComponent(questionReplyMatch[1])]
      const requestId = (request.body as Record<string, unknown>)?.requestId
      const pending = view.projection.view.pendingQuestions.find((entry: { id: string }) => entry.id === requestId)
      view.projection.view.pendingQuestions = view.projection.view.pendingQuestions.filter((entry: { id: string }) => entry.id !== requestId)
      view.projection.view.resolvedQuestions.push({ ...pending, answers: (request.body as Record<string, unknown>)?.answers, order: 23 })
      view.projection.sequence += 1
      return jsonResponse({ ok: true })
    }
    if (request.method === 'GET' && request.pathname === '/api/artifacts') {
      const artifacts = Object.entries(views).flatMap(([sessionId, view]) =>
        view.projection.view.artifacts.map((artifact: Record<string, unknown>) => ({
          ...artifact,
          sessionId,
          status: artifact.status || 'draft',
          kind: artifact.kind || 'document',
        })),
      )
      return jsonResponse({ artifacts: artifacts.slice(0, limitFromRequest(request, 100)), total: artifacts.length })
    }
    const artifactListMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts$/)
    if (request.method === 'GET' && artifactListMatch) {
      const view = views[decodeURIComponent(artifactListMatch[1])]
      return jsonResponse({ artifacts: view.projection.view.artifacts.slice(0, limitFromRequest(request, 100)) })
    }
    const artifactMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)$/)
    if (request.method === 'GET' && artifactMatch) {
      return jsonResponse({ artifact: { artifactId: decodeURIComponent(artifactMatch[2]), filename: 'summary.txt', contentType: 'text/plain', dataBase64: 'SGVsbG8=', size: 5 } })
    }

    return jsonResponse({ error: `Unhandled test route ${request.method} ${request.path}` }, 404)
  }

  class FakeEventSource implements MockEventSource {
    url: string
    closed = false
    onopen: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    listeners = new Map<string, Array<(event: MessageEvent) => void>>()

    constructor(url: string) {
      this.url = url
      eventSources.push(this)
      window.setTimeout(() => {
        if (!this.closed) this.onopen?.(new window.Event('open'))
      }, 0)
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), listener])
    }

    close() {
      this.closed = true
    }

    emit(type: string, payload: Record<string, unknown>) {
      const event = new window.MessageEvent(type, { data: JSON.stringify(payload) })
      if (type === 'message') this.onmessage?.(event)
      for (const listener of this.listeners.get(type) || []) listener(event)
    }
  }

  const installBrowserMocks = () => {
    Object.defineProperty(window, 'fetch', { value: handleFetch, configurable: true })
    Object.defineProperty(window, 'EventSource', { value: FakeEventSource, configurable: true })
    Object.defineProperty(window, 'open', { value: () => null, configurable: true })
    Object.defineProperty(window, 'prompt', { value: () => 'confirmed from test', configurable: true })
    if (!window.URL.createObjectURL) {
      Object.defineProperty(window.URL, 'createObjectURL', { value: () => 'blob:https://cloud.example.test/test', configurable: true })
    }
    if (!window.URL.revokeObjectURL) {
      Object.defineProperty(window.URL, 'revokeObjectURL', { value: () => {}, configurable: true })
    }
    Object.defineProperty(window.HTMLAnchorElement.prototype, 'click', {
      value() {
        this.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
      },
      configurable: true,
    })
  }

  const start = async () => {
    installBrowserMocks()
    const clientScript = await bundledReactClientScript()
    assert.ok(clientScript, 'React client script is bundled')
    window.eval(clientScript)
    await waitFor(() => {
      assert.equal(document.getElementById('open-cowork-cloud-react-root')?.dataset.reactStatus, 'hydrated')
      assert.equal(document.body.dataset.reactShell, 'active')
    }, 8000)
    await waitFor(() => {
      assert.notEqual(document.body.dataset.auth, 'loading')
    }, 8000)
    if (document.body.dataset.auth === 'signed-in') {
      await waitFor(() => {
        assert.doesNotMatch(document.querySelector('#thread-list')?.textContent || '', /No cloud threads loaded/)
        assert.doesNotMatch(document.querySelector('#workbench-agent-list')?.textContent || '', /No profile-allowed (?:agents|coworkers) loaded|No (?:agents|coworkers) loaded/)
        assert.doesNotMatch(document.querySelector('#workflow-list')?.textContent || '', /No (?:workflows|playbooks) loaded/)
        assert.equal(document.querySelector('#prompt-form')?.getAttribute('data-react-owned'), 'chat')
        assert.equal(document.querySelector('#session-form')?.getAttribute('data-react-owned'), 'project-session')
      }, 8000)
      if (role === 'admin' || role === 'owner') {
        await waitFor(() => {
          assert.ok(document.querySelector('#token-list > .row'))
          assert.ok(document.querySelector('#member-list .member-row'))
          assert.ok(document.querySelector('#delivery-list > .row'))
        }, 8000)
      }
    }
    return harness
  }

  const submit = (selector: string) => {
    const form = document.querySelector(selector)
    assert.ok(form, `${selector} exists`)
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  }

  const clickText = (selector: string, text: string) => {
    const target = [...document.querySelectorAll(selector)]
      .find((element) => element.textContent?.trim() === text)
    assert.ok(target, `${selector} with text ${text} exists`)
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  const lastRequest = (predicate: (request: MockRequest) => boolean) => [...requests].reverse().find(predicate)

  const harness = {
    dom,
    window,
    document,
    bootstrap,
    sessions,
    views,
    requests,
    eventSources,
    state,
    start,
    submit,
    clickText,
    lastRequest,
    close: () => {
      for (const source of eventSources) source.close()
    },
  }
  return harness
}
export { CLOUD_WEB_CLIENT_ENDPOINTS, CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE }
