import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { WorkspaceApiSupport, WorkspaceInfo } from '@open-cowork/shared'
import { Button, Input, type BadgeTone } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import { useSessionStore } from '../../stores/session'
import { supportAllows, supportEntry, useWorkspaceSupportStore } from '../../stores/workspace-support'
import { useEscape } from '../../hooks/useEscape'
import { ModalBackdrop } from './ModalBackdrop'

export const LOCAL_WORKSPACE_FALLBACK: WorkspaceInfo = {
  id: 'local',
  kind: 'local',
  authority: 'desktop_local',
  label: 'Local',
  status: 'online',
  active: true,
  lastSyncedAt: null,
}

function workspaceStatusLabel(status: WorkspaceInfo['status']) {
  switch (status) {
    case 'online':
      return t('workspace.status.online', 'Online')
    case 'offline':
      return t('workspace.status.offline', 'Offline cached')
    case 'auth_required':
      return t('workspace.status.authRequired', 'Auth required')
    case 'disabled':
      return t('workspace.status.disabled', 'Policy disabled')
    case 'error':
      return t('workspace.status.error', 'Error')
    default:
      return status
  }
}

function workspaceStatusTone(status: WorkspaceInfo['status']): BadgeTone {
  if (status === 'online') return 'success'
  if (status === 'offline') return 'warning'
  if (status === 'auth_required') return 'info'
  return 'danger'
}

function WorkspaceStatusDot({ status }: { status: WorkspaceInfo['status'] }) {
  const tone = workspaceStatusTone(status)
  const dot = tone === 'success'
    ? 'status-dot--ok'
    : tone === 'warning'
      ? 'status-dot--warn'
      : tone === 'info'
        ? 'status-dot--info'
        : 'status-dot--error'
  return (
    <span className="inline-flex items-center gap-1.5 max-w-[110px] shrink-0">
      <span className={`status-dot ${dot}`} aria-hidden />
      <span className="truncate text-2xs text-text-muted">{workspaceStatusLabel(status)}</span>
    </span>
  )
}

function workspaceSupportReason(support: WorkspaceApiSupport[] | undefined, ...apis: string[]) {
  for (const api of apis) {
    const reason = support?.find((entry) => entry.api === api)?.verdict?.reason
    if (reason) return reason
  }
  return null
}

function workspaceDescription(workspace: WorkspaceInfo, support: WorkspaceApiSupport[] | undefined) {
  if (workspace.authority === 'desktop_local' || workspace.kind === 'local') {
    return t('workspace.local', 'Local workspace - private on this device')
  }
  if (workspace.authority === 'gateway_standalone') {
    // JOE-1044: Desktop may register Standalone Gateway for health/connection only
    // until a Desktop-safe session API exists. Never imply full chat readiness.
    const deferredReason = workspaceSupportReason(support, 'sessions.list', 'sessions.create', 'sessions.prompt')
    const listEntry = support?.find((item) => item.api === 'sessions.list')
    if (listEntry?.status === 'deferred' || listEntry?.status === 'not_supported') {
      return deferredReason
        ? t('workspace.gatewayStandalonePreview', 'Standalone Gateway — connection only') + ` · ${deferredReason}`
        : t('workspace.gatewayStandalonePreviewDefault', 'Standalone Gateway — connection/health only; chat sessions deferred')
    }
    return t('workspace.gatewayStandalone', 'Standalone Gateway - private Gateway execution')
  }
  if (workspace.authority === 'desktop_paired') {
    const listEntry = support?.find((item) => item.api === 'sessions.list')
    if (listEntry?.status === 'deferred' || listEntry?.status === 'not_supported') {
      return t('workspace.desktopPairedPreview', 'Paired Desktop connector — remote session ops deferred until complete')
    }
    return t('workspace.desktopPaired', 'Paired Desktop - remote access to an opted-in local workspace')
  }
  if (workspace.authority === 'cloud_channel_gateway') {
    return t('workspace.cloudChannelGateway', 'Cloud Channel Gateway - channel access to Cloud execution')
  }
  if (workspace.status === 'offline') {
    return t('workspace.offlineCached', 'Offline cached - cloud sends are disabled')
  }
  if (workspace.status === 'auth_required') {
    return t('workspace.authRequiredDescription', 'Auth required - sign in to sync this workspace')
  }
  if (workspace.status === 'disabled') {
    const reason = workspaceSupportReason(support, 'sessions.prompt', 'sessions.create') || workspace.error
    return reason
      ? `${t('workspace.policyDisabled', 'Policy disabled')} - ${reason}`
      : t('workspace.policyDisabledDescription', 'Policy disabled - this workspace cannot run cloud actions')
  }
  if (workspace.status === 'error') {
    return workspace.error || t('workspace.errorDescription', 'Cloud workspace error')
  }
  const cloudTarget = workspace.profileName || workspace.baseUrl || t('workspace.cloud', 'Cloud workspace')
  return `${cloudTarget} - ${t('workspace.cloudSynced', 'syncs with web and gateway')}`
}

