import { contextBridge, ipcRenderer } from 'electron'
import type {
  CoworkAPI,
  McpStatus,
  PermissionRequest,
  RuntimeNotification,
  SessionPatch,
  SessionView,
  UpdateInstallEvent,
} from '@open-cowork/shared'

const PRELOAD_INVOKE_CHANNELS = [
  'auth:status',
  'auth:login',
  'auth:logout',
  'session:create',
  'session:activate',
  'session:prompt',
  'session:list',
  'session:get',
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
  'dialog:select-directory',
  'dialog:select-image',
  'dialog:open-json',
  'dialog:save-text',
  'chart:render-svg',
  'chart:save-artifact',
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
  'model:info',
  'provider:list',
  'provider:auth-methods',
  'provider:oauth-authorize',
  'provider:oauth-callback',
  'provider:auth-remove',
  'runtime:status',
  'runtime:restart',
  'diagnostics:perf',
  'app:metadata',
  'app:config',
  'app:builtin-agents',
  'app:dashboard-summary',
  'app:runtime-inputs',
  'app:refresh-provider-catalog',
  'app:export-diagnostics',
  'app:check-updates',
  'app:reset',
  'operations:workspace-profiles',
  'operations:queue-items',
  'operations:queue-alerts',
  'operations:capability-risks',
  'operations:governance-registry',
  'operations:governance-audit-events',
  'operations:export-governance-audit',
  'operations:pause-agent',
  'operations:retire-agent',
  'channels:list',
  'channels:definitions',
  'channels:inbound-items',
  'channels:deliveries',
  'channels:local-webhook-status',
  'channels:local-webhook-pairings',
  'channels:create-local-webhook',
  'channels:rotate-local-webhook-token',
  'channels:approve-inbound-item',
  'channels:dismiss-inbound-item',
  'channels:create-delivery-draft',
  'channels:send-delivery',
  'channels:cancel-delivery',
  'improvements:summary',
  'improvements:inbox',
  'improvements:memory-approve',
  'improvements:memory-reject',
  'improvements:memory-archive',
  'improvements:proposal-update',
  'improvements:proposal-approve',
  'improvements:proposal-reject',
  'improvements:proposal-archive',
  'improvements:dream-start',
  'improvements:dream-cancel',
  'improvements:dream-archive',
  'updates:install-capability',
  'updates:check-installable',
  'updates:download',
  'updates:quit-and-install',
  'automation:list',
  'automation:get',
  'automation:create',
  'automation:update',
  'automation:pause',
  'automation:resume',
  'automation:archive',
  'automation:run-now',
  'automation:retry-run',
  'automation:cancel-run',
  'automation:preview-brief',
  'automation:approve-brief',
  'automation:inbox-respond',
  'automation:inbox-dismiss',
  'crews:list',
  'crews:get',
  'crews:create',
  'crews:update',
  'crews:pause',
  'crews:retire',
  'crews:run',
  'crews:run-detail',
  'crews:evaluate',
  'crews:export-trace',
  'sops:list',
  'sops:get',
  'sops:save-from-automation-run',
  'sops:update',
  'sops:run-now',
  'sops:run-trigger',
  'sops:run-detail',
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

type PreloadInvokeChannel = typeof PRELOAD_INVOKE_CHANNELS[number]
type PreloadSendChannel = typeof PRELOAD_SEND_CHANNELS[number]

const allowedInvokeChannels = new Set<string>(PRELOAD_INVOKE_CHANNELS)
const allowedSendChannels = new Set<string>(PRELOAD_SEND_CHANNELS)

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

const api: CoworkAPI = {
  auth: {
    status: () => invoke('auth:status'),
    login: () => invoke('auth:login'),
    logout: () => invoke('auth:logout'),
  },
  session: {
    create: (directory?) => invoke('session:create', directory),
    activate: (sessionId, options) => invoke('session:activate', sessionId, options),
    prompt: (sessionId, text, attachments, agent, options) => invoke('session:prompt', sessionId, text, attachments, agent, options),
    list: () => invoke('session:list'),
    get: (id) => invoke('session:get', id),
    abort: (sessionId) => invoke('session:abort', sessionId),
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
    respond: (id, allowed, sessionId) => invoke('permission:respond', id, allowed, sessionId),
  },
  question: {
    reply: (sessionId, requestId, answers) => invoke('question:reply', sessionId, requestId, answers),
    reject: (sessionId, requestId) => invoke('question:reject', sessionId, requestId),
  },
  settings: {
    get: () => invoke('settings:get'),
    getProviderCredentials: (providerId) => invoke('settings:get-provider-credentials', providerId),
    getIntegrationCredentials: (integrationId) => invoke('settings:get-integration-credentials', integrationId),
    set: (updates) => invoke('settings:set', updates),
  },
  mcp: {
    auth: (mcpName) => invoke('mcp:auth', mcpName),
    connect: (name) => invoke('mcp:connect', name),
    disconnect: (name) => invoke('mcp:disconnect', name),
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
    restart: () => invoke('runtime:restart'),
  },
  diagnostics: {
    perf: () => invoke('diagnostics:perf'),
    reportRendererError: (payload) => send('diagnostics:renderer-error', payload),
  },
  app: {
    metadata: () => invoke('app:metadata'),
    config: () => invoke('app:config'),
    builtinAgents: () => invoke('app:builtin-agents'),
    dashboardSummary: (range) => invoke('app:dashboard-summary', range),
    runtimeInputs: () => invoke('app:runtime-inputs'),
    refreshProviderCatalog: (providerId) => invoke('app:refresh-provider-catalog', providerId),
    exportDiagnostics: () => invoke('app:export-diagnostics'),
    checkUpdates: () => invoke('app:check-updates'),
    reset: (confirmationToken) => invoke('app:reset', confirmationToken),
  },
  operations: {
    workspaceProfiles: () => invoke('operations:workspace-profiles'),
    queueItems: () => invoke('operations:queue-items'),
    queueAlerts: () => invoke('operations:queue-alerts'),
    capabilityRisks: () => invoke('operations:capability-risks'),
    governanceRegistry: () => invoke('operations:governance-registry'),
    governanceAuditEvents: (options) => invoke('operations:governance-audit-events', options),
    exportGovernanceAudit: (options) => invoke('operations:export-governance-audit', options),
    pauseAgent: (request) => invoke('operations:pause-agent', request),
    retireAgent: (request) => invoke('operations:retire-agent', request),
  },
  channels: {
    list: () => invoke('channels:list'),
    definitions: () => invoke('channels:definitions'),
    inboundItems: () => invoke('channels:inbound-items'),
    deliveries: () => invoke('channels:deliveries'),
    localWebhookStatus: () => invoke('channels:local-webhook-status'),
    localWebhookPairings: () => invoke('channels:local-webhook-pairings'),
    createLocalWebhook: (draft) => invoke('channels:create-local-webhook', draft),
    rotateLocalWebhookToken: (channelId) => invoke('channels:rotate-local-webhook-token', channelId),
    approveInboundItem: (itemId) => invoke('channels:approve-inbound-item', itemId),
    dismissInboundItem: (itemId, note) => invoke('channels:dismiss-inbound-item', itemId, note),
    createDeliveryDraft: (itemId) => invoke('channels:create-delivery-draft', itemId),
    sendDelivery: (deliveryId) => invoke('channels:send-delivery', deliveryId),
    cancelDelivery: (deliveryId, note) => invoke('channels:cancel-delivery', deliveryId, note),
  },
  improvements: {
    summary: () => invoke('improvements:summary'),
    inbox: () => invoke('improvements:inbox'),
    approveMemory: (id, note) => invoke('improvements:memory-approve', id, note),
    rejectMemory: (id, note) => invoke('improvements:memory-reject', id, note),
    archiveMemory: (id, note) => invoke('improvements:memory-archive', id, note),
    updateProposal: (id, draft) => invoke('improvements:proposal-update', id, draft),
    approveProposal: (id, note) => invoke('improvements:proposal-approve', id, note),
    rejectProposal: (id, note) => invoke('improvements:proposal-reject', id, note),
    archiveProposal: (id, note) => invoke('improvements:proposal-archive', id, note),
    startDreamRun: () => invoke('improvements:dream-start'),
    cancelDreamRun: (id, note) => invoke('improvements:dream-cancel', id, note),
    archiveDreamRun: (id, note) => invoke('improvements:dream-archive', id, note),
  },
  updates: {
    installCapability: () => invoke('updates:install-capability'),
    checkInstallable: () => invoke('updates:check-installable'),
    download: () => invoke('updates:download'),
    quitAndInstall: () => invoke('updates:quit-and-install'),
    onInstallEvent: (callback: (event: UpdateInstallEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: UpdateInstallEvent) => callback(data)
      ipcRenderer.on('updates:install-event', handler)
      return () => ipcRenderer.removeListener('updates:install-event', handler)
    },
  },
  automation: {
    list: () => invoke('automation:list'),
    get: (automationId) => invoke('automation:get', automationId),
    create: (draft) => invoke('automation:create', draft),
    update: (automationId, draft) => invoke('automation:update', automationId, draft),
    pause: (automationId) => invoke('automation:pause', automationId),
    resume: (automationId) => invoke('automation:resume', automationId),
    archive: (automationId) => invoke('automation:archive', automationId),
    runNow: (automationId) => invoke('automation:run-now', automationId),
    retryRun: (runId) => invoke('automation:retry-run', runId),
    cancelRun: (runId) => invoke('automation:cancel-run', runId),
    previewBrief: (automationId) => invoke('automation:preview-brief', automationId),
    approveBrief: (automationId) => invoke('automation:approve-brief', automationId),
    inboxRespond: (itemId, response) => invoke('automation:inbox-respond', itemId, response),
    inboxDismiss: (itemId) => invoke('automation:inbox-dismiss', itemId),
  },
  crews: {
    list: () => invoke('crews:list'),
    get: (crewId) => invoke('crews:get', crewId),
    create: (draft) => invoke('crews:create', draft),
    update: (crewId, draft) => invoke('crews:update', crewId, draft),
    pause: (crewId) => invoke('crews:pause', crewId),
    retire: (crewId) => invoke('crews:retire', crewId),
    run: (draft) => invoke('crews:run', draft),
    runDetail: (runId) => invoke('crews:run-detail', runId),
    evaluate: (runId) => invoke('crews:evaluate', runId),
    exportTrace: (runId) => invoke('crews:export-trace', runId),
  },
  sops: {
    list: () => invoke('sops:list'),
    get: (sopId) => invoke('sops:get', sopId),
    saveFromAutomationRun: (runId) => invoke('sops:save-from-automation-run', runId),
    update: (sopId, draft) => invoke('sops:update', sopId, draft),
    runNow: (sopId, inputs) => invoke('sops:run-now', sopId, inputs),
    runForTrigger: (sopId, triggerType, inputs) => invoke('sops:run-trigger', sopId, triggerType, inputs),
    runDetail: (automationRunId) => invoke('sops:run-detail', automationRunId),
  },
  threads: {
    search: (query) => invoke('threads:search', query),
    facets: (query) => invoke('threads:facets', query),
    tags: {
      list: () => invoke('threads:tags:list'),
      create: (input) => invoke('threads:tags:create', input),
      update: (tagId, input) => invoke('threads:tags:update', tagId, input),
      delete: (tagId) => invoke('threads:tags:delete', tagId),
      apply: (sessionIds, tagIds) => invoke('threads:tags:apply', sessionIds, tagIds),
      remove: (sessionIds, tagIds) => invoke('threads:tags:remove', sessionIds, tagIds),
    },
    smartFilters: {
      list: () => invoke('threads:smart-filters:list'),
      create: (input) => invoke('threads:smart-filters:create', input),
      update: (filterId, input) => invoke('threads:smart-filters:update', filterId, input),
      delete: (filterId) => invoke('threads:smart-filters:delete', filterId),
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
      ipcRenderer.on('session:patch', handler)
      return () => ipcRenderer.removeListener('session:patch', handler)
    },
    notification: (callback: (event: RuntimeNotification) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: RuntimeNotification) => callback(data)
      ipcRenderer.on('runtime:notification', handler)
      return () => ipcRenderer.removeListener('runtime:notification', handler)
    },
    sessionView: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; view: SessionView }) => callback(data)
      ipcRenderer.on('session:view', handler)
      return () => ipcRenderer.removeListener('session:view', handler)
    },
    permissionRequest: (callback: (request: PermissionRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: PermissionRequest) => callback(data)
      ipcRenderer.on('permission:request', handler)
      return () => ipcRenderer.removeListener('permission:request', handler)
    },
    mcpStatus: (callback: (statuses: McpStatus[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: McpStatus[]) => callback(data)
      ipcRenderer.on('mcp:status', handler)
      return () => ipcRenderer.removeListener('mcp:status', handler)
    },
    authExpired: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('auth:expired', handler)
      return () => ipcRenderer.removeListener('auth:expired', handler)
    },
    authLogout: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('auth:logout', handler)
      return () => ipcRenderer.removeListener('auth:logout', handler)
    },
    menuAction: (callback: (action: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action)
      ipcRenderer.on('action', handler)
      return () => ipcRenderer.removeListener('action', handler)
    },
    menuNavigate: (callback: (view: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, view: string) => callback(view)
      ipcRenderer.on('navigate', handler)
      return () => ipcRenderer.removeListener('navigate', handler)
    },
    runtimeReady: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('runtime:ready', handler)
      return () => ipcRenderer.removeListener('runtime:ready', handler)
    },
    dashboardSummaryUpdated: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('dashboard:summary-updated', handler)
      return () => ipcRenderer.removeListener('dashboard:summary-updated', handler)
    },
    sessionUpdated: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data)
      ipcRenderer.on('session:updated', handler)
      return () => ipcRenderer.removeListener('session:updated', handler)
    },
    sessionDeleted: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data)
      ipcRenderer.on('session:deleted', handler)
      return () => ipcRenderer.removeListener('session:deleted', handler)
    },
    automationUpdated: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('automation:updated', handler)
      return () => ipcRenderer.removeListener('automation:updated', handler)
    },
  },
}

// Exposed as a brand-neutral `window.coworkApi`. Downstream forks don't
// need to rename the preload key — they just change `branding.name` in
// config and the UI reflects their label while the internal plumbing
// stays stable.
contextBridge.exposeInMainWorld('coworkApi', api)
