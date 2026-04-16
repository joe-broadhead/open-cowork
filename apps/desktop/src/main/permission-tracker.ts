const permissionSessionMap = new Map<string, string>()

// Permission prompts are intentionally ephemeral. They should disappear on restart
// rather than surviving as stale grants across app launches.

export function trackPermission(permissionId: string, sessionId: string) {
  permissionSessionMap.set(permissionId, sessionId)
}

export function getPermissionSession(permissionId: string) {
  return permissionSessionMap.get(permissionId) || null
}

export function clearPermission(permissionId: string) {
  permissionSessionMap.delete(permissionId)
}

export function clearPermissionsForSession(sessionId: string) {
  for (const [permissionId, mappedSessionId] of permissionSessionMap.entries()) {
    if (mappedSessionId === sessionId) {
      permissionSessionMap.delete(permissionId)
    }
  }
}
