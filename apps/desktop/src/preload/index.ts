import { contextBridge, ipcRenderer } from 'electron'
import type { CoworkAPI, SessionPatch, PermissionRequest, McpStatus, RuntimeNotification } from '@open-cowork/shared'

const api: CoworkAPI = {
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  session: {
    create: (directory?) => ipcRenderer.invoke('session:create', directory),
    activate: (sessionId, options) => ipcRenderer.invoke('session:activate', sessionId, options),
    prompt: (sessionId, text, attachments, agent) => ipcRenderer.invoke('session:prompt', sessionId, text, attachments, agent),
    list: () => ipcRenderer.invoke('session:list'),
    get: (id) => ipcRenderer.invoke('session:get', id),
    abort: (sessionId) => ipcRenderer.invoke('session:abort', sessionId),
    abortTask: (rootSessionId, childSessionId) => ipcRenderer.invoke('session:abort-task', rootSessionId, childSessionId),
    rename: (sessionId, title) => ipcRenderer.invoke('session:rename', sessionId, title),
    delete: (sessionId, confirmationToken) => ipcRenderer.invoke('session:delete', sessionId, confirmationToken),
    export: (sessionId) => ipcRenderer.invoke('session:export', sessionId),
    fork: (sessionId, messageId) => ipcRenderer.invoke('session:fork', sessionId, messageId),
    share: (sessionId) => ipcRenderer.invoke('session:share', sessionId),
    unshare: (sessionId) => ipcRenderer.invoke('session:unshare', sessionId),
    summarize: (sessionId) => ipcRenderer.invoke('session:summarize', sessionId),
    revert: (sessionId, messageId) => ipcRenderer.invoke('session:revert', sessionId, messageId),
    unrevert: (sessionId) => ipcRenderer.invoke('session:unrevert', sessionId),
    children: (sessionId) => ipcRenderer.invoke('session:children', sessionId),
    diff: (sessionId, messageId) => ipcRenderer.invoke('session:diff', sessionId, messageId),
    fileSnippet: (request) => ipcRenderer.invoke('session:file-snippet', request),
    todo: (sessionId) => ipcRenderer.invoke('session:todo', sessionId),
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
    selectImage: () => ipcRenderer.invoke('dialog:select-image'),
    openJson: () => ipcRenderer.invoke('dialog:open-json'),
    saveText: (defaultFilename, content) => ipcRenderer.invoke('dialog:save-text', defaultFilename, content),
  },
  chart: {
    renderSvg: (spec) => ipcRenderer.invoke('chart:render-svg', spec),
    saveArtifact: (request) => ipcRenderer.invoke('chart:save-artifact', request),
  },
  artifact: {
    export: (request) => ipcRenderer.invoke('artifact:export', request),
    reveal: (request) => ipcRenderer.invoke('artifact:reveal', request),
    storageStats: () => ipcRenderer.invoke('artifact:storage-stats'),
    cleanup: (mode) => ipcRenderer.invoke('artifact:cleanup', mode),
  },
  confirm: {
    requestDestructive: (request) => ipcRenderer.invoke('confirm:request-destructive', request),
  },
  tools: {
    list: (options) => ipcRenderer.invoke('tool:list', options),
  },
  command: {
    list: () => ipcRenderer.invoke('command:list'),
    run: (sessionId, name) => ipcRenderer.invoke('command:run', sessionId, name),
  },
  permission: {
    respond: (id, allowed) => ipcRenderer.invoke('permission:respond', id, allowed),
  },
  question: {
    reply: (sessionId, requestId, answers) => ipcRenderer.invoke('question:reply', sessionId, requestId, answers),
    reject: (sessionId, requestId) => ipcRenderer.invoke('question:reject', sessionId, requestId),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    getWithCredentials: () => ipcRenderer.invoke('settings:get-with-credentials'),
    set: (updates) => ipcRenderer.invoke('settings:set', updates),
  },
  mcp: {
    auth: (mcpName) => ipcRenderer.invoke('mcp:auth', mcpName),
    connect: (name) => ipcRenderer.invoke('mcp:connect', name),
    disconnect: (name) => ipcRenderer.invoke('mcp:disconnect', name),
  },
  model: {
    info: () => ipcRenderer.invoke('model:info'),
  },
  provider: {
    list: () => ipcRenderer.invoke('provider:list'),
  },
  runtime: {
    status: () => ipcRenderer.invoke('runtime:status'),
    restart: () => ipcRenderer.invoke('runtime:restart'),
  },
  diagnostics: {
    perf: () => ipcRenderer.invoke('diagnostics:perf'),
    reportRendererError: (payload) => ipcRenderer.send('diagnostics:renderer-error', payload),
  },
  app: {
    config: () => ipcRenderer.invoke('app:config'),
    builtinAgents: () => ipcRenderer.invoke('app:builtin-agents'),
    dashboardSummary: (range) => ipcRenderer.invoke('app:dashboard-summary', range),
    runtimeInputs: () => ipcRenderer.invoke('app:runtime-inputs'),
    refreshProviderCatalog: (providerId) => ipcRenderer.invoke('app:refresh-provider-catalog', providerId),
    exportDiagnostics: () => ipcRenderer.invoke('app:export-diagnostics'),
    checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
    reset: (confirmationToken) => ipcRenderer.invoke('app:reset', confirmationToken),
  },
  agents: {
    catalog: (options) => ipcRenderer.invoke('agents:catalog', options),
    list: (options) => ipcRenderer.invoke('agents:list', options),
    runtime: () => ipcRenderer.invoke('agents:runtime'),
    create: (agent) => ipcRenderer.invoke('agents:create', agent),
    update: (target, agent) => ipcRenderer.invoke('agents:update', target, agent),
    remove: (target, confirmationToken) => ipcRenderer.invoke('agents:remove', target, confirmationToken),
  },
  explorer: {
    fileList: (path, directory) => ipcRenderer.invoke('explorer:file-list', path, directory ?? null),
    fileRead: (path, directory) => ipcRenderer.invoke('explorer:file-read', path, directory ?? null),
    fileStatus: (directory) => ipcRenderer.invoke('explorer:file-status', directory ?? null),
    findFiles: (options, directory) => ipcRenderer.invoke('explorer:find-files', options, directory ?? null),
    findSymbols: (query, directory) => ipcRenderer.invoke('explorer:find-symbols', query, directory ?? null),
    findText: (pattern, directory) => ipcRenderer.invoke('explorer:find-text', pattern, directory ?? null),
  },
  custom: {
    listMcps: (options) => ipcRenderer.invoke('custom:list-mcps', options),
    addMcp: (mcp) => ipcRenderer.invoke('custom:add-mcp', mcp),
    removeMcp: (target, confirmationToken) => ipcRenderer.invoke('custom:remove-mcp', target, confirmationToken),
    testMcp: (mcp) => ipcRenderer.invoke('custom:test-mcp', mcp),
    listSkills: (options) => ipcRenderer.invoke('custom:list-skills', options),
    addSkill: (skill) => ipcRenderer.invoke('custom:add-skill', skill),
    selectSkillDirectoryImport: () => ipcRenderer.invoke('custom:select-skill-directory'),
    importSkillDirectory: (selectionToken, target) => ipcRenderer.invoke('custom:import-skill-directory', selectionToken, target),
    removeSkill: (target, confirmationToken) => ipcRenderer.invoke('custom:remove-skill', target, confirmationToken),
  },
  capabilities: {
    tools: (options) => ipcRenderer.invoke('capabilities:tools', options),
    tool: (id, options) => ipcRenderer.invoke('capabilities:tool', id, options),
    skills: (options) => ipcRenderer.invoke('capabilities:skills', options),
    skillBundle: (name, options) => ipcRenderer.invoke('capabilities:skill-bundle', name, options),
    skillBundleFile: (name, path, options) => ipcRenderer.invoke('capabilities:skill-bundle-file', name, path, options),
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
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; view: any }) => callback(data)
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
  },
}

// Exposed as a brand-neutral `window.coworkApi`. Downstream forks don't
// need to rename the preload key — they just change `branding.name` in
// config and the UI reflects their label while the internal plumbing
// stays stable.
contextBridge.exposeInMainWorld('coworkApi', api)
