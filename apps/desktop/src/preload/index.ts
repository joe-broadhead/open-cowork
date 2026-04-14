import { contextBridge, ipcRenderer } from 'electron'
import type { OpenCoworkAPI, SessionPatch, PermissionRequest, McpStatus, RuntimeNotification } from '@open-cowork/shared'

const api: OpenCoworkAPI = {
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
  },
  session: {
    create: (directory?) => ipcRenderer.invoke('session:create', directory),
    activate: (sessionId, options) => ipcRenderer.invoke('session:activate', sessionId, options),
    prompt: (sessionId, text, attachments, agent) => ipcRenderer.invoke('session:prompt', sessionId, text, attachments, agent),
    list: () => ipcRenderer.invoke('session:list'),
    get: (id) => ipcRenderer.invoke('session:get', id),
    abort: (sessionId) => ipcRenderer.invoke('session:abort', sessionId),
    rename: (sessionId, title) => ipcRenderer.invoke('session:rename', sessionId, title),
    delete: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
    export: (sessionId) => ipcRenderer.invoke('session:export', sessionId),
    fork: (sessionId, messageId) => ipcRenderer.invoke('session:fork', sessionId, messageId),
    share: (sessionId) => ipcRenderer.invoke('session:share', sessionId),
    unshare: (sessionId) => ipcRenderer.invoke('session:unshare', sessionId),
    summarize: (sessionId) => ipcRenderer.invoke('session:summarize', sessionId),
    revert: (sessionId) => ipcRenderer.invoke('session:revert', sessionId),
    unrevert: (sessionId) => ipcRenderer.invoke('session:unrevert', sessionId),
    children: (sessionId) => ipcRenderer.invoke('session:children', sessionId),
    diff: (sessionId) => ipcRenderer.invoke('session:diff', sessionId),
    todo: (sessionId) => ipcRenderer.invoke('session:todo', sessionId),
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
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
  },
  diagnostics: {
    perf: () => ipcRenderer.invoke('diagnostics:perf'),
  },
  app: {
    config: () => ipcRenderer.invoke('app:config'),
    builtinAgents: () => ipcRenderer.invoke('app:builtin-agents'),
  },
  agents: {
    catalog: () => ipcRenderer.invoke('agents:catalog'),
    list: () => ipcRenderer.invoke('agents:list'),
    create: (agent) => ipcRenderer.invoke('agents:create', agent),
    update: (previousName, agent) => ipcRenderer.invoke('agents:update', previousName, agent),
    remove: (name) => ipcRenderer.invoke('agents:remove', name),
  },
  custom: {
    listMcps: () => ipcRenderer.invoke('custom:list-mcps'),
    addMcp: (mcp) => ipcRenderer.invoke('custom:add-mcp', mcp),
    removeMcp: (name) => ipcRenderer.invoke('custom:remove-mcp', name),
    listSkills: () => ipcRenderer.invoke('custom:list-skills'),
    addSkill: (skill) => ipcRenderer.invoke('custom:add-skill', skill),
    removeSkill: (name) => ipcRenderer.invoke('custom:remove-skill', name),
  },
  capabilities: {
    tools: (options) => ipcRenderer.invoke('capabilities:tools', options),
    tool: (id, options) => ipcRenderer.invoke('capabilities:tool', id, options),
    skills: () => ipcRenderer.invoke('capabilities:skills'),
    skillBundle: (name) => ipcRenderer.invoke('capabilities:skill-bundle', name),
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
    sessionUpdated: (callback: (data: { id: string; title: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { id: string; title: string }) => callback(data)
      ipcRenderer.on('session:updated', handler)
      return () => ipcRenderer.removeListener('session:updated', handler)
    },
  },
}

contextBridge.exposeInMainWorld('openCowork', api)
