export const LOCAL_WORKSPACE_ID = 'local'

export function normalizeWorkspaceId(workspaceId?: string | null) {
  const trimmed = workspaceId?.trim()
  return trimmed || LOCAL_WORKSPACE_ID
}

export function sessionWorkspaceKey(workspaceId: string | null | undefined, sessionId: string) {
  const normalized = normalizeWorkspaceId(workspaceId)
  if (normalized === LOCAL_WORKSPACE_ID) return sessionId
  return `workspace:${encodeURIComponent(normalized)}:session:${encodeURIComponent(sessionId)}`
}

export function activeSessionWorkspaceKey(state: { activeWorkspaceId?: string | null }, sessionId: string) {
  return sessionWorkspaceKey(state.activeWorkspaceId, sessionId)
}
