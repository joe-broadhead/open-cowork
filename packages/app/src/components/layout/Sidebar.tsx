import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrandingSidebarConfig, DesktopFeatureFlags, DesktopFeatureKey } from '@open-cowork/shared'
import { isDesktopFeatureEnabled } from '@open-cowork/shared'
import { ThreadList } from '../sidebar/ThreadList'
import { McpStatus } from '../sidebar/McpStatus'
import { NewThreadButton } from '../sidebar/NewThreadButton'
import { t } from '../../helpers/i18n'
import type { AppNavigationTarget, AppView } from '../../app-types'
import { useSessionStore } from '../../stores/session'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { Icon, type IconName } from '@open-cowork/ui'
import { countDesktopApprovalQueueItems } from '../studio/approval-queue-model'
import { SidebarBrandTop, SidebarLowerBranding } from './SidebarBranding'
import { WorkspaceSwitcher, LOCAL_WORKSPACE_FALLBACK } from './WorkspaceSwitcher'

interface Props {
  currentView: AppView
  onViewChange: (view: AppNavigationTarget) => void
  searchRequestNonce?: number
  settingsRequestNonce?: number
  branding?: BrandingSidebarConfig
  collapsed?: boolean
  onExpandSidebar?: () => void
  features?: DesktopFeatureFlags
  // RBAC-gated Admin entry (cloud-only); resolved from admin permissions in App.
  showAdmin?: boolean
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

const ADMIN_NAV_ITEM: SidebarNavItem = { view: 'admin', icon: 'shield-check', labelKey: 'sidebar.admin', fallback: 'Admin' }

function visibleNavItems(items: SidebarNavItem[], features: DesktopFeatureFlags | undefined): SidebarNavItem[] {
  return items.filter((item) => !item.feature || isDesktopFeatureEnabled(features, item.feature))
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
      className={`sidebar-nav-item sidebar-nav-primary ${collapsed ? 'justify-center px-0' : ''} ${active ? 'text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
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
  const workspaceSupport = useActiveWorkspaceSupport()
  const authority = workspaceSupport.flags.authority
  const workspaceLabel = activeWorkspaceId === LOCAL_WORKSPACE_FALLBACK.id || authority === 'desktop_local'
    ? t('workspace.localShort', 'Local')
    : authority === 'gateway_standalone'
      ? t('workspace.gatewayShort', 'Standalone')
      : authority === 'desktop_paired'
        ? t('workspace.pairedShort', 'Paired')
        : t('workspace.cloudShort', 'Cloud')

  // JOE-1038: never hardcode Online. Prefer workspace status from support
  // context when present; fall back to runtime-ish authority labels only.
  const pairingState = workspaceSupport.flags.pairingState
  const statusLabel = (() => {
    if (pairingState === 'pairing_required') return t('workspace.status.authRequired', 'Auth required')
    if (pairingState === 'paired_offline') return t('workspace.status.offline', 'Offline cached')
    if (!workspaceSupport.flags.canCreateSession && !workspaceSupport.flags.canPrompt && authority === 'gateway_standalone') {
      return t('workspace.status.connectionOnly', 'Connection only')
    }
    if (!workspaceSupport.loaded && activeWorkspaceId !== LOCAL_WORKSPACE_FALLBACK.id) {
      return t('workspace.status.checking', 'Checking…')
    }
    if (workspaceSupport.error) return t('workspace.status.error', 'Error')
    if (workspaceSupport.flags.canPrompt || workspaceSupport.flags.canCreateSession || authority === 'desktop_local') {
      return t('workspace.status.online', 'Online')
    }
    return t('workspace.status.limited', 'Limited')
  })()

  return (
    <div className={`shrink-0 border-t border-border-subtle ${collapsed ? 'px-2 py-2' : 'px-3 py-2.5'}`}>
      <div className={`flex ${collapsed ? 'flex-col items-center justify-center gap-1.5' : 'items-center gap-2.5'}`}>
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border-subtle bg-surface-active font-display text-2xs font-bold text-text"
        >
          OC
        </span>
        {!collapsed ? (
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-text">{t('sidebar.presenceName', 'You')}</div>
            <div className="truncate text-2xs text-text-muted">{workspaceLabel} · {statusLabel}</div>
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
  showAdmin = false,
}: Props) {
  const primaryNavItems = visibleNavItems(PRIMARY_NAV_ITEMS, features)
  // ADMIN_NAV_ITEM is RBAC-gated (not deployment-feature-gated); shown only when the caller has admin permissions.
  const manageNavItems = showAdmin ? [...visibleNavItems(MANAGE_NAV_ITEMS, features), ADMIN_NAV_ITEM] : visibleNavItems(MANAGE_NAV_ITEMS, features)
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
  const approvalsQueueCount = useMemo(() => countDesktopApprovalQueueItems({
    activeWorkspaceId,
    sessionsByWorkspace,
    sessionStateById,
    currentSessionId,
    currentView: sessionView,
  }), [activeWorkspaceId, sessionsByWorkspace, sessionStateById, currentSessionId, sessionView])
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
        className={`flex min-h-0 shrink-0 flex-col border-e border-border-subtle transition-[width] duration-200 ${collapsed ? 'w-[74px] overflow-visible' : 'w-[264px] overflow-hidden'}`}
        style={{ background: 'color-mix(in srgb, var(--color-base) 92%, var(--color-elevated) 8%)' }}
        aria-label={t('sidebar.navigation', 'Sidebar navigation')}
        data-sidebar-collapsed={collapsed ? 'true' : 'false'}
        data-workbench-pane="threads"
      >
          {!collapsed ? <SidebarBrandTop top={branding?.top} /> : (
            <div className="px-2 pt-3 pb-2">
              <div className="grid h-10 w-10 place-items-center rounded-lg border border-border-subtle bg-elevated text-xs font-bold text-text">OC</div>
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
                className="w-full px-3 py-1.5 rounded-lg text-xs bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
              />
            </div>
          )}

          <div className={`min-h-0 overflow-y-auto px-2 pt-2 pb-1 ${collapsed ? 'max-h-none' : 'max-h-[40vh]'}`}>
            {!collapsed ? <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.primary', 'Studio')}</div> : null}
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
                    <span className="truncate font-semibold uppercase tracking-widest text-2xs">{t('sidebar.manage', 'Manage')}</span>
                    <span className="min-w-0 flex-1 truncate text-end text-2xs normal-case tracking-normal text-text-muted">
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
              className={`sidebar-nav-item mb-1 rounded-md px-2 py-1 text-start text-2xs font-semibold uppercase tracking-widest transition-colors ${currentView === 'projects' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
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
              className={`sidebar-nav-item mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs transition-colors ${currentView === 'health' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}>
              <Icon name="heart-pulse" size={16} />
              {t('sidebar.diagnostics', 'Diagnostics')}
            </button>
            <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.toolStatus', 'Tool Status')}</div>
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
        <Suspense fallback={<div className="fixed inset-0 z-[60] grid place-items-center text-xs text-text-muted">{t('settings.loading', 'Loading settings...')}</div>}>
          <SettingsPanel
            onClose={() => setShowSettings(false)}
          />
        </Suspense>
      ) : null}
    </>
  )
}
