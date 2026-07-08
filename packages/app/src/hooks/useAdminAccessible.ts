import { useEffect, useState } from 'react'
import { canAccessAdminSurface } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'

export type AdminAccessState = {
  accessible: boolean
  checked: boolean
}

// Resolves whether the signed-in principal can open the Admin control plane, so the
// sidebar only offers the Admin entry to someone with at least one admin permission.
// Cloud-only and fail-closed: a local/gateway workspace, an unauthenticated session,
// or a missing control plane all resolve to `false`. Recomputed when the active
// workspace changes so switching into a cloud workspace reveals the entry.
export function useAdminAccessState(ready: boolean): AdminAccessState {
  const [adminAccess, setAdminAccess] = useState<AdminAccessState>({ accessible: false, checked: false })
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)

  useEffect(() => {
    if (!ready) {
      setAdminAccess({ accessible: false, checked: false })
      return
    }
    setAdminAccess({ accessible: false, checked: false })
    let cancelled = false
    window.coworkApi.admin.access()
      .then((access) => {
        if (!cancelled) setAdminAccess({ accessible: canAccessAdminSurface(access), checked: true })
      })
      .catch(() => {
        if (!cancelled) setAdminAccess({ accessible: false, checked: true })
      })
    return () => {
      cancelled = true
    }
  }, [ready, activeWorkspaceId])

  return adminAccess
}

export function useAdminAccessible(ready: boolean): boolean {
  return useAdminAccessState(ready).accessible
}