export function WorkspaceSwitcher() {
  const setSessions = useSessionStore((state) => state.setSessions)
  const setCurrentSession = useSessionStore((state) => state.setCurrentSession)
  const setActiveWorkspace = useSessionStore((state) => state.setActiveWorkspace)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)
  const supportByWorkspace = useWorkspaceSupportStore((state) => state.supportByWorkspace)
  const loadWorkspaceSupport = useWorkspaceSupportStore((state) => state.loadWorkspaceSupport)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([LOCAL_WORKSPACE_FALLBACK])
  const [open, setOpen] = useState(false)
  const [showGatewayForm, setShowGatewayForm] = useState(false)
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [gatewayToken, setGatewayToken] = useState('')
  const [gatewayLabel, setGatewayLabel] = useState('')
  const activationGenerationRef = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const activeWorkspace = workspaces.find((workspace) => workspace.active) || workspaces[0] || LOCAL_WORKSPACE_FALLBACK

  const refreshSupport = useCallback(async (listedWorkspaces: WorkspaceInfo[], cancelled: () => boolean) => {
    const entries = await Promise.all(listedWorkspaces.map(async (workspace) => ({
      workspace,
      support: await loadWorkspaceSupport(workspace.id, { force: true }).catch(() => []),
    })))
    if (cancelled()) return
    return entries
  }, [loadWorkspaceSupport])

  const workspaceCanListSessions = useCallback((workspace: WorkspaceInfo, support: WorkspaceApiSupport[] | undefined) => {
    if (workspace.kind === 'local') return true
    if (!support) return false
    const entry = supportEntry(support, 'sessions.list')
    return Boolean(entry) && supportAllows(entry)
  }, [])

  const loadSessionsForWorkspace = useCallback(async (workspace: WorkspaceInfo, support?: WorkspaceApiSupport[]) => {
    if (!workspaceCanListSessions(workspace, support)) return []
    return window.coworkApi.session.list({ workspaceId: workspace.id })
  }, [workspaceCanListSessions])

  useEffect(() => {
    let cancelled = false
    const workspaceApi = window.coworkApi?.workspace
    if (!workspaceApi) return
    workspaceApi.list()
      .then(async (next) => {
        if (cancelled) return
        const listedWorkspaces = next.length > 0 ? next : [LOCAL_WORKSPACE_FALLBACK]
        setWorkspaces(listedWorkspaces)
        const supportEntries = await refreshSupport(listedWorkspaces, () => cancelled)
        if (cancelled) return
        const active = listedWorkspaces.find((workspace) => workspace.active) || listedWorkspaces[0] || LOCAL_WORKSPACE_FALLBACK
        setActiveWorkspace(active.id)
        const activeSupport = supportEntries?.find((entry) => entry.workspace.id === active.id)?.support
        const sessions = await loadSessionsForWorkspace(active, activeSupport)
        if (!cancelled) setSessions(sessions)
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([LOCAL_WORKSPACE_FALLBACK])
      })
    return () => {
      cancelled = true
    }
  }, [loadSessionsForWorkspace, refreshSupport, setActiveWorkspace, setSessions])

  const activateWorkspace = async (workspace: WorkspaceInfo) => {
    const generation = activationGenerationRef.current + 1
    activationGenerationRef.current = generation
    const isCurrentActivation = () => activationGenerationRef.current === generation
    const previousId = activeWorkspace.id
    setOpen(false)
    try {
      if (workspace.kind === 'cloud' && workspace.status === 'auth_required') {
        await window.coworkApi.workspace.login(workspace.id)
        if (!isCurrentActivation()) return
      }
      let activated = await window.coworkApi.workspace.activate(workspace.id)
      if (!isCurrentActivation()) return
      if (activated.kind === 'cloud' && activated.status === 'auth_required') {
        await window.coworkApi.workspace.login(activated.id)
        if (!isCurrentActivation()) return
        activated = await window.coworkApi.workspace.activate(activated.id)
        if (!isCurrentActivation()) return
      }
      const nextWorkspaces = await window.coworkApi.workspace.list()
      if (!isCurrentActivation()) return
      setWorkspaces(nextWorkspaces.length > 0 ? nextWorkspaces : [activated])
      const supportEntries = await refreshSupport(nextWorkspaces.length > 0 ? nextWorkspaces : [activated], () => !isCurrentActivation())
      if (!isCurrentActivation()) return
      const activeSupport = supportEntries?.find((entry) => entry.workspace.id === activated.id)?.support
      if (activated.id !== previousId) {
        setActiveWorkspace(activated.id)
        setCurrentSession(null)
      }
      const sessions = await loadSessionsForWorkspace(activated, activeSupport)
      if (isCurrentActivation()) setSessions(sessions)
    } catch (error) {
      if (!isCurrentActivation()) return
      const message = error instanceof Error ? error.message : String(error)
      try {
        const restored = await window.coworkApi.workspace.activate(previousId)
        if (!isCurrentActivation()) return
        const restoredWorkspaces = await window.coworkApi.workspace.list()
        if (!isCurrentActivation()) return
        setWorkspaces(restoredWorkspaces.length > 0 ? restoredWorkspaces : [restored])
        const supportEntries = await refreshSupport(restoredWorkspaces.length > 0 ? restoredWorkspaces : [restored], () => !isCurrentActivation())
        if (!isCurrentActivation()) return
        const restoredSupport = supportEntries?.find((entry) => entry.workspace.id === restored.id)?.support
        setActiveWorkspace(restored.id)
        const sessions = await loadSessionsForWorkspace(restored, restoredSupport)
        if (isCurrentActivation()) setSessions(sessions)
      } catch {
        // Leave the visible workspace unchanged if rollback also fails; the
        // original login error is still the actionable user-facing failure.
      }
      addGlobalError(message || t('workspace.switchFailed', 'Could not switch workspace.'))
    }
  }

  const addGatewayWorkspace = async () => {
    const baseUrl = gatewayUrl.trim()
    if (!baseUrl) return
    try {
      const workspace = await window.coworkApi.workspace.addGateway({
        baseUrl,
        label: gatewayLabel.trim() || undefined,
        token: gatewayToken.trim() || undefined,
      })
      setGatewayUrl('')
      setGatewayToken('')
      setGatewayLabel('')
      setShowGatewayForm(false)
      const nextWorkspaces = await window.coworkApi.workspace.list()
      setWorkspaces(nextWorkspaces.length > 0 ? nextWorkspaces : [workspace])
      void refreshSupport(nextWorkspaces.length > 0 ? nextWorkspaces : [workspace], () => false)
    } catch (error) {
      addGlobalError(error instanceof Error ? error.message : String(error))
    }
  }

  // Close the switcher and return focus to its trigger so keyboard users
  // don't lose their place. Mirrors the ThreadList action menu's
  // close-then-restore-focus behaviour.
  const closeMenu = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  // Escape closes the switcher and restores trigger focus through the shared
  // stacked Escape helper. Registered only while open so it never consumes
  // Escape when the popover is closed, and the helper stops propagation
  // centrally so the app-level navigation Escape never also fires.
  useEscape(closeMenu, { enabled: open })

  // On open, land focus on the active workspace option (or the first one)
  // so arrow keys have a starting point — same roving pattern the thread
  // action menu uses.
  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    if (!menu) return
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    const active = options.find((option) => option.dataset.workspaceActive === 'true')
    ;(active || options[0])?.focus()
  }, [open])

  // Roving focus between workspace options. Up/Down move focus, Enter
  // selects (native button activation), and Home/End jump to the ends.
  // Escape is handled by the shared stacked Escape helper above, which
  // closes the switcher and contains the event so the app-level Escape
  // handler never also fires.
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }

    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    if (options.length === 0) return
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement)

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const offset = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = currentIndex >= 0
        ? (currentIndex + offset + options.length) % options.length
        : 0
      options[nextIndex]?.focus()
      return
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      options[event.key === 'Home' ? 0 : options.length - 1]?.focus()
    }
  }

  return (
    <div className="relative px-3 pb-2">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full rounded-lg border border-border-subtle px-3 py-2 text-start text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium">{activeWorkspace.label}</span>
          <WorkspaceStatusDot status={activeWorkspace.status} />
        </div>
        <div className="mt-0.5 truncate text-2xs text-text-muted">
          {workspaceDescription(activeWorkspace, supportByWorkspace[activeWorkspace.id])}
        </div>
      </button>

      {open && (
        <>
          {/* z-index via the --z-* design tokens, not Tailwind z-* utilities, which
              this project's Tailwind v4 setup does not generate (they compile to
              nothing, leaving the menu at z:auto under the sidebar nav). */}
          <ModalBackdrop onDismiss={() => setOpen(false)} className="fixed inset-0" style={{ zIndex: 'var(--z-dropdown)' }} />
          <div
            ref={menuRef}
            role="menu"
            aria-label={t('workspace.switcherLabel', 'Switch workspace')}
            onKeyDown={handleMenuKeyDown}
            className="absolute start-3 end-3 top-full mt-1 overflow-hidden rounded-lg p-1 theme-popover"
            style={{ zIndex: 'var(--z-overlay)' }}
          >
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitem"
              data-workspace-active={workspace.active ? 'true' : undefined}
              aria-current={workspace.active ? 'true' : undefined}
              onClick={() => void activateWorkspace(workspace)}
              className="ui-popover-item ui-popover-item--two-line text-xs"
            >
              <span className="ui-popover-item__content">
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-medium">{workspace.label}</span>
                  <WorkspaceStatusDot status={workspace.status} />
                </span>
                <span className="truncate text-2xs text-text-muted">
                  {workspaceDescription(workspace, supportByWorkspace[workspace.id])}
                </span>
              </span>
            </button>
          ))}
          <div className="-mx-1 mt-1 border-t border-border-subtle p-2">
            {showGatewayForm ? (
              <div className="space-y-2">
                <Input
                  type="url"
                  size="sm"
                  value={gatewayUrl}
                  onChange={(event) => setGatewayUrl(event.target.value)}
                  placeholder={t('workspace.gatewayUrl', 'Gateway URL')}
                  aria-label={t('workspace.gatewayUrl', 'Gateway URL')}
                />
                <Input
                  type="text"
                  size="sm"
                  value={gatewayLabel}
                  onChange={(event) => setGatewayLabel(event.target.value)}
                  placeholder={t('workspace.gatewayLabel', 'Label')}
                  aria-label={t('workspace.gatewayLabel', 'Label')}
                />
                <Input
                  type="password"
                  size="sm"
                  value={gatewayToken}
                  onChange={(event) => setGatewayToken(event.target.value)}
                  placeholder={t('workspace.gatewayToken', 'Gateway token')}
                  aria-label={t('workspace.gatewayToken', 'Gateway token')}
                />
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    fullWidth
                    onClick={() => void addGatewayWorkspace()}
                  >
                    {t('workspace.addStandaloneGateway', 'Connect for health')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowGatewayForm(false)}
                  >
                    {t('workspace.cancel', 'Cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                fullWidth
                className="justify-start"
                onClick={() => setShowGatewayForm(true)}
                title={t(
                  'workspace.connectStandaloneHint',
                  'Registers Standalone Gateway URL and token for health and support. Chat sessions stay deferred until a Desktop-safe session API is available.',
                )}
              >
                {t('workspace.connectStandalone', 'Connect Standalone Gateway (health only)')}
              </Button>
            )}
          </div>
          </div>
        </>
      )}
    </div>
  )
}
