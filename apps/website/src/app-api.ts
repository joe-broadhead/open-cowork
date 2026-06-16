import type { AppAPI, AppApiEventHandlers, AppApiQueryValue, AppApiRequestOptions } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'

export type CloudWebAppApiOptions = {
  csrfToken?: string | null
  onUnauthorized?: () => void
}

export const CLOUD_WEB_AUTH_REQUIRED_EVENT = 'open-cowork-cloud-auth-required'

function queryString(query: Record<string, AppApiQueryValue> | undefined) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query || {})) {
    if (value === null || value === undefined || value === '') continue
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry) params.append(key, entry)
      }
    } else {
      params.set(key, String(value))
    }
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

function withQuery(path: string, query: Record<string, AppApiQueryValue>) {
  const queryStart = path.indexOf('?')
  const basePath = queryStart === -1 ? path : path.slice(0, queryStart)
  const params = new URLSearchParams(queryStart === -1 ? '' : path.slice(queryStart + 1))
  let changed = false
  for (const [key, value] of Object.entries(query || {})) {
    if (value === null || value === undefined || value === '') continue
    changed = true
    if (Array.isArray(value)) {
      params.delete(key)
      for (const entry of value) {
        if (entry) params.append(key, entry)
      }
    } else {
      params.set(key, String(value))
    }
  }
  if (!changed && queryStart !== -1) return path
  const text = params.toString()
  return text ? `${basePath}?${text}` : basePath
}

function afterSequenceQuery(afterSequence: number | null | undefined) {
  const sequence = Math.floor(Number(afterSequence || 0))
  return Number.isFinite(sequence) && sequence > 0 ? { after: sequence } : {}
}

function parseEventMessage(event: MessageEvent, type = event.type) {
  let data: unknown = event.data
  if (typeof event.data === 'string' && event.data.trim()) {
    try {
      data = JSON.parse(event.data)
    } catch {
      data = event.data
    }
  }
  return { type, data, raw: event }
}

