import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  BrandingSidebarConfig,
  BrandingSidebarLowerConfig,
  BrandingSidebarTopConfig,
  DesktopFeatureFlags,
  DesktopFeatureKey,
  WorkspaceApiSupport,
  WorkspaceInfo,
} from '@open-cowork/shared'
import { isDesktopFeatureEnabled } from '@open-cowork/shared'
import { ThreadList } from '../sidebar/ThreadList'
import { McpStatus } from '../sidebar/McpStatus'
import { NewThreadButton } from '../sidebar/NewThreadButton'
import { t } from '../../helpers/i18n'
import type { AppNavigationTarget, AppView } from '../../app-types'
import { useSessionStore } from '../../stores/session'
import { supportAllows, supportEntry, useWorkspaceSupportStore } from '../../stores/workspace-support'
import { Icon, type IconName } from '../ui'
import { buildDesktopApprovalQueueItems } from '../studio/approval-queue-model'

interface Props {
  currentView: AppView
  onViewChange: (view: AppNavigationTarget) => void
  searchRequestNonce?: number
  settingsRequestNonce?: number
  branding?: BrandingSidebarConfig
  collapsed?: boolean
  onExpandSidebar?: () => void
  features?: DesktopFeatureFlags
}

const SettingsPanel = lazy(() =>
  import('../sidebar/SettingsPanel').then((module) => ({ default: module.SettingsPanel })),
)

type SidebarNavItem = {
  view: AppNavigationTarget
  icon: IconName
  labelKey: string
  fallback: string
  // When set, the item is hidden if the deployment disables this feature flag.
  feature?: DesktopFeatureKey
}

const PRIMARY_NAV_ITEMS: SidebarNavItem[] = [
  { view: 'home', icon: 'home', labelKey: 'sidebar.home', fallback: 'Home' },
  { view: 'projects', icon: 'folder', labelKey: 'sidebar.projects', fallback: 'Projects', feature: 'projects' },
  { view: 'knowledge', icon: 'book-open', labelKey: 'sidebar.knowledge', fallback: 'Knowledge', feature: 'knowledge' },
  { view: 'approvals', icon: 'circle-help', labelKey: 'sidebar.approvals', fallback: 'Approvals', feature: 'approvals' },
]

const MANAGE_NAV_ITEMS: SidebarNavItem[] = [
  { view: 'team', icon: 'users', labelKey: 'sidebar.team', fallback: 'Team', feature: 'team' },
  { view: 'playbooks', icon: 'workflow', labelKey: 'sidebar.playbooks', fallback: 'Playbooks', feature: 'playbooks' },
  { view: 'channels', icon: 'activity', labelKey: 'sidebar.channels', fallback: 'Channels', feature: 'channels' },
  { view: 'tools', icon: 'blocks', labelKey: 'sidebar.toolsSkills', fallback: 'Tools & Skills', feature: 'tools' },
  { view: 'artifacts', icon: 'file', labelKey: 'sidebar.artifacts', fallback: 'Artifacts', feature: 'artifacts' },
]

function visibleNavItems(items: SidebarNavItem[], features: DesktopFeatureFlags | undefined): SidebarNavItem[] {
  return items.filter((item) => !item.feature || isDesktopFeatureEnabled(features, item.feature))
}

function safeLogoDataUrl(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > 65_536) return undefined
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed) ? trimmed : undefined
}

function safeLogoUrl(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > 1024) return undefined
  try {
    const url = new URL(trimmed)
    return url.protocol === 'open-cowork-asset:' && url.hostname === 'branding' ? trimmed : undefined
  } catch {
    return undefined
  }
}

function logoSource(top: BrandingSidebarTopConfig) {
  return safeLogoUrl(top.logoUrl) || safeLogoDataUrl(top.logoDataUrl)
}

function safeExternalHref(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'mailto:' ? trimmed : null
  } catch {
    return null
  }
}

function sidebarTopVariant(top: BrandingSidebarTopConfig) {
  if (top.variant) return top.variant
  if (logoSource(top)) return top.title || top.subtitle ? 'logo-text' : 'logo'
  if (top.icon) return top.title || top.subtitle ? 'icon-text' : 'icon'
  return 'text'
}

