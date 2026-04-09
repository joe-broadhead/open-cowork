// IPC channel names
export const IPC = {
  SESSION_CREATE: 'session:create',
  SESSION_PROMPT: 'session:prompt',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_ABORT: 'session:abort',
  PERMISSION_RESPOND: 'permission:respond',
  // Events from main → renderer
  STREAM_EVENT: 'stream:event',
  PERMISSION_REQUEST: 'permission:request',
  MCP_STATUS: 'mcp:status',
} as const

// Types for IPC communication
export interface SessionInfo {
  id: string
  title?: string
  createdAt: string
  updatedAt: string
}

export interface StreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'done'
  sessionId: string
  data: unknown
}

export interface TextEvent {
  type: 'text'
  content: string
}

export interface ToolCallEvent {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultEvent {
  type: 'tool_result'
  id: string
  name: string
  output: unknown
  isError: boolean
}

export interface PermissionRequest {
  id: string
  tool: string
  input: Record<string, unknown>
  description: string
}

export interface McpStatus {
  name: string
  connected: boolean
}

export interface AppSettings {
  provider: 'vertex' | 'databricks'
  defaultModel: string
  gcpProjectId: string | null
  gcpRegion: string
  databricksHost: string | null
  databricksToken: string | null
}

export interface AuthState {
  authenticated: boolean
  email: string | null
}

export { BUILTIN_PLUGINS } from './plugins'
export type { Plugin, PluginSkill, PluginApp } from './plugins'

// Cowork API exposed to renderer via preload
export interface CoworkAPI {
  auth: {
    status: () => Promise<AuthState>
    login: () => Promise<AuthState>
  }
  session: {
    create: () => Promise<SessionInfo>
    prompt: (sessionId: string, text: string) => Promise<void>
    list: () => Promise<SessionInfo[]>
    get: (id: string) => Promise<SessionInfo | null>
    abort: (sessionId: string) => Promise<void>
    messages: (sessionId: string) => Promise<Array<{ id: string; role: string; content: string; timestamp: string }>>
  }
  permission: {
    respond: (id: string, allowed: boolean) => Promise<void>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (updates: Partial<AppSettings>) => Promise<AppSettings>
  }
  mcp: {
    auth: (mcpName: string) => Promise<boolean>
  }
  plugins: {
    list: () => Promise<import('./plugins').Plugin[]>
    install: (id: string) => Promise<boolean>
    uninstall: (id: string) => Promise<boolean>
    skillContent: (skillName: string) => Promise<string | null>
    mcpTools: () => Promise<Array<{ id: string; mcp: string; tool: string }>>
  }
  on: {
    streamEvent: (callback: (event: StreamEvent) => void) => () => void
    permissionRequest: (callback: (request: PermissionRequest) => void) => () => void
    mcpStatus: (callback: (statuses: McpStatus[]) => void) => () => void
  }
}

declare global {
  interface Window {
    cowork: CoworkAPI
  }
}
