import { cloudArtifactFilePath, type AppAPI, type CoworkAPI } from '@open-cowork/shared'

function unsupported(name: string) {
  return () => Promise.reject(new Error(`${name} is not available through the desktop AppAPI adapter yet`))
}

function createChannelAppApi(coworkApi: CoworkAPI): AppAPI['channels'] {
  return {
    providers: async (query) => ({ providers: await coworkApi.channels.providers(query as Parameters<CoworkAPI['channels']['providers']>[0]) }),
    agents: async (query) => ({ agents: await coworkApi.channels.agents(query as Parameters<CoworkAPI['channels']['agents']>[0]) }),
    createAgent: async (input) => ({ agent: await coworkApi.channels.createAgent(input as Parameters<CoworkAPI['channels']['createAgent']>[0]) }),
    updateAgent: async (agentId, input) => ({ agent: await coworkApi.channels.updateAgent(agentId, input as Parameters<CoworkAPI['channels']['updateAgent']>[1]) }),
    bindings: async (query) => ({ bindings: await coworkApi.channels.bindings(query as Parameters<CoworkAPI['channels']['bindings']>[0]) }),
    connectBinding: async (input) => ({ binding: await coworkApi.channels.connectBinding(input as Parameters<CoworkAPI['channels']['connectBinding']>[0]) }),
    updateBinding: async (bindingId, input) => ({ binding: await coworkApi.channels.updateBinding(bindingId, input as Parameters<CoworkAPI['channels']['updateBinding']>[1]) }),
    disconnectBinding: async (bindingId, input) => ({ binding: await coworkApi.channels.disconnectBinding(bindingId, input as Parameters<CoworkAPI['channels']['disconnectBinding']>[1]) }),
    people: async (query) => ({ identities: await coworkApi.channels.people(query as Parameters<CoworkAPI['channels']['people']>[0]) }),
    resolvePerson: async (input) => ({ identity: await coworkApi.channels.resolvePerson(input as Parameters<CoworkAPI['channels']['resolvePerson']>[0]) }),
    deliveries: async (query) => ({ deliveries: await coworkApi.channels.deliveries(query as Parameters<CoworkAPI['channels']['deliveries']>[0]) }),
    retryDelivery: async (deliveryId) => ({ delivery: await coworkApi.channels.retryDelivery(deliveryId) }),
    deadLetterDelivery: async (deliveryId, input) => ({ delivery: await coworkApi.channels.deadLetterDelivery(deliveryId, input as Parameters<CoworkAPI['channels']['deadLetterDelivery']>[1]) }),
    watches: (query) => coworkApi.channels.watches(query as Parameters<CoworkAPI['channels']['watches']>[0]),
    createWatch: (input) => coworkApi.channels.createWatch(input as Parameters<CoworkAPI['channels']['createWatch']>[0]),
    updateWatch: (watchId, input) => coworkApi.channels.updateWatch(watchId, input as Parameters<CoworkAPI['channels']['updateWatch']>[1]),
    pauseWatch: coworkApi.channels.pauseWatch,
    resumeWatch: coworkApi.channels.resumeWatch,
    deleteWatch: coworkApi.channels.deleteWatch,
  }
}

