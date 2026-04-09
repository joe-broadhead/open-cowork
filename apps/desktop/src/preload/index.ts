import { contextBridge, ipcRenderer } from 'electron'
import type { CoworkAPI, StreamEvent, PermissionRequest, McpStatus } from '@cowork/shared'

const api: CoworkAPI = {
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
  },
  session: {
    create: () => ipcRenderer.invoke('session:create'),
    prompt: (sessionId, text) => ipcRenderer.invoke('session:prompt', sessionId, text),
    list: () => ipcRenderer.invoke('session:list'),
    get: (id) => ipcRenderer.invoke('session:get', id),
    abort: (sessionId) => ipcRenderer.invoke('session:abort', sessionId),
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
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    install: (id) => ipcRenderer.invoke('plugins:install', id),
    uninstall: (id) => ipcRenderer.invoke('plugins:uninstall', id),
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
  },
}

contextBridge.exposeInMainWorld('cowork', api)
