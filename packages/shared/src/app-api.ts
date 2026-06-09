export type AppApiPlatform = 'desktop' | 'cloud'

export type AppApiHttpMethod = 'GET' | 'POST' | 'DELETE'

export type AppApiRequestOptions = {
  method?: AppApiHttpMethod
  body?: unknown
  headers?: Record<string, string>
}

export type AppApiEventPayload = {
  type: string
  data: unknown
  raw: unknown
}

export type AppApiEventHandlers = {
  open?: (event: unknown) => void
  message?: (event: AppApiEventPayload) => void
  error?: (event: unknown) => void
}

export type AppApiEventStream = {
  close: () => void
}

export type AppApiSessionEventsOptions = {
  afterSequence?: number | null
}

export type AppApiEndpointResolver = {
  endpoint: (id: string, fallback: string) => string
  endpointPath: (id: string, fallback: string, params?: Record<string, string | number>) => string
}

export type AppAPI = AppApiEndpointResolver & {
  platform: AppApiPlatform
  request: <T = unknown>(path: string, options?: AppApiRequestOptions) => Promise<T>
  stream: (path: string, handlers?: AppApiEventHandlers) => AppApiEventStream
  setCsrfToken?: (token: string | null) => void
  auth: {
    me: () => Promise<unknown>
    logout: () => Promise<unknown>
  }
  config: {
    current: () => Promise<unknown>
  }
  workspace: {
    current: () => Promise<unknown>
    events: (handlers?: AppApiEventHandlers) => AppApiEventStream
  }
  sessions: {
    list: (query?: Record<string, string | number | boolean | null | undefined>) => Promise<unknown>
    create: (input: unknown) => Promise<unknown>
    view: (sessionId: string) => Promise<unknown>
    events: (sessionId: string, handlers?: AppApiEventHandlers, options?: AppApiSessionEventsOptions) => AppApiEventStream
    prompt: (sessionId: string, input: unknown) => Promise<unknown>
    respondPermission: (sessionId: string, input: unknown) => Promise<unknown>
    replyQuestion: (sessionId: string, input: unknown) => Promise<unknown>
    rejectQuestion: (sessionId: string, input: unknown) => Promise<unknown>
    artifacts: (sessionId: string) => Promise<unknown>
    artifact: (sessionId: string, artifactId: string) => Promise<unknown>
  }
  artifacts: {
    index: (query?: Record<string, string | number | boolean | null | undefined>) => Promise<unknown>
  }
  capabilities: {
    catalog: () => Promise<unknown>
    tools: () => Promise<unknown>
    skills: () => Promise<unknown>
  }
  workflows: {
    list: () => Promise<unknown>
    get: (workflowId: string) => Promise<unknown>
    create: (input: unknown) => Promise<unknown>
    run: (workflowId: string) => Promise<unknown>
    pause: (workflowId: string) => Promise<unknown>
    resume: (workflowId: string) => Promise<unknown>
    archive: (workflowId: string) => Promise<unknown>
  }
  coordination: {
    board: () => Promise<unknown>
    projects: () => Promise<unknown>
    createProject: (input: unknown) => Promise<unknown>
    updateProject: (projectId: string, input: unknown) => Promise<unknown>
    tasks: (query?: Record<string, string | number | boolean | null | undefined>) => Promise<unknown>
    createTask: (input: unknown) => Promise<unknown>
    updateTask: (taskId: string, input: unknown) => Promise<unknown>
    moveTask: (taskId: string, input: unknown) => Promise<unknown>
    assignTask: (taskId: string, input: unknown) => Promise<unknown>
    linkTaskWork: (taskId: string, input: unknown) => Promise<unknown>
    taskWorkTarget: (taskId: string) => Promise<unknown>
  }
  projectSources: {
    validate: (input: unknown) => Promise<unknown>
    uploadSnapshot: (input: unknown) => Promise<unknown>
  }
  channels: {
    agents: () => Promise<unknown>
    bindings: () => Promise<unknown>
    deliveries: () => Promise<unknown>
  }
  admin: {
    policy: () => Promise<unknown>
    members: {
      list: () => Promise<unknown>
      invite: (input: unknown) => Promise<unknown>
      update: (accountId: string, input: unknown) => Promise<unknown>
    }
    byok: {
      list: () => Promise<unknown>
      save: (providerId: string, input: unknown) => Promise<unknown>
      validate: (providerId: string) => Promise<unknown>
      disable: (providerId: string) => Promise<unknown>
    }
    apiTokens: {
      list: () => Promise<unknown>
      create: (input: unknown) => Promise<unknown>
      revoke: (tokenId: string) => Promise<unknown>
    }
    channels: {
      agents: () => Promise<unknown>
      createAgent: (input: unknown) => Promise<unknown>
      bindings: () => Promise<unknown>
      createBinding: (input: unknown) => Promise<unknown>
      deliveries: () => Promise<unknown>
      retryDelivery: (deliveryId: string) => Promise<unknown>
      deadLetterDelivery: (deliveryId: string, input?: unknown) => Promise<unknown>
    }
    billing: {
      subscription: () => Promise<unknown>
      checkout: (input: unknown) => Promise<unknown>
      portal: () => Promise<unknown>
    }
    usage: {
      events: () => Promise<unknown>
      summary: () => Promise<unknown>
    }
    audit: () => Promise<unknown>
    diagnostics: () => Promise<unknown>
    runtimeStatus: () => Promise<unknown>
    workerHeartbeats: () => Promise<unknown>
    workers: () => Promise<unknown>
    workerPools: () => Promise<unknown>
  }
  native?: {
    clipboardWriteText?: (text: string) => Promise<boolean>
    selectDirectory?: () => Promise<string | null>
    openExternal?: (url: string) => Promise<boolean>
  }
}
