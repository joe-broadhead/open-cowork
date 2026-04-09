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
  gcpProjectId: string | null
  gcpRegion: string
  vertexModel: string
}

// Cowork API exposed to renderer via preload
export interface CoworkAPI {
  session: {
    create: () => Promise<SessionInfo>
    prompt: (sessionId: string, text: string) => Promise<void>
    list: () => Promise<SessionInfo[]>
    get: (id: string) => Promise<SessionInfo | null>
    abort: (sessionId: string) => Promise<void>
  }
  permission: {
    respond: (id: string, allowed: boolean) => Promise<void>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (updates: Partial<AppSettings>) => Promise<AppSettings>
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
