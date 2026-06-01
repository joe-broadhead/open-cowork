import { contextBridge, ipcRenderer } from 'electron'
import type {
  CoworkAPI,
  McpStatus,
  PermissionRequest,
  RuntimeNotification,
  RuntimeLoadingStatus,
  SessionPatch,
  SessionView,
  UpdateInstallEvent,
  WorkspaceSessionsUpdatedEvent,
} from '@open-cowork/shared'

const PRELOAD_INVOKE_CHANNELS = [
  'workspace:list',
  'workspace:activate',
  'workspace:add-cloud',
  'workspace:add-gateway',
  'workspace:remove',
  'workspace:login',
  'workspace:logout',
  'workspace:policy',
  'workspace:support',
  'workspace:sync',
  'desktop-pairing:list',
  'desktop-pairing:create',
  'desktop-pairing:update',
  'desktop-pairing:connect',
  'desktop-pairing:disconnect',
  'desktop-pairing:revoke',
  'desktop-pairing:sync',
  'desktop-pairing:audit',
  'auth:status',
  'auth:login',
  'auth:logout',
  'session:create',
  'session:activate',
  'session:prompt',
  'session:set-composer-preferences',
  'session:list',
  'session:get',
  'session:import-inventory',
  'session:copy-to-cloud',
  'session:abort',
  'session:abort-task',
  'session:rename',
  'session:delete',
  'session:export',
  'session:fork',
  'session:share',
  'session:unshare',
  'session:summarize',
  'session:revert',
  'session:unrevert',
  'session:children',
  'session:diff',
  'session:file-snippet',
  'session:todo',
  'project-source:validate',
  'project-source:snapshot-inventory',
  'project-source:upload-snapshot',
  'dialog:select-directory',
  'dialog:select-image',
  'dialog:open-json',
  'dialog:save-text',
  'chart:render-svg',
  'chart:save-artifact',
  'artifact:list',
  'artifact:upload',
  'artifact:export',
  'artifact:reveal',
  'artifact:read-attachment',
  'artifact:storage-stats',
  'artifact:cleanup',
  'confirm:request-destructive',
  'clipboard:write-text',
  'tool:list',
  'command:list',
  'command:run',
  'permission:respond',
  'question:reply',
  'question:reject',
  'settings:get',
  'settings:get-provider-credentials',
  'settings:get-integration-credentials',
  'settings:set',
  'mcp:auth',
  'mcp:connect',
  'mcp:disconnect',
  'mcp:preflight',
  'model:info',
  'provider:list',
  'provider:auth-methods',
  'provider:oauth-authorize',
  'provider:oauth-callback',
  'provider:auth-remove',
  'runtime:status',
  'runtime:await-initialization',
  'runtime:restart',
  'projects:list',
  'projects:switch-by-index',
  'diagnostics:perf',
  'app:metadata',
  'app:config',
  'app:builtin-agents',
  'app:runtime-inputs',
  'app:refresh-provider-catalog',
  'app:export-diagnostics',
  'app:check-updates',
  'app:reset',
  'updates:install-capability',
  'updates:check-installable',
  'updates:download',
  'updates:quit-and-install',
  'workflows:list',
  'workflows:get',
  'workflows:start-draft',
  'workflows:run-now',
  'workflows:pause',
  'workflows:resume',
  'workflows:archive',
  'workflows:regenerate-webhook-secret',
  'threads:search',
  'threads:facets',
  'threads:tags:list',
  'threads:tags:create',
  'threads:tags:update',
  'threads:tags:delete',
  'threads:tags:apply',
  'threads:tags:remove',
  'threads:smart-filters:list',
  'threads:smart-filters:create',
  'threads:smart-filters:update',
  'threads:smart-filters:delete',
  'threads:suggestions:accept',
  'threads:suggestions:edit',
  'threads:suggestions:dismiss',
  'threads:reindex',
  'agents:catalog',
  'agents:list',
  'agents:runtime',
  'agents:create',
  'agents:update',
  'agents:remove',
  'explorer:file-list',
  'explorer:file-read',
  'explorer:file-status',
  'explorer:find-files',
  'explorer:find-symbols',
  'explorer:find-text',
  'custom:list-mcps',
  'custom:add-mcp',
  'custom:remove-mcp',
  'custom:test-mcp',
  'custom:list-skills',
  'custom:add-skill',
  'custom:select-skill-directory',
  'custom:import-skill-directory',
  'custom:remove-skill',
  'capabilities:tools',
  'capabilities:tool',
  'capabilities:skills',
  'capabilities:skill-bundle',
  'capabilities:skill-bundle-file',
] as const