function renderableSidebarTopVariant(
  preferred: NonNullable<BrandingSidebarTopConfig['variant']>,
  options: {
    hasLogo: boolean
    hasIcon: boolean
    hasText: boolean
  },
) {
  const { hasLogo, hasIcon, hasText } = options
  const firstRenderable = (...candidates: Array<NonNullable<BrandingSidebarTopConfig['variant']>>) =>
    candidates.find((candidate) => {
      if (candidate === 'logo') return hasLogo
      if (candidate === 'icon') return hasIcon
      if (candidate === 'text') return hasText
      if (candidate === 'logo-text') return hasLogo && hasText
      return hasIcon && hasText
    }) || null

  switch (preferred) {
    case 'logo':
      return firstRenderable('logo', 'icon', 'text')
    case 'icon':
      return firstRenderable('icon', 'logo', 'text')
    case 'text':
      return firstRenderable('text', 'logo', 'icon')
    case 'logo-text':
      return firstRenderable('logo-text', 'logo', 'text', 'icon')
    case 'icon-text':
      return firstRenderable('icon-text', 'icon', 'text', 'logo')
    default:
      return null
  }
}

const BRAND_MEDIA_SIZE_DEFAULT = 28
const BRAND_MEDIA_SIZE_MIN = 16
const BRAND_MEDIA_SIZE_MAX = 96

function sidebarBrandMediaSize(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BRAND_MEDIA_SIZE_DEFAULT
  return Math.min(BRAND_MEDIA_SIZE_MAX, Math.max(BRAND_MEDIA_SIZE_MIN, Math.round(value)))
}

function sidebarBrandMediaFit(value: BrandingSidebarTopConfig['mediaFit']) {
  if (value === 'horizontal' || value === 'vertical') return value
  return 'bounded'
}

function sidebarBrandMediaAlign(value: BrandingSidebarTopConfig['mediaAlign'], iconOnly: boolean) {
  if (value === 'start' || value === 'center' || value === 'end') return value
  return iconOnly ? 'center' : 'start'
}

function sidebarBrandJustifyClass(align: 'start' | 'center' | 'end') {
  if (align === 'center') return 'justify-center'
  if (align === 'end') return 'justify-end'
  return 'justify-start'
}

