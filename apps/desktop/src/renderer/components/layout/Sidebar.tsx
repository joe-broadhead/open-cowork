import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react'
import type {
  BrandingSidebarConfig,
  BrandingSidebarLowerConfig,
  BrandingSidebarTopConfig,
  WorkspaceApiSupport,
  WorkspaceInfo,
} from '@open-cowork/shared'
import { ThreadList } from '../sidebar/ThreadList'
import { McpStatus } from '../sidebar/McpStatus'
import { NewThreadButton } from '../sidebar/NewThreadButton'
import { t } from '../../helpers/i18n'
import type { AppView } from '../../app-types'
import { useSessionStore } from '../../stores/session'
import { supportAllows, supportEntry, useWorkspaceSupportStore } from '../../stores/workspace-support'
import { Icon } from '../ui'

interface Props {
  currentView: AppView
  onViewChange: (view: AppView) => void
  searchRequestNonce?: number
  settingsRequestNonce?: number
  branding?: BrandingSidebarConfig
}

const SettingsPanel = lazy(() =>
  import('../sidebar/SettingsPanel').then((module) => ({ default: module.SettingsPanel })),
)

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

  const refreshSupport = async (listedWorkspaces: WorkspaceInfo[], cancelled: () => boolean) => {
    const entries = await Promise.all(listedWorkspaces.map(async (workspace) => ({
      workspace,
      support: await loadWorkspaceSupport(workspace.id, { force: true }).catch(() => []),
    })))
    if (cancelled()) return
    return entries
  }

  const workspaceCanListSessions = (workspace: WorkspaceInfo, support: WorkspaceApiSupport[] | undefined) => {
    if (workspace.kind === 'local') return true
    if (!support) return false
    const entry = supportEntry(support, 'sessions.list')
    return Boolean(entry) && supportAllows(entry)
  }

  const loadSessionsForWorkspace = async (workspace: WorkspaceInfo, support?: WorkspaceApiSupport[]) => {
    if (!workspaceCanListSessions(workspace, support)) return []
    return window.coworkApi.session.list({ workspaceId: workspace.id })
  }

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
  }, [loadWorkspaceSupport, setActiveWorkspace, setSessions])

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

export function Sidebar({
  currentView,
  onViewChange,
  searchRequestNonce = 0,
  settingsRequestNonce = 0,
  branding,
}: Props) {
  const [showSettings, setShowSettings] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)

  useEffect(() => {
    if (searchRequestNonce === 0) return
    setShowSettings(false)
    setShowSearch(true)
    setSearchQuery('')
  }, [searchRequestNonce])

  useEffect(() => {
    if (settingsRequestNonce === 0) return
    setShowSearch(false)
    setSearchQuery('')
    setShowSettings(true)
  }, [settingsRequestNonce])

  return (
    <aside
      className={`flex flex-col shrink-0 border-e border-border-subtle transition-[width] duration-200 ${showSettings ? 'w-[640px]' : 'w-[252px]'}`}
      style={{ background: 'color-mix(in srgb, var(--color-base) 92%, var(--color-elevated) 8%)' }}
    >
      {showSettings ? (
        <Suspense fallback={<div className="p-4 text-[12px] text-text-muted">{t('settings.loading', 'Loading settings...')}</div>}>
          <SettingsPanel
            onClose={() => setShowSettings(false)}
          />
        </Suspense>
      ) : (
        <>
          <SidebarBrandTop top={branding?.top} />
          <WorkspaceSwitcher />
          <div className="p-3 pb-1 flex gap-2">
            <div className="flex-1">
              <NewThreadButton onClick={() => onViewChange('chat')} />
            </div>
            <button
              onClick={() => setShowSearch(!showSearch)}
              aria-label={t('sidebar.searchTitle', 'Search threads (⌘K)')}
              aria-expanded={showSearch}
              className={`w-9 h-9 flex items-center justify-center rounded-lg border border-border-subtle transition-colors cursor-pointer ${showSearch ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
              title={t('sidebar.searchTitle', 'Search threads (⌘K)')}
            >
              <Icon name="search" size={16} />
            </button>
          </div>

          {showSearch && (
            <div className="px-3 pb-1">
              <input
                autoFocus
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') } }}
                aria-label={t('sidebar.search', 'Search threads...')}
                placeholder={t('sidebar.search', 'Search threads...')}
                className="w-full px-3 py-1.5 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
              />
            </div>
          )}

          <div className="px-2 pt-2 pb-1">
            <button onClick={() => onViewChange('home')}
              aria-current={currentView === 'home' ? 'page' : undefined}
              className={`sidebar-nav-item sidebar-nav-primary ${currentView === 'home' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <Icon name="home" size={16} />
              {t('sidebar.home', 'Home')}
            </button>
            <button onClick={() => onViewChange('agents')}
              aria-current={currentView === 'agents' ? 'page' : undefined}
              className={`sidebar-nav-item sidebar-nav-primary ${currentView === 'agents' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <Icon name="bot" size={16} />
              {t('sidebar.agents', 'Agents')}
            </button>
            <button onClick={() => onViewChange('workflows')}
              aria-current={currentView === 'workflows' ? 'page' : undefined}
              className={`sidebar-nav-item sidebar-nav-primary ${currentView === 'workflows' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <Icon name="workflow" size={16} />
              {t('sidebar.workflows', 'Workflows')}
            </button>
            <button onClick={() => onViewChange('capabilities')}
              aria-current={currentView === 'capabilities' ? 'page' : undefined}
              className={`sidebar-nav-item sidebar-nav-primary ${currentView === 'capabilities' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <Icon name="blocks" size={16} />
              {t('sidebar.toolsSkills', 'Tools & Skills')}
            </button>
            <button onClick={() => onViewChange('health')}
              aria-current={currentView === 'health' ? 'page' : undefined}
              className={`sidebar-nav-item sidebar-nav-primary ${currentView === 'health' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <Icon name="heart-pulse" size={16} />
              {t('sidebar.healthCenter', 'Health Center')}
            </button>
          </div>

          {/* Threads — ThreadList owns its own scroll container so it
              can virtualize rows without fighting the parent over the
              scroll element reference. */}
          <div className="flex-1 min-h-0 flex flex-col px-2 py-2">
            <button
              type="button"
              onClick={() => onViewChange('threads')}
              aria-current={currentView === 'threads' ? 'page' : undefined}
              className={`sidebar-nav-item mb-1 rounded-md px-2 py-1 text-start text-[10px] font-semibold uppercase tracking-widest transition-colors ${currentView === 'threads' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
            >
              {t('sidebar.threads', 'Threads')}
            </button>
            <ThreadList onSelect={() => onViewChange('chat')} searchQuery={searchQuery} />
          </div>

          {/* Tool status */}
          <div className="border-t border-border-subtle px-2 py-2">
            <SidebarLowerBranding lower={branding?.lower} />
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.toolStatus', 'Tool Status')}</div>
            <McpStatus />
          </div>

          {/* Settings */}
          <button onClick={() => setShowSettings(true)}
            className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer border-t border-border-subtle">
            <Icon name="settings-2" size={16} />
            {t('sidebar.settings', 'Settings')}
          </button>
        </>
      )}
    </aside>
  )
}
