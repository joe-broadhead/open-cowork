import { contextBridge, ipcRenderer } from 'electron'
import type { CoworkAPI, StreamEvent, PermissionRequest, McpStatus } from '@cowork/shared'

const api: CoworkAPI = {
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
  },
  session: {
    create: () => ipcRenderer.invoke('session:create'),
    prompt: (sessionId, text, attachments, agent) => ipcRenderer.invoke('session:prompt', sessionId, text, attachments, agent),
    list: () => ipcRenderer.invoke('session:list'),
    get: (id) => ipcRenderer.invoke('session:get', id),
    abort: (sessionId) => ipcRenderer.invoke('session:abort', sessionId),
    rename: (sessionId, title) => ipcRenderer.invoke('session:rename', sessionId, title),
    delete: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
    export: (sessionId) => ipcRenderer.invoke('session:export', sessionId),
    fork: (sessionId, messageId) => ipcRenderer.invoke('session:fork', sessionId, messageId),
    messages: (sessionId) => ipcRenderer.invoke('session:messages', sessionId),
  },
  permission: {
    respond: (id, allowed) => ipcRenderer.invoke('permission:respond', id, allowed),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (updates) => ipcRenderer.invoke('settings:set', updates),
  },
  mcp: {
    auth: (mcpName) => ipcRenderer.invoke('mcp:auth', mcpName),
  },
  custom: {
    listMcps: () => ipcRenderer.invoke('custom:list-mcps'),
    addMcp: (mcp) => ipcRenderer.invoke('custom:add-mcp', mcp),
    removeMcp: (name) => ipcRenderer.invoke('custom:remove-mcp', name),
    listSkills: () => ipcRenderer.invoke('custom:list-skills'),
    addSkill: (skill) => ipcRenderer.invoke('custom:add-skill', skill),
    removeSkill: (name) => ipcRenderer.invoke('custom:remove-skill', name),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    install: (id) => ipcRenderer.invoke('plugins:install', id),
    uninstall: (id) => ipcRenderer.invoke('plugins:uninstall', id),
    skillContent: (name) => ipcRenderer.invoke('plugins:skill-content', name),
    mcpTools: () => ipcRenderer.invoke('plugins:mcp-tools'),
    runtimeSkills: () => ipcRenderer.invoke('plugins:runtime-skills'),
  },
  on: {
    streamEvent: (callback: (event: StreamEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: StreamEvent) => callback(data)
      ipcRenderer.on('stream:event', handler)
      return () => ipcRenderer.removeListener('stream:event', handler)
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
  },
}

contextBridge.exposeInMainWorld('cowork', api)