function SidebarBrandTop({ top }: { top?: BrandingSidebarTopConfig }) {
  if (!top) return null

  const title = top.title?.trim()
  const subtitle = top.subtitle?.trim()
  const icon = top.icon?.trim()
  const logoUrl = logoSource(top)
  const hasText = Boolean(title || subtitle)
  const hasIcon = Boolean(icon)
  const hasLogo = Boolean(logoUrl)
  if (!hasText && !hasIcon && !hasLogo) return null

  const variant = renderableSidebarTopVariant(sidebarTopVariant(top), { hasLogo, hasIcon, hasText })
  if (!variant) return null
  const showLogo = Boolean(logoUrl && (variant === 'logo' || variant === 'logo-text'))
  const showIcon = Boolean(!showLogo && icon && (variant === 'icon' || variant === 'icon-text'))
  const showText = hasText && (variant === 'text' || variant === 'icon-text' || variant === 'logo-text' || (!showLogo && !showIcon))
  const iconOnly = !showText && (showLogo || showIcon)
  const ariaLabel = top.ariaLabel?.trim() || title || subtitle || t('sidebar.branding', 'Brand')
  const mediaSize = sidebarBrandMediaSize(top.mediaSize)
  const mediaFit = sidebarBrandMediaFit(top.mediaFit)
  const mediaAlign = sidebarBrandMediaAlign(top.mediaAlign, iconOnly)
  const logoStyle: CSSProperties = mediaFit === 'horizontal'
    ? { width: mediaSize, height: 'auto', maxHeight: mediaSize }
    : mediaFit === 'vertical'
      ? { height: mediaSize, width: 'auto', maxWidth: '100%' }
      : { width: mediaSize, height: mediaSize }
  const iconStyle: CSSProperties = {
    width: mediaSize,
    height: mediaSize,
    background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)',
  }

  return (
    <div className="px-3 pt-3 pb-2">
      <div
        className={`flex min-h-10 items-center gap-2.5 rounded-lg border border-border-subtle px-2.5 py-2 text-text-secondary ${iconOnly ? sidebarBrandJustifyClass(mediaAlign) : ''}`}
        style={{ background: 'color-mix(in srgb, var(--color-elevated) 42%, transparent)' }}
        role={iconOnly ? 'img' : undefined}
        aria-label={iconOnly ? ariaLabel : undefined}
      >
        {showLogo && (
          <img
            src={logoUrl}
            alt=""
            className={`shrink-0 rounded-md object-contain ${!iconOnly ? 'self-center' : ''}`}
            style={logoStyle}
            draggable={false}
          />
        )}
        {showIcon && (
          <span
            className={`grid shrink-0 place-items-center rounded-md border border-border-subtle text-[14px] ${!iconOnly ? 'self-center' : ''}`}
            style={iconStyle}
            aria-hidden={iconOnly ? undefined : 'true'}
          >
            {icon}
          </span>
        )}
        {showText && (
          <div className="min-w-0 flex-1">
            {title && <div className="truncate text-[12px] font-medium text-text">{title}</div>}
            {subtitle && <div className="mt-0.5 truncate text-[10px] text-text-muted">{subtitle}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function SidebarLowerBranding({ lower }: { lower?: BrandingSidebarLowerConfig }) {
  if (!lower) return null
  const text = lower.text?.trim()
  const secondaryText = lower.secondaryText?.trim()
  const linkLabel = lower.linkLabel?.trim()
  const linkUrl = safeExternalHref(lower.linkUrl)
  if (!text && !secondaryText && !(linkLabel && linkUrl)) return null

  return (
    <div className="mb-2 rounded-md border border-border-subtle px-2 py-2 text-[11px] text-text-muted"
      style={{ background: 'color-mix(in srgb, var(--color-elevated) 34%, transparent)' }}>
      {text && <div className="truncate font-medium text-text-secondary">{text}</div>}
      {secondaryText && <div className="mt-0.5 line-clamp-2 leading-snug">{secondaryText}</div>}
      {linkLabel && linkUrl && (
        <a
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex max-w-full text-[11px] text-text-secondary hover:text-text underline-offset-2 hover:underline"
        >
          <span className="truncate">{linkLabel}</span>
        </a>
      )}
    </div>
  )
}

const LOCAL_WORKSPACE_FALLBACK: WorkspaceInfo = {
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

function workspaceStatusClass(status: WorkspaceInfo['status']) {
  if (status === 'online') return 'border-green-500/30 text-green-200'
  if (status === 'offline') return 'border-amber-500/30 text-amber-200'
  if (status === 'auth_required') return 'border-sky-400/30 text-sky-200'
  return 'border-red-400/30 text-red-200'
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
    return t('workspace.gatewayStandalone', 'Standalone Gateway - private Gateway execution')
  }
  if (workspace.authority === 'desktop_paired') {
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

function WorkspaceSwitcher() {
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

  return (
    <div className="relative px-3 pb-2">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full rounded-lg border border-border-subtle px-3 py-2 text-start text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium">{activeWorkspace.label}</span>
          <span className={`max-w-[96px] shrink-0 truncate rounded border px-1.5 py-0.5 text-[10px] ${workspaceStatusClass(activeWorkspace.status)}`}>
            {workspaceStatusLabel(activeWorkspace.status)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-text-muted">
          {workspaceDescription(activeWorkspace, supportByWorkspace[activeWorkspace.id])}
        </div>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute start-3 end-3 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border-subtle bg-elevated shadow-card"
        >
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitem"
              onClick={() => void activateWorkspace(workspace)}
              className={`w-full px-3 py-2 text-start text-[12px] transition-colors hover:bg-surface-hover ${workspace.active ? 'text-text' : 'text-text-secondary'}`}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate font-medium">{workspace.label}</span>
                <span className={`max-w-[96px] shrink-0 truncate rounded border px-1.5 py-0.5 text-[10px] ${workspaceStatusClass(workspace.status)}`}>
                  {workspaceStatusLabel(workspace.status)}
                </span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-text-muted">
                {workspaceDescription(workspace, supportByWorkspace[workspace.id])}
              </div>
            </button>
          ))}
          <div className="border-t border-border-subtle p-2">
            {showGatewayForm ? (
              <div className="space-y-2">
                <input
                  type="url"
                  value={gatewayUrl}
                  onChange={(event) => setGatewayUrl(event.target.value)}
                  placeholder={t('workspace.gatewayUrl', 'Gateway URL')}
                  aria-label={t('workspace.gatewayUrl', 'Gateway URL')}
                  className="w-full rounded-md border border-border-subtle bg-base px-2 py-1.5 text-[12px] text-text outline-none focus:border-border"
                />
                <input
                  type="text"
                  value={gatewayLabel}
                  onChange={(event) => setGatewayLabel(event.target.value)}
                  placeholder={t('workspace.gatewayLabel', 'Label')}
                  aria-label={t('workspace.gatewayLabel', 'Label')}
                  className="w-full rounded-md border border-border-subtle bg-base px-2 py-1.5 text-[12px] text-text outline-none focus:border-border"
                />
                <input
                  type="password"
                  value={gatewayToken}
                  onChange={(event) => setGatewayToken(event.target.value)}
                  placeholder={t('workspace.gatewayToken', 'Gateway token')}
                  aria-label={t('workspace.gatewayToken', 'Gateway token')}
                  className="w-full rounded-md border border-border-subtle bg-base px-2 py-1.5 text-[12px] text-text outline-none focus:border-border"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void addGatewayWorkspace()}
                    className="flex-1 rounded-md border border-border-subtle px-2 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                  >
                    {t('workspace.addGateway', 'Add Gateway')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowGatewayForm(false)}
                    className="rounded-md border border-border-subtle px-2 py-1.5 text-[12px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
                  >
                    {t('workspace.cancel', 'Cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowGatewayForm(true)}
                className="w-full rounded-md border border-border-subtle px-2 py-1.5 text-start text-[12px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
              >
                {t('workspace.connectGateway', 'Connect Gateway workspace')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SidebarNavButton({
  item,
  currentView,
  collapsed,
  onViewChange,
  badge,
}: {
  item: SidebarNavItem
  currentView: AppView
  collapsed: boolean
  onViewChange: (view: AppNavigationTarget) => void
  badge?: number
}) {
  const label = t(item.labelKey, item.fallback)
  const active = currentView === item.view

  return (
    <button
      type="button"
      data-nav-view={item.view}
      onClick={() => onViewChange(item.view)}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      className={`sidebar-nav-item sidebar-nav-primary ${collapsed ? 'justify-center px-0' : ''} ${active ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
    >
      <Icon name={item.icon} size={16} />
      {!collapsed ? <span className="truncate">{label}</span> : null}
      {!collapsed && badge && badge > 0 ? (
        <span className="nav-alert-count" aria-label={`${badge} pending approvals and questions`}>
          {badge}
        </span>
      ) : null}
    </button>
  )
}

function SidebarPresenceFooter({
  collapsed,
  onSettings,
  showSettings,
}: {
  collapsed: boolean
  onSettings: () => void
  showSettings: boolean
}) {
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const workspaceLabel = activeWorkspaceId === LOCAL_WORKSPACE_FALLBACK.id
    ? t('workspace.localShort', 'Local')
    : t('workspace.cloudShort', 'Cloud')

  return (
    <div className={`shrink-0 border-t border-border-subtle ${collapsed ? 'px-2 py-2' : 'px-3 py-2.5'}`}>
      <div className={`flex ${collapsed ? 'flex-col items-center justify-center gap-1.5' : 'items-center gap-2.5'}`}>
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border-subtle bg-surface-active font-display text-[11px] font-bold text-text"
        >
          OC
        </span>
        {!collapsed ? (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium text-text">{t('sidebar.presenceName', 'You')}</div>
            <div className="truncate text-[10px] text-text-muted">{workspaceLabel} · {t('workspace.status.online', 'Online')}</div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={onSettings}
          aria-label={t('sidebar.settings', 'Settings')}
          aria-expanded={showSettings}
          title={t('sidebar.settings', 'Settings')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <Icon name="settings-2" size={16} />
        </button>
      </div>
    </div>
  )
}

export function Sidebar({
  currentView,
  onViewChange,
  searchRequestNonce = 0,
  settingsRequestNonce = 0,
  branding,
  collapsed = false,
  onExpandSidebar,
  features,
}: Props) {
  const primaryNavItems = visibleNavItems(PRIMARY_NAV_ITEMS, features)
  const manageNavItems = visibleNavItems(MANAGE_NAV_ITEMS, features)
  const [showSettings, setShowSettings] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [manageOpen, setManageOpen] = useState(true)
  const lastHandledSearchRequestNonce = useRef(0)
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const sessionsByWorkspace = useSessionStore((state) => state.sessionsByWorkspace)
  const sessionStateById = useSessionStore((state) => state.sessionStateById)
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessionView = useSessionStore((state) => state.currentView)
  const approvalsQueueCount = useMemo(() => buildDesktopApprovalQueueItems({
    activeWorkspaceId,
    sessionsByWorkspace,
    sessionStateById,
    currentSessionId,
    currentView: sessionView,
  }).length, [activeWorkspaceId, sessionsByWorkspace, sessionStateById, currentSessionId, sessionView])
  const manageActive = manageNavItems.some((item) => item.view === currentView)

  useEffect(() => {
    if (searchRequestNonce === 0) return
    if (searchRequestNonce === lastHandledSearchRequestNonce.current) return
    lastHandledSearchRequestNonce.current = searchRequestNonce
    if (collapsed) onExpandSidebar?.()
    setShowSettings(false)
    setShowSearch(true)
    setSearchQuery('')
  }, [collapsed, onExpandSidebar, searchRequestNonce])

  useEffect(() => {
    if (settingsRequestNonce === 0) return
    setShowSearch(false)
    setSearchQuery('')
    setShowSettings(true)
  }, [settingsRequestNonce])

  useEffect(() => {
    if (manageActive) setManageOpen(true)
  }, [manageActive])

  return (
    <>
      <aside
        className={`flex min-h-0 shrink-0 flex-col border-e border-border-subtle transition-[width] duration-200 ${collapsed ? 'w-16 overflow-visible' : 'w-[252px] overflow-hidden'}`}
        style={{ background: 'color-mix(in srgb, var(--color-base) 92%, var(--color-elevated) 8%)' }}
        aria-label={t('sidebar.navigation', 'Sidebar navigation')}
        data-sidebar-collapsed={collapsed ? 'true' : 'false'}
        data-workbench-pane="threads"
      >
          {!collapsed ? <SidebarBrandTop top={branding?.top} /> : (
            <div className="px-2 pt-3 pb-2">
              <div className="grid h-10 w-10 place-items-center rounded-lg border border-border-subtle bg-elevated text-[12px] font-bold text-text">OC</div>
            </div>
          )}
          {!collapsed ? <WorkspaceSwitcher /> : null}
          <div className={`shrink-0 flex gap-2 ${collapsed ? 'flex-col px-3 pb-2' : 'p-3 pb-1'}`}>
            <div className={collapsed ? '' : 'flex-1'}>
              <NewThreadButton onClick={() => onViewChange('chat')} compact={collapsed} />
            </div>
            <button
              onClick={() => {
                if (collapsed) {
                  onExpandSidebar?.()
                  setShowSearch(true)
                  return
                }
                setShowSearch(!showSearch)
              }}
              aria-label={t('sidebar.searchTitle', 'Search projects and chats (⌘K)')}
              aria-expanded={showSearch}
              className={`w-9 h-9 flex items-center justify-center rounded-lg border border-border-subtle transition-colors cursor-pointer ${showSearch ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
              title={t('sidebar.searchTitle', 'Search projects and chats (⌘K)')}
            >
              <Icon name="search" size={16} />
            </button>
          </div>

          {showSearch && !collapsed && (
            <div className="shrink-0 px-3 pb-1">
              <input
                autoFocus
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') } }}
                aria-label={t('sidebar.search', 'Search projects and chats...')}
                placeholder={t('sidebar.search', 'Search projects and chats...')}
                className="w-full px-3 py-1.5 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
              />
            </div>
          )}

          <div className={`min-h-0 overflow-y-auto px-2 pt-2 pb-1 ${collapsed ? 'max-h-none' : 'max-h-[40vh]'}`}>
            {!collapsed ? <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.primary', 'Studio')}</div> : null}
            {primaryNavItems.map((item) => (
              <SidebarNavButton
                key={item.view}
                item={item}
                currentView={currentView}
                collapsed={collapsed}
                onViewChange={onViewChange}
                badge={item.view === 'approvals' ? approvalsQueueCount : undefined}
              />
            ))}
            <div className={`pt-3 ${collapsed ? 'px-0' : 'px-2'}`}>
              <button
                type="button"
                onClick={() => setManageOpen((current) => !current)}
                aria-expanded={manageOpen}
                aria-label={collapsed ? t('sidebar.manage', 'Manage') : undefined}
                title={collapsed ? t('sidebar.manage', 'Manage') : undefined}
                className={`sidebar-nav-item sidebar-nav-primary w-full ${collapsed ? 'justify-center px-0' : ''} ${manageActive ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
              >
                <Icon name={manageOpen ? 'chevron-down' : 'chevron-right'} size={16} />
                {!collapsed ? (
                  <>
                    <span className="truncate font-semibold uppercase tracking-widest text-[10px]">{t('sidebar.manage', 'Manage')}</span>
                    <span className="min-w-0 flex-1 truncate text-end text-[10px] normal-case tracking-normal text-text-muted">
                      {manageActive
                        ? t(manageNavItems.find((item) => item.view === currentView)?.labelKey || 'sidebar.manage', manageNavItems.find((item) => item.view === currentView)?.fallback || 'Manage')
                        : t('sidebar.manageHint', 'Team · Playbooks · Tools')}
                    </span>
                  </>
                ) : null}
              </button>
              {manageOpen ? (
                <div className={collapsed ? 'mt-1' : 'mt-1'}>
                  {manageNavItems.map((item) => (
                    <SidebarNavButton
                      key={item.view}
                      item={item}
                      currentView={currentView}
                      collapsed={collapsed}
                      onViewChange={onViewChange}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {/* Recent project chats — ThreadList owns its own scroll container so it
              can virtualize rows without fighting the parent over the
              scroll element reference. */}
          {!collapsed ? <div className="flex min-h-[120px] flex-1 flex-col overflow-hidden px-2 py-2">
            <button
              type="button"
              onClick={() => onViewChange('projects')}
              aria-current={currentView === 'projects' ? 'page' : undefined}
              className={`sidebar-nav-item mb-1 rounded-md px-2 py-1 text-start text-[10px] font-semibold uppercase tracking-widest transition-colors ${currentView === 'projects' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
            >
              {t('sidebar.recentWork', 'Recent work')}
            </button>
            <ThreadList onSelect={() => onViewChange('chat')} searchQuery={searchQuery} />
          </div> : <div className="flex-1" />}

          {/* Tool status */}
          {!collapsed ? <div className="max-h-[28vh] shrink-0 overflow-y-auto border-t border-border-subtle px-2 py-2">
            <SidebarLowerBranding lower={branding?.lower} />
            <button onClick={() => onViewChange('health')}
              aria-current={currentView === 'health' ? 'page' : undefined}
              title={t('sidebar.diagnostics', 'Diagnostics')}
              className={`sidebar-nav-item mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[12px] transition-colors ${currentView === 'health' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}>
              <Icon name="heart-pulse" size={16} />
              {t('sidebar.diagnostics', 'Diagnostics')}
            </button>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.toolStatus', 'Tool Status')}</div>
            <McpStatus />
          </div> : (
            <div className="shrink-0 border-t border-border-subtle px-2 py-2">
              <button onClick={() => onViewChange('health')}
                aria-current={currentView === 'health' ? 'page' : undefined}
                aria-label={t('sidebar.diagnostics', 'Diagnostics')}
                title={t('sidebar.diagnostics', 'Diagnostics')}
                className={`sidebar-nav-item sidebar-nav-primary justify-center px-0 ${currentView === 'health' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}>
                <Icon name="heart-pulse" size={16} />
              </button>
            </div>
          )}

          <SidebarPresenceFooter collapsed={collapsed} showSettings={showSettings} onSettings={() => setShowSettings(true)} />
      </aside>
      {showSettings ? (
        <Suspense fallback={<div className="fixed inset-0 z-[60] grid place-items-center text-[12px] text-text-muted">{t('settings.loading', 'Loading settings...')}</div>}>
          <SettingsPanel
            onClose={() => setShowSettings(false)}
          />
        </Suspense>
      ) : null}
    </>
  )
}