export function createDesktopAppApi(coworkApi: CoworkAPI = window.coworkApi): AppAPI {
  const channels = createChannelAppApi(coworkApi)
  return {
    platform: 'desktop',
    endpoint: (_id, fallback) => fallback,
    endpointPath: (_id, fallback, params = {}) => Object.entries(params)
      .reduce((path, [key, value]) => path.replace(`:${key}`, encodeURIComponent(String(value))), fallback),
    request: unsupported('Raw HTTP requests'),
    stream: () => ({ close: () => {} }),
    auth: {
      me: coworkApi.auth.status,
      logout: coworkApi.auth.logout,
    },
    config: {
      current: coworkApi.app.config,
    },
    workspace: {
      current: () => coworkApi.workspace.list(),
      events: () => ({ close: coworkApi.on.workspaceSessionsUpdated(() => {}) }),
    },
    sessions: {
      list: () => coworkApi.session.list(),
      create: (input) => coworkApi.session.create(undefined, input as Parameters<CoworkAPI['session']['create']>[1]),
      view: (sessionId) => coworkApi.session.activate(sessionId),
      events: () => ({ close: coworkApi.on.sessionView(() => {}) }),
      prompt: (sessionId, input) => {
        const record = input && typeof input === 'object' ? input as { text?: string; agent?: string } : {}
        return coworkApi.session.prompt(sessionId, record.text || '', undefined, record.agent)
      },
      respondPermission: (sessionId, input) => {
        const record = input && typeof input === 'object' ? input as { permissionId?: string; response?: { allowed?: boolean } } : {}
        return coworkApi.permission.respond(record.permissionId || '', Boolean(record.response?.allowed), sessionId)
      },
      replyQuestion: (sessionId, input) => {
        const record = input && typeof input === 'object' ? input as { requestId?: string; answers?: string[][] } : {}
        return coworkApi.question.reply(sessionId, record.requestId || '', record.answers || [])
      },
      rejectQuestion: (sessionId, input) => {
        const record = input && typeof input === 'object' ? input as { requestId?: string } : {}
        return coworkApi.question.reject(sessionId, record.requestId || '')
      },
      artifacts: (sessionId) => coworkApi.artifact.list({ sessionId }),
      artifact: (sessionId, artifactId) => coworkApi.artifact.readAttachment({ sessionId, filePath: cloudArtifactFilePath(artifactId) }),
    },
    artifacts: {
      index: (query) => coworkApi.artifact.index(query as Parameters<CoworkAPI['artifact']['index']>[0]),
    },
    launchpad: {
      feed: (query) => coworkApi.launchpad.feed(query as Parameters<CoworkAPI['launchpad']['feed']>[0]),
    },
    capabilities: {
      catalog: () => Promise.all([coworkApi.capabilities.tools(), coworkApi.capabilities.skills()]),
      tools: () => coworkApi.capabilities.tools(),
      skills: () => coworkApi.capabilities.skills(),
    },
    workflows: {
      list: () => coworkApi.workflows.list(),
      get: (workflowId) => coworkApi.workflows.get(workflowId),
      create: unsupported('Workflow creation'),
      run: (workflowId) => coworkApi.workflows.runNow(workflowId),
      pause: (workflowId) => coworkApi.workflows.pause(workflowId),
      resume: (workflowId) => coworkApi.workflows.resume(workflowId),
      archive: (workflowId) => coworkApi.workflows.archive(workflowId),
    },
    coordination: {
      board: () => coworkApi.coordination.board(),
      projects: () => coworkApi.coordination.listProjects(),
      createProject: (input) => coworkApi.coordination.createProject(input as Parameters<CoworkAPI['coordination']['createProject']>[0]),
      updateProject: (projectId, input) => coworkApi.coordination.updateProject(projectId, input as Parameters<CoworkAPI['coordination']['updateProject']>[1]),
      tasks: (query) => coworkApi.coordination.listTasks(query as Parameters<CoworkAPI['coordination']['listTasks']>[0]),
      createTask: (input) => coworkApi.coordination.createTask(input as Parameters<CoworkAPI['coordination']['createTask']>[0]),
      updateTask: (taskId, input) => coworkApi.coordination.updateTask(taskId, input as Parameters<CoworkAPI['coordination']['updateTask']>[1]),
      moveTask: (taskId, input) => coworkApi.coordination.moveTask(taskId, input as Parameters<CoworkAPI['coordination']['moveTask']>[1]),
      assignTask: (taskId, input) => coworkApi.coordination.assignTask(taskId, input as Parameters<CoworkAPI['coordination']['assignTask']>[1]),
      linkTaskWork: (taskId, input) => coworkApi.coordination.linkTaskWork(taskId, input as Parameters<CoworkAPI['coordination']['linkTaskWork']>[1]),
      taskWorkTarget: (taskId) => coworkApi.coordination.taskWorkTarget(taskId),
      watches: (query) => coworkApi.coordination.listWatches(query as Parameters<CoworkAPI['coordination']['listWatches']>[0]),
      createWatch: (input) => coworkApi.coordination.createWatch(input as Parameters<CoworkAPI['coordination']['createWatch']>[0]),
      updateWatch: (watchId, input) => coworkApi.coordination.updateWatch(watchId, input as Parameters<CoworkAPI['coordination']['updateWatch']>[1]),
      pauseWatch: (watchId) => coworkApi.coordination.pauseWatch(watchId),
      resumeWatch: (watchId) => coworkApi.coordination.resumeWatch(watchId),
      deleteWatch: (watchId) => coworkApi.coordination.deleteWatch(watchId),
    },
    projectSources: {
      validate: (input) => coworkApi.projectSource.validate(input as Parameters<CoworkAPI['projectSource']['validate']>[0]),
      uploadSnapshot: (input) => coworkApi.projectSource.uploadSnapshot(input as Parameters<CoworkAPI['projectSource']['uploadSnapshot']>[0]),
    },
    channels,
    admin: {
      policy: unsupported('Cloud admin policy'),
      members: {
        list: unsupported('Cloud admin members'),
        invite: unsupported('Cloud admin member invite'),
        update: unsupported('Cloud admin member update'),
      },
      byok: {
        list: unsupported('Cloud BYOK'),
        save: unsupported('Cloud BYOK save'),
        validate: unsupported('Cloud BYOK validate'),
        disable: unsupported('Cloud BYOK disable'),
      },
      apiTokens: {
        list: unsupported('Cloud API tokens'),
        create: unsupported('Cloud API token create'),
        revoke: unsupported('Cloud API token revoke'),
      },
      channels: {
        ...channels,
        createBinding: channels.connectBinding,
      },
      billing: {
        subscription: unsupported('Cloud billing subscription'),
        checkout: unsupported('Cloud billing checkout'),
        portal: unsupported('Cloud billing portal'),
      },
      usage: {
        events: unsupported('Cloud usage events'),
        summary: unsupported('Cloud usage summary'),
      },
      audit: unsupported('Cloud admin audit'),
      diagnostics: coworkApi.app.exportDiagnostics,
      runtimeStatus: coworkApi.runtime.status,
      workerHeartbeats: unsupported('Cloud worker heartbeats'),
      workers: unsupported('Cloud admin workers'),
      workerPools: unsupported('Cloud admin worker pools'),
    },
    native: {
      clipboardWriteText: coworkApi.clipboard.writeText,
      selectDirectory: coworkApi.dialog.selectDirectory,
    },
  }
}
