import { cloudArtifactFilePath, type AppAPI, type CoworkAPI } from '@open-cowork/shared'

function unsupported(name: string) {
  return () => Promise.reject(new Error(`${name} is not available through the desktop AppAPI adapter yet`))
}

export function createDesktopAppApi(coworkApi: CoworkAPI = window.coworkApi): AppAPI {
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
    projectSources: {
      validate: (input) => coworkApi.projectSource.validate(input as Parameters<CoworkAPI['projectSource']['validate']>[0]),
      uploadSnapshot: (input) => coworkApi.projectSource.uploadSnapshot(input as Parameters<CoworkAPI['projectSource']['uploadSnapshot']>[0]),
    },
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
        agents: unsupported('Cloud channel agents'),
        createAgent: unsupported('Cloud channel agent create'),
        bindings: unsupported('Cloud channel bindings'),
        createBinding: unsupported('Cloud channel binding create'),
        deliveries: unsupported('Cloud channel deliveries'),
        retryDelivery: unsupported('Cloud channel delivery retry'),
        deadLetterDelivery: unsupported('Cloud channel delivery dead-letter'),
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
