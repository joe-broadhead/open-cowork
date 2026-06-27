import type { AppAPI, AppApiEventHandlers, AppApiQueryValue, AppApiRequestOptions } from '@open-cowork/shared'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientBootstrap, type CloudWebEndpointId } from './client-contract.ts'

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

  // Every endpoint path is single-sourced from the canonical CLOUD_WEB_CLIENT_ENDPOINTS
  // registry: the server embeds it verbatim as `bootstrap.api`, and the bundled copy is
  // the belt-and-suspenders fallback if an id is ever absent from the bootstrap. Callers
  // pass only the endpoint id (type-checked against the registry) — never a path literal.
  const registryPath = new Map<CloudWebEndpointId, string>(
    CLOUD_WEB_CLIENT_ENDPOINTS.map((entry) => [entry.id, entry.path]),
  )

  const endpoint = (id: CloudWebEndpointId) => {
    const entry = bootstrap.api.find((candidate) => candidate.id === id)
    return entry?.path || registryPath.get(id) || ''
  }

  const endpointPath = (id: CloudWebEndpointId, params: Record<string, string | number> = {}) => {
    let path = endpoint(id)
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
    request,
    stream,
    setCsrfToken: (token) => {
      csrfToken = token || null
    },
    auth: {
      me: () => request(endpoint('authMe')),
      logout: () => request('/auth/logout', { method: 'POST' }),
    },
    config: {
      current: () => request(endpoint('config')),
    },
    workspace: {
      current: () => request(endpoint('workspace')),
      events: (handlers) => stream('/api/events', handlers),
    },
    sessions: {
      list: (query) => request(`${endpoint('sessions')}${queryString(query)}`),
      create: (input) => request(endpoint('sessions'), { method: 'POST', body: input }),
      view: (sessionId) => request(endpointPath('sessionView', { sessionId })),
      events: (sessionId, handlers, eventOptions) => stream(withQuery(endpointPath('sessionEvents', { sessionId }), afterSequenceQuery(eventOptions?.afterSequence)), handlers),
      prompt: (sessionId, input) => request(endpointPath('sessionPrompt', { sessionId }), { method: 'POST', body: input }),
      abort: (sessionId) => request(endpointPath('sessionAbort', { sessionId }), { method: 'POST', body: {} }),
      respondPermission: (sessionId, input) => request(endpointPath('sessionPermissionRespond', { sessionId }), { method: 'POST', body: input }),
      replyQuestion: (sessionId, input) => request(endpointPath('sessionQuestionReply', { sessionId }), { method: 'POST', body: input }),
      rejectQuestion: (sessionId, input) => request(endpointPath('sessionQuestionReject', { sessionId }), { method: 'POST', body: input }),
      artifacts: (sessionId) => request(withQuery(endpointPath('sessionArtifacts', { sessionId }), { limit: 100 })),
      artifact: (sessionId, artifactId) => request(endpointPath('sessionArtifact', { sessionId, artifactId })),
      updateArtifactStatus: (sessionId, artifactId, input) => request(endpointPath('sessionArtifactStatus', { sessionId, artifactId }), { method: 'POST', body: input }),
      uploadArtifact: (sessionId, input) => request(endpointPath('sessionArtifacts', { sessionId }), { method: 'POST', body: input }),
    },
    artifacts: {
      index: (query) => request(`${endpoint('artifactsIndex')}${queryString(query)}`),
    },
    launchpad: {
      feed: (query) => request(`${endpoint('launchpadFeed')}${queryString(query)}`),
    },
    knowledge: {
      snapshot: (query) => request(withQuery(endpoint('knowledgeSnapshot'), query || {})),
      createSpace: (input) => request(endpoint('knowledgeSpaceCreate'), { method: 'POST', body: input }),
      propose: (input) => request(endpoint('knowledgeProposalCreate'), { method: 'POST', body: input }),
      acceptProposal: (proposalId, input) => request(endpointPath('knowledgeProposalAccept', { proposalId }), { method: 'POST', body: input || {} }),
      declineProposal: (proposalId, input) => request(endpointPath('knowledgeProposalDecline', { proposalId }), { method: 'POST', body: input || {} }),
      history: (pageId, query) => request(withQuery(endpointPath('knowledgePageHistory', { pageId }), query || {})),
      restoreVersion: (pageId, versionId, input) => request(endpointPath('knowledgePageRestore', { pageId }), { method: 'POST', body: { ...(input as Record<string, unknown> || {}), versionId } }),
    },
    capabilities: {
      catalog: () => request(endpoint('capabilitiesCatalog')),
      tools: () => request(endpoint('capabilityTools')),
      skills: () => request(endpoint('capabilitySkills')),
    },
    workflows: {
      list: () => request(endpoint('workflows')),
      get: (workflowId) => request(endpointPath('workflow', { workflowId })),
      create: (input) => request(endpoint('workflows'), { method: 'POST', body: input }),
      run: (workflowId) => request(endpointPath('workflowRun', { workflowId }), { method: 'POST' }),
      pause: (workflowId) => request(endpointPath('workflowPause', { workflowId }), { method: 'POST' }),
      resume: (workflowId) => request(endpointPath('workflowResume', { workflowId }), { method: 'POST' }),
      archive: (workflowId) => request(endpointPath('workflowArchive', { workflowId }), { method: 'POST' }),
    },
    coordination: {
      board: () => request(endpoint('coordinationBoard')),
      projects: () => request(endpoint('coordinationProjects')),
      createProject: (input) => request(endpoint('coordinationProjectCreate'), { method: 'POST', body: input }),
      updateProject: (projectId, input) => request(endpointPath('coordinationProject', { projectId }), { method: 'POST', body: input }),
      planWithCleo: (projectId, input) => request(endpointPath('coordinationPlanWithCleo', { projectId }), { method: 'POST', body: input || {} }),
      tasks: (query) => request(withQuery(endpoint('coordinationTasks'), query || {})),
      createTask: (input) => request(endpoint('coordinationTaskCreate'), { method: 'POST', body: input }),
      updateTask: (taskId, input) => request(endpointPath('coordinationTask', { taskId }), { method: 'POST', body: input }),
      moveTask: (taskId, input) => request(endpointPath('coordinationTaskMove', { taskId }), { method: 'POST', body: input }),
      assignTask: (taskId, input) => request(endpointPath('coordinationTaskAssign', { taskId }), { method: 'POST', body: input }),
      linkTaskWork: (taskId, input) => request(endpointPath('coordinationTaskLinkWork', { taskId }), { method: 'POST', body: input }),
      taskWorkTarget: (taskId) => request(endpointPath('coordinationTaskWorkTarget', { taskId })),
      watches: (query) => request(withQuery(endpoint('coordinationWatches'), query || {})),
      createWatch: (input) => request(endpoint('coordinationWatchCreate'), { method: 'POST', body: input }),
      updateWatch: (watchId, input) => request(endpointPath('coordinationWatch', { watchId }), { method: 'POST', body: input }),
      pauseWatch: (watchId) => request(endpointPath('coordinationWatchPause', { watchId }), { method: 'POST' }),
      resumeWatch: (watchId) => request(endpointPath('coordinationWatchResume', { watchId }), { method: 'POST' }),
      deleteWatch: (watchId) => request(endpointPath('coordinationWatchDelete', { watchId }), { method: 'DELETE' }),
    },
    projectSources: {
      validate: (input) => request(endpoint('projectSourceValidate'), { method: 'POST', body: input }),
      uploadSnapshot: (input) => request(endpoint('projectSnapshots'), { method: 'POST', body: input }),
    },
    channels: {
      providers: (query) => request(withQuery(endpoint('channelProviders'), query || {})),
      agents: (query) => request(withQuery(endpoint('channelAgents'), query || {})),
      createAgent: (input) => request(endpoint('channelAgentCreate'), { method: 'POST', body: input }),
      updateAgent: (agentId, input) => request(endpointPath('channelAgentUpdate', { agentId }), { method: 'PATCH', body: input }),
      bindings: (query) => request(withQuery(endpoint('channelBindings'), query || {})),
      connectBinding: (input) => request(endpoint('channelBindingCreate'), { method: 'POST', body: input }),
      updateBinding: (bindingId, input) => request(endpointPath('channelBindingUpdate', { bindingId }), { method: 'PATCH', body: input }),
      disconnectBinding: (bindingId) => request(endpointPath('channelBindingUpdate', { bindingId }), { method: 'PATCH', body: { status: 'disabled' } }),
      people: (query) => request(withQuery(endpoint('channelIdentities'), query || {})),
      resolvePerson: (input) => request(endpoint('channelIdentityResolve'), { method: 'POST', body: input }),
      deliveries: (query) => request(withQuery(endpoint('channelDeliveries'), query || {})),
      retryDelivery: (deliveryId) => request(endpointPath('channelDeliveryRetry', { deliveryId }), { method: 'POST' }),
      deadLetterDelivery: (deliveryId, input) => request(endpointPath('channelDeliveryDeadLetter', { deliveryId }), { method: 'POST', body: input || {} }),
      watches: (query) => request(withQuery(endpoint('coordinationWatches'), query || {})),
      createWatch: (input) => request(endpoint('coordinationWatchCreate'), { method: 'POST', body: input }),
      updateWatch: (watchId, input) => request(endpointPath('coordinationWatch', { watchId }), { method: 'POST', body: input }),
      pauseWatch: (watchId) => request(endpointPath('coordinationWatchPause', { watchId }), { method: 'POST' }),
      resumeWatch: (watchId) => request(endpointPath('coordinationWatchResume', { watchId }), { method: 'POST' }),
      deleteWatch: (watchId) => request(endpointPath('coordinationWatchDelete', { watchId }), { method: 'DELETE' }),
    },
    admin: {
      policy: () => request(endpoint('adminPolicy')),
      members: {
        list: () => request(endpoint('adminMembers')),
        invite: (input) => request(endpoint('adminMemberInvite'), { method: 'POST', body: input }),
        update: (accountId, input) => request(endpointPath('adminMemberUpdate', { accountId }), { method: 'POST', body: input }),
      },
      byok: {
        list: () => request(endpoint('byok')),
        save: (providerId, input) => request(endpointPath('byokSave', { providerId }), { method: 'POST', body: input }),
        validate: (providerId) => request(endpointPath('byokValidate', { providerId }), { method: 'POST' }),
        override: (providerId, reason) => request(endpointPath('byokOverride', { providerId }), { method: 'POST', body: { reason } }),
        disable: (providerId) => request(endpointPath('byokDisable', { providerId }), { method: 'DELETE' }),
      },
      apiTokens: {
        list: () => request(endpoint('apiTokens')),
        create: (input) => request(endpoint('apiTokenCreate'), { method: 'POST', body: input }),
        revoke: (tokenId) => request(endpointPath('apiTokenRevoke', { tokenId }), { method: 'DELETE' }),
      },
      channels: {
        providers: (query) => request(withQuery(endpoint('channelProviders'), query || {})),
        agents: (query) => request(withQuery(endpoint('channelAgents'), query || {})),
        createAgent: (input) => request(endpoint('channelAgentCreate'), { method: 'POST', body: input }),
        updateAgent: (agentId, input) => request(endpointPath('channelAgentUpdate', { agentId }), { method: 'PATCH', body: input }),
        bindings: (query) => request(withQuery(endpoint('channelBindings'), query || {})),
        createBinding: (input) => request(endpoint('channelBindingCreate'), { method: 'POST', body: input }),
        updateBinding: (bindingId, input) => request(endpointPath('channelBindingUpdate', { bindingId }), { method: 'PATCH', body: input }),
        disconnectBinding: (bindingId) => request(endpointPath('channelBindingUpdate', { bindingId }), { method: 'PATCH', body: { status: 'disabled' } }),
        people: (query) => request(withQuery(endpoint('channelIdentities'), query || {})),
        resolvePerson: (input) => request(endpoint('channelIdentityResolve'), { method: 'POST', body: input }),
        deliveries: (query) => request(withQuery(endpoint('channelDeliveries'), query || {})),
        retryDelivery: (deliveryId) => request(endpointPath('channelDeliveryRetry', { deliveryId }), { method: 'POST' }),
        deadLetterDelivery: (deliveryId, input) => request(endpointPath('channelDeliveryDeadLetter', { deliveryId }), { method: 'POST', body: input || {} }),
        watches: (query) => request(withQuery(endpoint('coordinationWatches'), query || {})),
        createWatch: (input) => request(endpoint('coordinationWatchCreate'), { method: 'POST', body: input }),
        updateWatch: (watchId, input) => request(endpointPath('coordinationWatch', { watchId }), { method: 'POST', body: input }),
        pauseWatch: (watchId) => request(endpointPath('coordinationWatchPause', { watchId }), { method: 'POST' }),
        resumeWatch: (watchId) => request(endpointPath('coordinationWatchResume', { watchId }), { method: 'POST' }),
        deleteWatch: (watchId) => request(endpointPath('coordinationWatchDelete', { watchId }), { method: 'DELETE' }),
      },
      billing: {
        subscription: () => request(endpoint('billingSubscription')),
        checkout: (input) => request(endpoint('billingCheckout'), { method: 'POST', body: input }),
        portal: () => request(endpoint('billingPortal'), { method: 'POST', body: {} }),
      },
      usage: {
        events: () => request(endpoint('usageEvents')),
        summary: () => request(endpoint('usageSummary')),
      },
      audit: () => request(endpoint('adminAudit')),
      diagnostics: () => request(endpoint('diagnostics')),
      runtimeStatus: () => request(endpoint('runtimeStatus')),
      workerHeartbeats: () => request(endpoint('workerHeartbeats')),
      workers: () => request(endpoint('adminWorkers')),
      workerPools: () => request(endpoint('adminWorkerPools')),
    },
  }
}
