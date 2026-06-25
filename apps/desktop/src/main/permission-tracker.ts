// UI routing map. Records which Cowork session should surface a given
// pending permission dialog. NOT a mirror of client.permission.list()
// (which stays the source of truth); this exists so that when a
// permission.asked event arrives we can route the renderer prompt to the
// correct thread without a second SDK round-trip.
//
// Permission prompts are intentionally ephemeral — they should disappear on
// restart rather than surviving as stale grants across app launches.
const permissionSessionMap = new Map<string, string>()

// Bounds the routing map (audit P3-13). Auto-resolved/superseded permissions whose ids are never
// explicitly cleared would otherwise accumulate for the process lifetime; far above any plausible
// count of concurrently-pending prompts, so eviction only ever drops genuinely-stale entries.
const MAX_TRACKED_PERMISSIONS = 1000

export function trackPermission(permissionId: string, sessionId: string) {
  // Re-insert as newest so eviction targets the oldest leaked entries first.
  permissionSessionMap.delete(permissionId)
  permissionSessionMap.set(permissionId, sessionId)
  while (permissionSessionMap.size > MAX_TRACKED_PERMISSIONS) {
    const oldest = permissionSessionMap.keys().next().value
    if (typeof oldest !== 'string') break
    permissionSessionMap.delete(oldest)
  }
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
