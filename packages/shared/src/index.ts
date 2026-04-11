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
  directory?: string | null
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
  sessionId: string
  tool: string
  input: Record<string, unknown>
  description: string
}

export interface McpStatus {
  name: string
  connected: boolean
}

export interface CustomMcpConfig {
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface CustomSkillConfig {
  name: string
  content: string
}

export interface AppSettings {
  provider: 'vertex' | 'databricks'
  defaultModel: string
  gcpProjectId: string | null
  gcpRegion: string
  databricksHost: string | null
  databricksToken: string | null
  customMcps: CustomMcpConfig[]
  customSkills: CustomSkillConfig[]
  enableBash: boolean
  enableFileWrite: boolean
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
    create: (directory?: string) => Promise<SessionInfo>
    prompt: (sessionId: string, text: string, attachments?: Array<{ mime: string; url: string; filename?: string }>, agent?: string) => Promise<void>
    list: () => Promise<SessionInfo[]>
    get: (id: string) => Promise<SessionInfo | null>
    abort: (sessionId: string) => Promise<void>
    rename: (sessionId: string, title: string) => Promise<boolean>
    delete: (sessionId: string) => Promise<boolean>
    export: (sessionId: string) => Promise<string | null>
    fork: (sessionId: string, messageId?: string) => Promise<SessionInfo | null>
    messages: (sessionId: string) => Promise<Array<{ type?: string; id: string; role?: string; content?: string; timestamp: string; tool?: any; cost?: any }>>
    share: (sessionId: string) => Promise<string | null>
    unshare: (sessionId: string) => Promise<boolean>
    summarize: (sessionId: string) => Promise<string | null>
    revert: (sessionId: string) => Promise<boolean>
    unrevert: (sessionId: string) => Promise<boolean>
    children: (sessionId: string) => Promise<any[]>
    diff: (sessionId: string) => Promise<Array<{ file: string; before: string; after: string; additions: number; deletions: number }>>
    todo: (sessionId: string) => Promise<any[]>
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
    connect: (name: string) => Promise<void>
    disconnect: (name: string) => Promise<void>
  }
  dialog: {
    selectDirectory: () => Promise<string | null>
  }
  model: {
    info: () => Promise<any>
  }
  tools: {
    list: () => Promise<any[]>
  }
  command: {
    list: () => Promise<Array<{ name: string; description?: string; source?: string }>>
    run: (sessionId: string, name: string) => Promise<boolean>
  }
  provider: {
    list: () => Promise<any[]>
  }
  plugins: {
    list: () => Promise<import('./plugins').Plugin[]>
    install: (id: string) => Promise<boolean>
    uninstall: (id: string) => Promise<boolean>
    skillContent: (skillName: string) => Promise<string | null>
    mcpTools: () => Promise<Array<{ id: string; mcp: string; tool: string }>>
    runtimeSkills: () => Promise<Array<{ name: string; description: string }>>
  }
  custom: {
    listMcps: () => Promise<CustomMcpConfig[]>
    addMcp: (mcp: CustomMcpConfig) => Promise<boolean>
    removeMcp: (name: string) => Promise<boolean>
    listSkills: () => Promise<CustomSkillConfig[]>
    addSkill: (skill: CustomSkillConfig) => Promise<boolean>
    removeSkill: (name: string) => Promise<boolean>
  }
  on: {
    streamEvent: (callback: (event: StreamEvent) => void) => () => void
    permissionRequest: (callback: (request: PermissionRequest) => void) => () => void
    mcpStatus: (callback: (statuses: McpStatus[]) => void) => () => void
    authExpired: (callback: () => void) => () => void
    menuAction: (callback: (action: string) => void) => () => void
    menuNavigate: (callback: (view: string) => void) => () => void
    runtimeReady: (callback: () => void) => () => void
    sessionUpdated: (callback: (data: { id: string; title: string }) => void) => () => void
  }
}

declare global {
  interface Window {
    cowork: CoworkAPI
  }
}
