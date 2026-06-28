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

export function parseSessionWorkspaceKey(key: string) {
  const match = key.match(/^workspace:([^:]+):session:(.+)$/)
  if (!match) return { workspaceId: LOCAL_WORKSPACE_ID, sessionId: key }
  try {
    return {
      workspaceId: normalizeWorkspaceId(decodeURIComponent(match[1] || '')),
      sessionId: decodeURIComponent(match[2] || ''),
    }
  } catch {
    return { workspaceId: LOCAL_WORKSPACE_ID, sessionId: key }
  }
}
