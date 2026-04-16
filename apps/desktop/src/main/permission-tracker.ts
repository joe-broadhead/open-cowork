// UI routing map. Records which Cowork session should surface a given
// pending permission dialog. NOT a mirror of client.permission.list()
// (which stays the source of truth); this exists so that when a
// permission.asked event arrives we can route the renderer prompt to the
// correct thread without a second SDK round-trip.
//
// Permission prompts are intentionally ephemeral — they should disappear on
// restart rather than surviving as stale grants across app launches.
const permissionSessionMap = new Map<string, string>()

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