export function createCloudWebAppApi(bootstrap: CloudWebClientBootstrap, options: CloudWebAppApiOptions = {}): AppAPI {
  let csrfToken = options.csrfToken || null

  const endpoint = (id: string, fallback: string) => {
    const entry = bootstrap.api.find((candidate) => candidate.id === id)
    return entry?.path || fallback
  }

  const endpointPath = (id: string, fallback: string, params: Record<string, string | number> = {}) => {
    let path = endpoint(id, fallback)
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, encodeURIComponent(String(value)))
    }
    return path
  }

  const request: AppAPI['request'] = async <T = unknown>(path: string, requestOptions: AppApiRequestOptions = {}) => {
    if (!path.startsWith('/api/') && !path.startsWith('/auth/')) {
      throw new Error(`Cloud AppAPI blocked non-API request: ${path}`)
    }
    const hasBody = requestOptions.body !== undefined
    const response = await fetch(path, {
      method: requestOptions.method || (hasBody ? 'POST' : 'GET'),
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        ...(requestOptions.headers || {}),
      },
      body: hasBody ? JSON.stringify(requestOptions.body) : undefined,
    })
    if (!response.ok) {
      let message = `Request failed with status ${response.status}`
      let body: unknown = null
      try {
        body = await response.json()
        message = (body as { error?: string }).error || message
      } catch {
        // Preserve the stable status-based fallback.
      }
      const error = new Error(message) as Error & { status?: number; body?: unknown; verdict?: unknown }
      error.status = response.status
      error.body = body
      error.verdict = (body as { verdict?: unknown } | null)?.verdict || null
      if (response.status === 401) {
        csrfToken = null
        options.onUnauthorized?.()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(CLOUD_WEB_AUTH_REQUIRED_EVENT, { detail: { path } }))
        }
      }
      throw error
    }
    return response.json() as Promise<T>
  }

  const stream: AppAPI['stream'] = (path: string, handlers: AppApiEventHandlers = {}) => {
    if (!path.startsWith('/api/')) {
      throw new Error(`Cloud AppAPI blocked non-API event stream: ${path}`)
    }
    const source = new EventSource(path, { withCredentials: true })
    source.onopen = (event) => handlers.open?.(event)
    source.onerror = (event) => handlers.error?.(event)
    source.onmessage = (event) => handlers.message?.(parseEventMessage(event, 'message'))
    for (const type of bootstrap.sessionEventTypes || []) {
      source.addEventListener(type, (event) => handlers.message?.(parseEventMessage(event as MessageEvent, type)))
    }
    source.addEventListener('snapshot.required', (event) => handlers.message?.(parseEventMessage(event as MessageEvent, 'snapshot.required')))
    return {
      close: () => source.close(),
    }
  }

  return {
    platform: 'cloud',
    endpoint,
    endpointPath,
    request,
    stream,
    setCsrfToken: (token) => {
      csrfToken = token || null
    },
    auth: {
      me: () => request(endpoint('authMe', '/auth/me')),
      logout: () => request('/auth/logout', { method: 'POST' }),
    },
    config: {
      current: () => request(endpoint('config', '/api/config')),
    },
    workspace: {
      current: () => request(endpoint('workspace', '/api/workspace')),
      events: (handlers) => stream('/api/events', handlers),
    },
    sessions: {
      list: (query) => request(`${endpoint('sessions', '/api/sessions')}${queryString(query)}`),
      create: (input) => request(endpoint('sessions', '/api/sessions'), { method: 'POST', body: input }),
      view: (sessionId) => request(endpointPath('sessionView', '/api/sessions/:sessionId/view', { sessionId })),
      events: (sessionId, handlers, eventOptions) => stream(withQuery(endpointPath('sessionEvents', '/api/sessions/:sessionId/events', { sessionId }), afterSequenceQuery(eventOptions?.afterSequence)), handlers),
      prompt: (sessionId, input) => request(endpointPath('sessionPrompt', '/api/sessions/:sessionId/prompt', { sessionId }), { method: 'POST', body: input }),
      respondPermission: (sessionId, input) => request(endpointPath('sessionPermissionRespond', '/api/sessions/:sessionId/permission-respond', { sessionId }), { method: 'POST', body: input }),
      replyQuestion: (sessionId, input) => request(endpointPath('sessionQuestionReply', '/api/sessions/:sessionId/question-reply', { sessionId }), { method: 'POST', body: input }),
      rejectQuestion: (sessionId, input) => request(endpointPath('sessionQuestionReject', '/api/sessions/:sessionId/question-reject', { sessionId }), { method: 'POST', body: input }),
      artifacts: (sessionId) => request(withQuery(endpointPath('sessionArtifacts', '/api/sessions/:sessionId/artifacts', { sessionId }), { limit: 100 })),
      artifact: (sessionId, artifactId) => request(endpointPath('sessionArtifact', '/api/sessions/:sessionId/artifacts/:artifactId', { sessionId, artifactId })),
    },
    artifacts: {
      index: (query) => request(`${endpoint('artifactsIndex', '/api/artifacts')}${queryString(query)}`),
    },
    launchpad: {
      feed: (query) => request(`${endpoint('launchpadFeed', '/api/launchpad/feed')}${queryString(query)}`),
    },
    knowledge: {
      snapshot: (query) => request(withQuery(endpoint('knowledgeSnapshot', '/api/knowledge'), query || {})),
      propose: (input) => request(endpoint('knowledgeProposalCreate', '/api/knowledge/proposals'), { method: 'POST', body: input }),
      acceptProposal: (proposalId, input) => request(endpointPath('knowledgeProposalAccept', '/api/knowledge/proposals/:proposalId/accept', { proposalId }), { method: 'POST', body: input || {} }),
      declineProposal: (proposalId, input) => request(endpointPath('knowledgeProposalDecline', '/api/knowledge/proposals/:proposalId/decline', { proposalId }), { method: 'POST', body: input || {} }),
      history: (pageId, query) => request(withQuery(endpointPath('knowledgePageHistory', '/api/knowledge/pages/:pageId/history', { pageId }), query || {})),
      restoreVersion: (pageId, versionId, input) => request(endpointPath('knowledgePageRestore', '/api/knowledge/pages/:pageId/restore', { pageId }), { method: 'POST', body: { ...(input as Record<string, unknown> || {}), versionId } }),
    },
    capabilities: {
      catalog: () => request(endpoint('capabilitiesCatalog', '/api/capabilities')),
      tools: () => request(endpoint('capabilityTools', '/api/capabilities/tools')),
      skills: () => request(endpoint('capabilitySkills', '/api/capabilities/skills')),
    },
    workflows: {
      list: () => request(endpoint('workflows', '/api/workflows')),
      get: (workflowId) => request(endpointPath('workflow', '/api/workflows/:workflowId', { workflowId })),
      create: (input) => request(endpoint('workflows', '/api/workflows'), { method: 'POST', body: input }),
      run: (workflowId) => request(endpointPath('workflowRun', '/api/workflows/:workflowId/run', { workflowId }), { method: 'POST' }),
      pause: (workflowId) => request(endpointPath('workflowPause', '/api/workflows/:workflowId/pause', { workflowId }), { method: 'POST' }),
      resume: (workflowId) => request(endpointPath('workflowResume', '/api/workflows/:workflowId/resume', { workflowId }), { method: 'POST' }),
      archive: (workflowId) => request(endpointPath('workflowArchive', '/api/workflows/:workflowId/archive', { workflowId }), { method: 'POST' }),
    },
    coordination: {
      board: () => request(endpoint('coordinationBoard', '/api/coordination/board')),
      projects: () => request(endpoint('coordinationProjects', '/api/coordination/projects?limit=100')),
      createProject: (input) => request(endpoint('coordinationProjectCreate', '/api/coordination/projects'), { method: 'POST', body: input }),
      updateProject: (projectId, input) => request(endpointPath('coordinationProject', '/api/coordination/projects/:projectId', { projectId }), { method: 'POST', body: input }),
      planWithCleo: (projectId, input) => request(endpointPath('coordinationPlanWithCleo', '/api/coordination/projects/:projectId/plan-with-cleo', { projectId }), { method: 'POST', body: input || {} }),
      tasks: (query) => request(withQuery(endpoint('coordinationTasks', '/api/coordination/tasks?limit=500'), query || {})),
      createTask: (input) => request(endpoint('coordinationTaskCreate', '/api/coordination/tasks'), { method: 'POST', body: input }),
      updateTask: (taskId, input) => request(endpointPath('coordinationTask', '/api/coordination/tasks/:taskId', { taskId }), { method: 'POST', body: input }),
      moveTask: (taskId, input) => request(endpointPath('coordinationTaskMove', '/api/coordination/tasks/:taskId/move', { taskId }), { method: 'POST', body: input }),
      assignTask: (taskId, input) => request(endpointPath('coordinationTaskAssign', '/api/coordination/tasks/:taskId/assign', { taskId }), { method: 'POST', body: input }),
      linkTaskWork: (taskId, input) => request(endpointPath('coordinationTaskLinkWork', '/api/coordination/tasks/:taskId/link-work', { taskId }), { method: 'POST', body: input }),
      taskWorkTarget: (taskId) => request(endpointPath('coordinationTaskWorkTarget', '/api/coordination/tasks/:taskId/work-target', { taskId })),
      watches: (query) => request(withQuery(endpoint('coordinationWatches', '/api/coordination/watches?limit=500'), query || {})),
      createWatch: (input) => request(endpoint('coordinationWatchCreate', '/api/coordination/watches'), { method: 'POST', body: input }),
      updateWatch: (watchId, input) => request(endpointPath('coordinationWatch', '/api/coordination/watches/:watchId', { watchId }), { method: 'POST', body: input }),
      pauseWatch: (watchId) => request(endpointPath('coordinationWatchPause', '/api/coordination/watches/:watchId/pause', { watchId }), { method: 'POST' }),
      resumeWatch: (watchId) => request(endpointPath('coordinationWatchResume', '/api/coordination/watches/:watchId/resume', { watchId }), { method: 'POST' }),
      deleteWatch: (watchId) => request(endpointPath('coordinationWatchDelete', '/api/coordination/watches/:watchId', { watchId }), { method: 'DELETE' }),
    },
    projectSources: {
      validate: (input) => request(endpoint('projectSourceValidate', '/api/project-sources/validate'), { method: 'POST', body: input }),
      uploadSnapshot: (input) => request(endpoint('projectSnapshots', '/api/project-sources/snapshots'), { method: 'POST', body: input }),
    },
    channels: {
      providers: (query) => request(withQuery(endpoint('channelProviders', '/api/channels/providers'), query || {})),
      agents: (query) => request(withQuery(endpoint('channelAgents', '/api/channels/agents?limit=100'), query || {})),
      createAgent: (input) => request(endpoint('channelAgentCreate', '/api/channels/agents'), { method: 'POST', body: input }),
      updateAgent: (agentId, input) => request(endpointPath('channelAgentUpdate', '/api/channels/agents/:agentId', { agentId }), { method: 'PATCH', body: input }),
      bindings: (query) => request(withQuery(endpoint('channelBindings', '/api/channels/bindings?limit=100'), query || {})),
      connectBinding: (input) => request(endpoint('channelBindingCreate', '/api/channels/bindings'), { method: 'POST', body: input }),
      updateBinding: (bindingId, input) => request(endpointPath('channelBindingUpdate', '/api/channels/bindings/:bindingId', { bindingId }), { method: 'PATCH', body: input }),
      disconnectBinding: (bindingId) => request(endpointPath('channelBindingUpdate', '/api/channels/bindings/:bindingId', { bindingId }), { method: 'PATCH', body: { status: 'disabled' } }),
      people: (query) => request(withQuery(endpoint('channelIdentities', '/api/channels/identities?limit=100'), query || {})),
      resolvePerson: (input) => request(endpoint('channelIdentityResolve', '/api/channels/identities/resolve'), { method: 'POST', body: input }),
      deliveries: (query) => request(withQuery(endpoint('channelDeliveries', '/api/channels/deliveries?limit=50'), query || {})),
      retryDelivery: (deliveryId) => request(endpointPath('channelDeliveryRetry', '/api/channels/deliveries/:deliveryId/retry', { deliveryId }), { method: 'POST' }),
      deadLetterDelivery: (deliveryId, input) => request(endpointPath('channelDeliveryDeadLetter', '/api/channels/deliveries/:deliveryId/dead-letter', { deliveryId }), { method: 'POST', body: input || {} }),
      watches: (query) => request(withQuery(endpoint('coordinationWatches', '/api/coordination/watches?limit=500'), query || {})),
      createWatch: (input) => request(endpoint('coordinationWatchCreate', '/api/coordination/watches'), { method: 'POST', body: input }),
      updateWatch: (watchId, input) => request(endpointPath('coordinationWatch', '/api/coordination/watches/:watchId', { watchId }), { method: 'POST', body: input }),
      pauseWatch: (watchId) => request(endpointPath('coordinationWatchPause', '/api/coordination/watches/:watchId/pause', { watchId }), { method: 'POST' }),
      resumeWatch: (watchId) => request(endpointPath('coordinationWatchResume', '/api/coordination/watches/:watchId/resume', { watchId }), { method: 'POST' }),
      deleteWatch: (watchId) => request(endpointPath('coordinationWatchDelete', '/api/coordination/watches/:watchId', { watchId }), { method: 'DELETE' }),
    },
    admin: {
      policy: () => request(endpoint('adminPolicy', '/api/admin/policy')),
      members: {
        list: () => request(endpoint('adminMembers', '/api/admin/members?limit=100')),
        invite: (input) => request(endpoint('adminMemberInvite', '/api/admin/members'), { method: 'POST', body: input }),
        update: (accountId, input) => request(endpointPath('adminMemberUpdate', '/api/admin/members/:accountId/update', { accountId }), { method: 'POST', body: input }),
      },
      byok: {
        list: () => request(endpoint('byok', '/api/byok')),
        save: (providerId, input) => request(endpointPath('byokSave', '/api/byok/:providerId', { providerId }), { method: 'POST', body: input }),
        validate: (providerId) => request(endpointPath('byokValidate', '/api/byok/:providerId/validate', { providerId }), { method: 'POST' }),
        disable: (providerId) => request(endpointPath('byokDisable', '/api/byok/:providerId', { providerId }), { method: 'DELETE' }),
      },
      apiTokens: {
        list: () => request(endpoint('apiTokens', '/api/api-tokens?limit=100')),
        create: (input) => request(endpoint('apiTokenCreate', '/api/api-tokens'), { method: 'POST', body: input }),
        revoke: (tokenId) => request(endpointPath('apiTokenRevoke', '/api/api-tokens/:tokenId', { tokenId }), { method: 'DELETE' }),
      },
      channels: {
        providers: (query) => request(withQuery(endpoint('channelProviders', '/api/channels/providers'), query || {})),
        agents: (query) => request(withQuery(endpoint('channelAgents', '/api/channels/agents?limit=100'), query || {})),
        createAgent: (input) => request(endpoint('channelAgentCreate', '/api/channels/agents'), { method: 'POST', body: input }),
        updateAgent: (agentId, input) => request(endpointPath('channelAgentUpdate', '/api/channels/agents/:agentId', { agentId }), { method: 'PATCH', body: input }),
        bindings: (query) => request(withQuery(endpoint('channelBindings', '/api/channels/bindings?limit=100'), query || {})),
        createBinding: (input) => request(endpoint('channelBindingCreate', '/api/channels/bindings'), { method: 'POST', body: input }),
        updateBinding: (bindingId, input) => request(endpointPath('channelBindingUpdate', '/api/channels/bindings/:bindingId', { bindingId }), { method: 'PATCH', body: input }),
        disconnectBinding: (bindingId) => request(endpointPath('channelBindingUpdate', '/api/channels/bindings/:bindingId', { bindingId }), { method: 'PATCH', body: { status: 'disabled' } }),
        people: (query) => request(withQuery(endpoint('channelIdentities', '/api/channels/identities?limit=100'), query || {})),
        resolvePerson: (input) => request(endpoint('channelIdentityResolve', '/api/channels/identities/resolve'), { method: 'POST', body: input }),
        deliveries: (query) => request(withQuery(endpoint('channelDeliveries', '/api/channels/deliveries?limit=50'), query || {})),
        retryDelivery: (deliveryId) => request(endpointPath('channelDeliveryRetry', '/api/channels/deliveries/:deliveryId/retry', { deliveryId }), { method: 'POST' }),
        deadLetterDelivery: (deliveryId, input) => request(endpointPath('channelDeliveryDeadLetter', '/api/channels/deliveries/:deliveryId/dead-letter', { deliveryId }), { method: 'POST', body: input || {} }),
        watches: (query) => request(withQuery(endpoint('coordinationWatches', '/api/coordination/watches?limit=500'), query || {})),
        createWatch: (input) => request(endpoint('coordinationWatchCreate', '/api/coordination/watches'), { method: 'POST', body: input }),
        updateWatch: (watchId, input) => request(endpointPath('coordinationWatch', '/api/coordination/watches/:watchId', { watchId }), { method: 'POST', body: input }),
        pauseWatch: (watchId) => request(endpointPath('coordinationWatchPause', '/api/coordination/watches/:watchId/pause', { watchId }), { method: 'POST' }),
        resumeWatch: (watchId) => request(endpointPath('coordinationWatchResume', '/api/coordination/watches/:watchId/resume', { watchId }), { method: 'POST' }),
        deleteWatch: (watchId) => request(endpointPath('coordinationWatchDelete', '/api/coordination/watches/:watchId', { watchId }), { method: 'DELETE' }),
      },
      billing: {
        subscription: () => request(endpoint('billingSubscription', '/api/billing/subscription')),
        checkout: (input) => request(endpoint('billingCheckout', '/api/billing/checkout'), { method: 'POST', body: input }),
        portal: () => request(endpoint('billingPortal', '/api/billing/portal'), { method: 'POST', body: {} }),
      },
      usage: {
        events: () => request(endpoint('usageEvents', '/api/usage/events?limit=20')),
        summary: () => request(endpoint('usageSummary', '/api/usage/summary?limit=100')),
      },
      audit: () => request(endpoint('adminAudit', '/api/admin/audit?limit=100')),
      diagnostics: () => request(endpoint('diagnostics', '/api/diagnostics')),
      runtimeStatus: () => request(endpoint('runtimeStatus', '/api/runtime/status')),
      workerHeartbeats: () => request(endpoint('workerHeartbeats', '/api/workers/heartbeats')),
      workers: () => request(endpoint('adminWorkers', '/api/admin/workers?limit=100')),
      workerPools: () => request(endpoint('adminWorkerPools', '/api/admin/worker-pools?limit=100')),
    },
  }
}