const PRELOAD_SEND_CHANNELS = [
  'diagnostics:renderer-error',
] as const

const PRELOAD_LISTEN_CHANNELS = [
  'updates:install-event',
  'session:patch',
  'runtime:notification',
  'session:view',
  'permission:request',
  'mcp:status',
  'auth:expired',
  'auth:logout',
  'action',
  'navigate',
  'runtime:ready',
  'runtime:loading-status',
  'session:updated',
  'session:deleted',
  'workspace:sessions-updated',
  'workflow:updated',
] as const

type PreloadInvokeChannel = typeof PRELOAD_INVOKE_CHANNELS[number]
type PreloadSendChannel = typeof PRELOAD_SEND_CHANNELS[number]
type PreloadListenChannel = typeof PRELOAD_LISTEN_CHANNELS[number]
type IpcRendererListener = Parameters<typeof ipcRenderer.on>[1]

const allowedInvokeChannels = new Set<string>(PRELOAD_INVOKE_CHANNELS)
const allowedSendChannels = new Set<string>(PRELOAD_SEND_CHANNELS)
const allowedListenChannels = new Set<string>(PRELOAD_LISTEN_CHANNELS)

function invoke(channel: PreloadInvokeChannel, ...args: unknown[]) {
  if (!allowedInvokeChannels.has(channel)) {
    throw new Error(`Blocked unexpected IPC invoke channel: ${channel}`)
  }
  return ipcRenderer.invoke(channel, ...args)
}

function send(channel: PreloadSendChannel, ...args: unknown[]) {
  if (!allowedSendChannels.has(channel)) {
    throw new Error(`Blocked unexpected IPC send channel: ${channel}`)
  }
  ipcRenderer.send(channel, ...args)
}

