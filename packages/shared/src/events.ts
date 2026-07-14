export interface PermissionRequest {
  id: string
  sessionId: string
  sourceSessionId?: string | null
  workspaceId?: string | null
  taskRunId?: string | null
  tool: string
  input: Record<string, unknown>
  description: string
}

export interface McpStatus {
  name: string
  connected: boolean
  rawStatus?: string
  error?: string
}

const MCP_AUTH_REQUIRED_STATUSES = [
  'needs_auth',
  'needs_client_registration',
  'auth_required',
] as const

export function isMcpAuthRequiredStatus(status?: string | null) {
  return typeof status === 'string'
    && (MCP_AUTH_REQUIRED_STATUSES as readonly string[]).includes(status)
}
