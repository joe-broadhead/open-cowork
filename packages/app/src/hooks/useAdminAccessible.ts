import { useEffect, useState } from 'react'
import { canAccessAdminSurface } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'

// Resolves whether the signed-in principal can open the Admin control plane, so the
// sidebar only offers the Admin entry to someone with at least one admin permission.
// Cloud-only and fail-closed: a local/gateway workspace, an unauthenticated session,
// or a missing control plane all resolve to `false`. Recomputed when the active
// workspace changes so switching into a cloud workspace reveals the entry.
export function useAdminAccessible(ready: boolean): boolean {
  const [adminAccessible, setAdminAccessible] = useState(false)
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)

  useEffect(() => {
    if (!ready) {
      setAdminAccessible(false)
      return
    }
    let cancelled = false
    window.coworkApi.admin.access()
      .then((access) => {
        if (!cancelled) setAdminAccessible(canAccessAdminSurface(access))
      })
      .catch(() => {
        if (!cancelled) setAdminAccessible(false)
      })
    return () => {
      cancelled = true
    }
  }, [ready, activeWorkspaceId])

  return adminAccessible
}