function listen(channel: PreloadListenChannel, handler: IpcRendererListener) {
  if (!allowedListenChannels.has(channel)) {
    throw new Error(`Blocked unexpected IPC listen channel: ${channel}`)
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: CoworkAPI = {
  workspace: {
    list: () => invoke('workspace:list'),
    activate: (workspaceId) => invoke('workspace:activate', workspaceId),
    addCloud: (input) => invoke('workspace:add-cloud', input),
    addGateway: (input) => invoke('workspace:add-gateway', input),
    remove: (workspaceId) => invoke('workspace:remove', workspaceId),
    login: (workspaceId) => invoke('workspace:login', workspaceId),
    logout: (workspaceId) => invoke('workspace:logout', workspaceId),
    policy: (workspaceId) => invoke('workspace:policy', workspaceId),
    support: (workspaceId) => invoke('workspace:support', workspaceId),
    sync: (workspaceId) => invoke('workspace:sync', workspaceId),
  },
  desktopPairing: {
    list: () => invoke('desktop-pairing:list'),
    create: (input) => invoke('desktop-pairing:create', input),
    update: (pairingId, input) => invoke('desktop-pairing:update', pairingId, input),
    connect: (pairingId) => invoke('desktop-pairing:connect', pairingId),
    disconnect: (pairingId) => invoke('desktop-pairing:disconnect', pairingId),
    revoke: (pairingId) => invoke('desktop-pairing:revoke', pairingId),
    sync: (pairingId) => invoke('desktop-pairing:sync', pairingId),
    audit: (pairingId) => invoke('desktop-pairing:audit', pairingId),
  },
  auth: {
    status: () => invoke('auth:status'),
    login: () => invoke('auth:login'),
    logout: () => invoke('auth:logout'),
  },
  session: {
    create: (directory?, options?) => invoke('session:create', directory, options),
    activate: (sessionId, options) => invoke('session:activate', sessionId, options),
    prompt: (sessionId, text, attachments, agent, options) => invoke('session:prompt', sessionId, text, attachments, agent, options),
    setComposerPreferences: (sessionId, preferences) => invoke('session:set-composer-preferences', sessionId, preferences),
    list: (options?) => invoke('session:list', options),
    get: (id, options?) => invoke('session:get', id, options),
    importInventory: (sessionId) => invoke('session:import-inventory', sessionId),
    copyToCloud: (sessionId, input) => invoke('session:copy-to-cloud', sessionId, input),
    abort: (sessionId, options) => invoke('session:abort', sessionId, options),
    abortTask: (rootSessionId, childSessionId) => invoke('session:abort-task', rootSessionId, childSessionId),
    rename: (sessionId, title) => invoke('session:rename', sessionId, title),
    delete: (sessionId, confirmationToken) => invoke('session:delete', sessionId, confirmationToken),
    export: (sessionId) => invoke('session:export', sessionId),
    fork: (sessionId, messageId) => invoke('session:fork', sessionId, messageId),
    share: (sessionId) => invoke('session:share', sessionId),
    unshare: (sessionId) => invoke('session:unshare', sessionId),
    summarize: (sessionId) => invoke('session:summarize', sessionId),
    revert: (sessionId, messageId) => invoke('session:revert', sessionId, messageId),
    unrevert: (sessionId) => invoke('session:unrevert', sessionId),
    children: (sessionId) => invoke('session:children', sessionId),
    diff: (sessionId, messageId) => invoke('session:diff', sessionId, messageId),
    fileSnippet: (request) => invoke('session:file-snippet', request),
    todo: (sessionId) => invoke('session:todo', sessionId),
  },
  projectSource: {
    validate: (input) => invoke('project-source:validate', input),
    snapshotInventory: (input) => invoke('project-source:snapshot-inventory', input),
    uploadSnapshot: (input) => invoke('project-source:upload-snapshot', input),
  },
  dialog: {
    selectDirectory: () => invoke('dialog:select-directory'),
    selectImage: () => invoke('dialog:select-image'),
    openJson: () => invoke('dialog:open-json'),
    saveText: (defaultFilename, content) => invoke('dialog:save-text', defaultFilename, content),
  },
  chart: {
    renderSvg: (spec) => invoke('chart:render-svg', spec),
    saveArtifact: (request) => invoke('chart:save-artifact', request),
  },
  artifact: {
    list: (request) => invoke('artifact:list', request),
    upload: (request) => invoke('artifact:upload', request),
    export: (request) => invoke('artifact:export', request),
    reveal: (request) => invoke('artifact:reveal', request),
    readAttachment: (request) => invoke('artifact:read-attachment', request),
    storageStats: () => invoke('artifact:storage-stats'),
    cleanup: (mode) => invoke('artifact:cleanup', mode),
  },
  confirm: {
    requestDestructive: (request) => invoke('confirm:request-destructive', request),
  },
  clipboard: {
    writeText: (text) => invoke('clipboard:write-text', text),
  },
  tools: {
    list: (options) => invoke('tool:list', options),
  },
  command: {
    list: () => invoke('command:list'),
    run: (sessionId, name) => invoke('command:run', sessionId, name),
  },
  permission: {
    respond: (id, allowed, sessionId, options) => invoke('permission:respond', id, allowed, sessionId, options),
  },
  question: {
    reply: (sessionId, requestId, answers, options) => invoke('question:reply', sessionId, requestId, answers, options),
    reject: (sessionId, requestId, options) => invoke('question:reject', sessionId, requestId, options),
  },
  settings: {
    get: (options) => invoke('settings:get', options),
    getProviderCredentials: (providerId, options) => invoke('settings:get-provider-credentials', providerId, options),
    getIntegrationCredentials: (integrationId, options) => invoke('settings:get-integration-credentials', integrationId, options),
    set: (updates) => invoke('settings:set', updates),
  },
  mcp: {
    auth: (mcpName) => invoke('mcp:auth', mcpName),
    connect: (name) => invoke('mcp:connect', name),
    disconnect: (name) => invoke('mcp:disconnect', name),
    preflight: (name) => invoke('mcp:preflight', name),
  },
  model: {
    info: () => invoke('model:info'),
  },
  provider: {
    list: () => invoke('provider:list'),
    authMethods: () => invoke('provider:auth-methods'),
    authorize: (providerId, method, inputs) => invoke('provider:oauth-authorize', providerId, method, inputs),
    callback: (providerId, method, code) => invoke('provider:oauth-callback', providerId, method, code),
    logout: (providerId) => invoke('provider:auth-remove', providerId),
  },
  runtime: {
    status: () => invoke('runtime:status'),
    awaitInitialization: () => invoke('runtime:await-initialization'),
    restart: () => invoke('runtime:restart'),
  },
  projects: {
    list: () => invoke('projects:list'),
    switchByIndex: (index) => invoke('projects:switch-by-index', index),
  },
  diagnostics: {
    perf: () => invoke('diagnostics:perf'),
    reportRendererError: (payload) => send('diagnostics:renderer-error', payload),
  },
  app: {
    metadata: () => invoke('app:metadata'),
    config: () => invoke('app:config'),
    builtinAgents: () => invoke('app:builtin-agents'),
    runtimeInputs: () => invoke('app:runtime-inputs'),
    refreshProviderCatalog: (providerId) => invoke('app:refresh-provider-catalog', providerId),
    exportDiagnostics: () => invoke('app:export-diagnostics'),
    checkUpdates: () => invoke('app:check-updates'),
    reset: (confirmationToken) => invoke('app:reset', confirmationToken),
  },
  updates: {
    installCapability: () => invoke('updates:install-capability'),
    checkInstallable: () => invoke('updates:check-installable'),
    download: () => invoke('updates:download'),
    quitAndInstall: () => invoke('updates:quit-and-install'),
    onInstallEvent: (callback: (event: UpdateInstallEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: UpdateInstallEvent) => callback(data)
      return listen('updates:install-event', handler)
    },
  },
  workflows: {
    list: (options) => options ? invoke('workflows:list', options) : invoke('workflows:list'),
    get: (workflowId, options) => options ? invoke('workflows:get', workflowId, options) : invoke('workflows:get', workflowId),
    startDraft: (directory) => invoke('workflows:start-draft', directory),
    runNow: (workflowId, options) => options ? invoke('workflows:run-now', workflowId, options) : invoke('workflows:run-now', workflowId),
    pause: (workflowId, options) => options ? invoke('workflows:pause', workflowId, options) : invoke('workflows:pause', workflowId),
    resume: (workflowId, options) => options ? invoke('workflows:resume', workflowId, options) : invoke('workflows:resume', workflowId),
    archive: (workflowId, options) => options ? invoke('workflows:archive', workflowId, options) : invoke('workflows:archive', workflowId),
    regenerateWebhookSecret: (workflowId) => invoke('workflows:regenerate-webhook-secret', workflowId),
  },
  threads: {
    search: (query) => invoke('threads:search', query),
    facets: (query) => invoke('threads:facets', query),
    tags: {
      list: (options) => options ? invoke('threads:tags:list', options) : invoke('threads:tags:list'),
      create: (input, options) => options ? invoke('threads:tags:create', input, options) : invoke('threads:tags:create', input),
      update: (tagId, input, options) => options ? invoke('threads:tags:update', tagId, input, options) : invoke('threads:tags:update', tagId, input),
      delete: (tagId, options) => options ? invoke('threads:tags:delete', tagId, options) : invoke('threads:tags:delete', tagId),
      apply: (sessionIds, tagIds, options) => options ? invoke('threads:tags:apply', sessionIds, tagIds, options) : invoke('threads:tags:apply', sessionIds, tagIds),
      remove: (sessionIds, tagIds, options) => options ? invoke('threads:tags:remove', sessionIds, tagIds, options) : invoke('threads:tags:remove', sessionIds, tagIds),
    },
    smartFilters: {
      list: (options) => options ? invoke('threads:smart-filters:list', options) : invoke('threads:smart-filters:list'),
      create: (input, options) => options ? invoke('threads:smart-filters:create', input, options) : invoke('threads:smart-filters:create', input),
      update: (filterId, input, options) => options ? invoke('threads:smart-filters:update', filterId, input, options) : invoke('threads:smart-filters:update', filterId, input),
      delete: (filterId, options) => options ? invoke('threads:smart-filters:delete', filterId, options) : invoke('threads:smart-filters:delete', filterId),
    },
    suggestions: {
      accept: (suggestionId) => invoke('threads:suggestions:accept', suggestionId),
      edit: (suggestionId, input) => invoke('threads:suggestions:edit', suggestionId, input),
      dismiss: (suggestionId) => invoke('threads:suggestions:dismiss', suggestionId),
    },
    reindex: (sessionIds) => invoke('threads:reindex', sessionIds),
  },
  agents: {
    catalog: (options) => invoke('agents:catalog', options),
    list: (options) => invoke('agents:list', options),
    runtime: () => invoke('agents:runtime'),
    create: (agent) => invoke('agents:create', agent),
    update: (target, agent) => invoke('agents:update', target, agent),
    remove: (target, confirmationToken) => invoke('agents:remove', target, confirmationToken),
  },
  explorer: {
    fileList: (path, directory) => invoke('explorer:file-list', path, directory ?? null),
    fileRead: (path, directory) => invoke('explorer:file-read', path, directory ?? null),
    fileStatus: (directory) => invoke('explorer:file-status', directory ?? null),
    findFiles: (options, directory) => invoke('explorer:find-files', options, directory ?? null),
    findSymbols: (query, directory) => invoke('explorer:find-symbols', query, directory ?? null),
    findText: (pattern, directory) => invoke('explorer:find-text', pattern, directory ?? null),
  },
  custom: {
    listMcps: (options) => invoke('custom:list-mcps', options),
    addMcp: (mcp) => invoke('custom:add-mcp', mcp),
    removeMcp: (target, confirmationToken) => invoke('custom:remove-mcp', target, confirmationToken),
    testMcp: (mcp) => invoke('custom:test-mcp', mcp),
    listSkills: (options) => invoke('custom:list-skills', options),
    addSkill: (skill) => invoke('custom:add-skill', skill),
    selectSkillDirectoryImport: () => invoke('custom:select-skill-directory'),
    importSkillDirectory: (selectionToken, target) => invoke('custom:import-skill-directory', selectionToken, target),
    removeSkill: (target, confirmationToken) => invoke('custom:remove-skill', target, confirmationToken),
  },
  capabilities: {
    tools: (options) => invoke('capabilities:tools', options),
    tool: (id, options) => invoke('capabilities:tool', id, options),
    skills: (options) => invoke('capabilities:skills', options),
    skillBundle: (name, options) => invoke('capabilities:skill-bundle', name, options),
    skillBundleFile: (name, path, options) => invoke('capabilities:skill-bundle-file', name, path, options),
  },
  on: {
    sessionPatch: (callback: (patch: SessionPatch) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: SessionPatch) => callback(data)
      return listen('session:patch', handler)
    },
    notification: (callback: (event: RuntimeNotification) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: RuntimeNotification) => callback(data)
      return listen('runtime:notification', handler)
    },
    sessionView: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; workspaceId?: string | null; view: SessionView }) => callback(data)
      return listen('session:view', handler)
    },
    permissionRequest: (callback: (request: PermissionRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: PermissionRequest) => callback(data)
      return listen('permission:request', handler)
    },
    mcpStatus: (callback: (statuses: McpStatus[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: McpStatus[]) => callback(data)
      return listen('mcp:status', handler)
    },
    authExpired: (callback: () => void) => {
      const handler = () => callback()
      return listen('auth:expired', handler)
    },
    authLogout: (callback: () => void) => {
      const handler = () => callback()
      return listen('auth:logout', handler)
    },
    menuAction: (callback: (action: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action)
      return listen('action', handler)
    },
    menuNavigate: (callback: (view: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, view: string) => callback(view)
      return listen('navigate', handler)
    },
    runtimeReady: (callback: () => void) => {
      const handler = () => callback()
      return listen('runtime:ready', handler)
    },
    runtimeLoadingStatus: (callback: (status: RuntimeLoadingStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: RuntimeLoadingStatus) => callback(data)
      return listen('runtime:loading-status', handler)
    },
    sessionUpdated: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data)
      return listen('session:updated', handler)
    },
    sessionDeleted: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data)
      return listen('session:deleted', handler)
    },
    workspaceSessionsUpdated: (callback: (data: WorkspaceSessionsUpdatedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: WorkspaceSessionsUpdatedEvent) => callback(data)
      return listen('workspace:sessions-updated', handler)
    },
    workflowUpdated: (callback: () => void) => {
      const handler = () => callback()
      return listen('workflow:updated', handler)
    },
  },
}

// Exposed as a brand-neutral `window.coworkApi`. Downstream forks don't
// need to rename the preload key — they just change `branding.name` in
// config and the UI reflects their label while the internal plumbing
// stays stable.
contextBridge.exposeInMainWorld('coworkApi', api)
