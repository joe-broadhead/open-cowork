import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react'
import type { BrandingSidebarConfig, BrandingSidebarLowerConfig, BrandingSidebarTopConfig, WorkspaceInfo } from '@open-cowork/shared'
import { ThreadList } from '../sidebar/ThreadList'
import { McpStatus } from '../sidebar/McpStatus'
import { NewThreadButton } from '../sidebar/NewThreadButton'
import { t } from '../../helpers/i18n'
import type { AppView } from '../../app-types'
import { useSessionStore } from '../../stores/session'

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
      return t('workspace.status.offline', 'Offline')
    case 'auth_required':
      return t('workspace.status.authRequired', 'Sign in')
    case 'disabled':
      return t('workspace.status.disabled', 'Disabled')
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

function WorkspaceSwitcher() {
  const setSessions = useSessionStore((state) => state.setSessions)
  const setCurrentSession = useSessionStore((state) => state.setCurrentSession)
  const setActiveWorkspace = useSessionStore((state) => state.setActiveWorkspace)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([LOCAL_WORKSPACE_FALLBACK])
  const [open, setOpen] = useState(false)

  const activeWorkspace = workspaces.find((workspace) => workspace.active) || workspaces[0] || LOCAL_WORKSPACE_FALLBACK

  useEffect(() => {
    let cancelled = false
    const workspaceApi = window.coworkApi?.workspace
    if (!workspaceApi) return
    workspaceApi.list()
      .then(async (next) => {
        if (cancelled) return
        const listedWorkspaces = next.length > 0 ? next : [LOCAL_WORKSPACE_FALLBACK]
        setWorkspaces(listedWorkspaces)
        const active = listedWorkspaces.find((workspace) => workspace.active) || listedWorkspaces[0] || LOCAL_WORKSPACE_FALLBACK
        setActiveWorkspace(active.id)
        if (active.kind === 'local' || active.status === 'online') {
          const sessions = await window.coworkApi.session.list({ workspaceId: active.id })
          if (!cancelled) setSessions(sessions)
        } else if (!cancelled) {
          setSessions([])
        }
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([LOCAL_WORKSPACE_FALLBACK])
      })
    return () => {
      cancelled = true
    }
  }, [setActiveWorkspace, setSessions])

  const activateWorkspace = async (workspace: WorkspaceInfo) => {
    const previousId = activeWorkspace.id
    setOpen(false)
    try {
      if (workspace.kind === 'cloud' && workspace.status === 'auth_required') {
        await window.coworkApi.workspace.login(workspace.id)
      }
      let activated = await window.coworkApi.workspace.activate(workspace.id)
      if (activated.kind === 'cloud' && activated.status === 'auth_required') {
        await window.coworkApi.workspace.login(activated.id)
        activated = await window.coworkApi.workspace.activate(activated.id)
      }
      const nextWorkspaces = await window.coworkApi.workspace.list()
      setWorkspaces(nextWorkspaces.length > 0 ? nextWorkspaces : [activated])
      if (activated.id !== previousId) {
        setActiveWorkspace(activated.id)
        setCurrentSession(null)
      }
      if (activated.kind === 'local' || activated.status === 'online') {
        setSessions(await window.coworkApi.session.list({ workspaceId: activated.id }))
      } else {
        setSessions([])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        const restored = await window.coworkApi.workspace.activate(previousId)
        const restoredWorkspaces = await window.coworkApi.workspace.list()
        setWorkspaces(restoredWorkspaces.length > 0 ? restoredWorkspaces : [restored])
        setActiveWorkspace(restored.id)
        if (restored.kind === 'local' || restored.status === 'online') {
          setSessions(await window.coworkApi.session.list({ workspaceId: restored.id }))
        } else {
          setSessions([])
        }
      } catch {
        // Leave the visible workspace unchanged if rollback also fails; the
        // original login error is still the actionable user-facing failure.
      }
      addGlobalError(message || t('workspace.switchFailed', 'Could not switch workspace.'))
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
          <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${workspaceStatusClass(activeWorkspace.status)}`}>
            {workspaceStatusLabel(activeWorkspace.status)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-text-muted">
          {activeWorkspace.kind === 'local'
            ? t('workspace.local', 'Local workspace')
            : activeWorkspace.profileName || activeWorkspace.baseUrl || t('workspace.cloud', 'Cloud workspace')}
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
                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${workspaceStatusClass(workspace.status)}`}>
                  {workspaceStatusLabel(workspace.status)}
                </span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-text-muted">
                {workspace.kind === 'local'
                  ? t('workspace.local', 'Local workspace')
                  : workspace.profileName || workspace.baseUrl || t('workspace.cloud', 'Cloud workspace')}
              </div>
            </button>
          ))}
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
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <circle cx="6" cy="6" r="4.5" />
                <line x1="9.2" y1="9.2" x2="12" y2="12" />
              </svg>
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
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'home' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5.5 6.5 2 11 5.5V11a.75.75 0 0 1-.75.75H2.75A.75.75 0 0 1 2 11V5.5Z" />
                <path d="M5 11.75V8h3v3.75" />
              </svg>
              {t('sidebar.home', 'Home')}
            </button>
            <button onClick={() => onViewChange('agents')}
              aria-current={currentView === 'agents' ? 'page' : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'agents' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4" cy="4" r="1.5" />
                <circle cx="9" cy="4" r="1.5" />
                <path d="M1.8 10.8C2.2 9.4 3.3 8.5 4.6 8.5H5.3C6.7 8.5 7.8 9.4 8.2 10.8" />
                <path d="M7.5 10.8C7.8 9.9 8.5 9.3 9.4 9.3H9.8C10.8 9.3 11.5 9.9 11.8 10.8" />
              </svg>
              {t('sidebar.agents', 'Agents')}
            </button>
            <button onClick={() => onViewChange('workflows')}
              aria-current={currentView === 'workflows' ? 'page' : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'workflows' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="3" height="3" rx="0.6" />
                <rect x="8" y="2" width="3" height="3" rx="0.6" />
                <rect x="2" y="8" width="3" height="3" rx="0.6" />
                <path d="M8 9.5H11" />
                <path d="M9.5 8V11" />
                <path d="M5 3.5H8" />
                <path d="M3.5 5V8" />
              </svg>
              {t('sidebar.workflows', 'Workflows')}
            </button>
            <button onClick={() => onViewChange('capabilities')}
              aria-current={currentView === 'capabilities' ? 'page' : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'capabilities' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="3.25" cy="3.25" r="1.25" />
                <circle cx="9.75" cy="3.25" r="1.25" />
                <circle cx="6.5" cy="9.75" r="1.25" />
                <path d="M4.5 3.25H8.5" />
                <path d="M4 4.2 5.8 8.7" />
                <path d="M9 4.2 7.2 8.7" />
              </svg>
              {t('sidebar.toolsSkills', 'Tools & Skills')}
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
              className={`mb-1 rounded-md px-2 py-1 text-start text-[10px] font-semibold uppercase tracking-widest transition-colors ${currentView === 'threads' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
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
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <circle cx="7" cy="7" r="2.5" /><path d="M7 1.5V3M7 11V12.5M1.5 7H3M11 7H12.5M2.8 2.8L3.9 3.9M10.1 10.1L11.2 11.2M11.2 2.8L10.1 3.9M3.9 10.1L2.8 11.2" />
            </svg>
            {t('sidebar.settings', 'Settings')}
          </button>
        </>
      )}
    </aside>
  )
}
