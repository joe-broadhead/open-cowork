import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrandingSidebarConfig, DesktopFeatureFlags } from '@open-cowork/shared'
import { isDesktopFeatureEnabled, productFeatureForRoute, productSurfaceForRoute } from '@open-cowork/shared'
import { ThreadList } from '../sidebar/ThreadList'
import { NewThreadButton } from '../sidebar/NewThreadButton'
import { t } from '../../helpers/i18n'
import type { AppNavigationTarget, AppView } from '../../app-types'
import { useSessionStore } from '../../stores/session'
import { Icon, type IconName } from '@open-cowork/ui'
import { countDesktopApprovalQueueItems } from '../studio/approval-queue-model'
import { SidebarBrandTop, SidebarLowerBranding } from './SidebarBranding'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

interface Props {
  currentView: AppView
  onViewChange: (view: AppNavigationTarget) => void
  searchRequestNonce?: number
  settingsRequestNonce?: number
  branding?: BrandingSidebarConfig
  collapsed?: boolean
  onExpandSidebar?: () => void
  onSetupRequired?: () => void
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
}

const PRIMARY_NAV_ITEMS: SidebarNavItem[] = [
  { view: 'home', icon: 'home', labelKey: 'sidebar.home', fallback: 'Home' },
  { view: 'projects', icon: 'folder', labelKey: 'sidebar.projects', fallback: 'Projects' },
  { view: 'knowledge', icon: 'book-open', labelKey: 'sidebar.knowledge', fallback: 'Knowledge' },
  { view: 'wiki', icon: 'file-text', labelKey: 'sidebar.wiki', fallback: 'Wiki' },
  { view: 'approvals', icon: 'circle-help', labelKey: 'sidebar.approvals', fallback: 'Approvals' },
]

const MANAGE_NAV_ITEMS: SidebarNavItem[] = [
  { view: 'team', icon: 'users', labelKey: 'sidebar.team', fallback: 'Team' },
  { view: 'playbooks', icon: 'workflow', labelKey: 'sidebar.playbooks', fallback: 'Playbooks' },
  { view: 'channels', icon: 'activity', labelKey: 'sidebar.channels', fallback: 'Channels' },
  { view: 'tools', icon: 'blocks', labelKey: 'sidebar.toolsSkills', fallback: 'Tools & Skills' },
  { view: 'artifacts', icon: 'file', labelKey: 'sidebar.artifacts', fallback: 'Artifacts' },
]

const ADMIN_NAV_ITEM: SidebarNavItem = { view: 'admin', icon: 'shield-check', labelKey: 'sidebar.admin', fallback: 'Admin' }

function visibleNavItems(items: SidebarNavItem[], features: DesktopFeatureFlags | undefined): SidebarNavItem[] {
  return items.filter((item) => {
    const feature = productFeatureForRoute(item.view)
    return !feature || isDesktopFeatureEnabled(features, feature)
  })
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
  const label = t(item.labelKey, productSurfaceForRoute(item.view)?.label || item.fallback)
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

function SidebarSettingsFooter({
  collapsed,
  onSettings,
  showSettings,
}: {
  collapsed: boolean
  onSettings: () => void
  showSettings: boolean
}) {
  return (
    <div className={`flex shrink-0 flex-col border-t border-border-subtle ${collapsed ? 'px-2 py-2' : 'px-3 py-2.5'}`}>
      <button
        type="button"
        onClick={onSettings}
        aria-label={t('sidebar.settings', 'Settings')}
        aria-expanded={showSettings}
        title={t('sidebar.settings', 'Settings')}
        className={`flex h-8 items-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary ${collapsed ? 'justify-center' : 'gap-2 px-2'}`}
      >
        <Icon name="settings-2" size={16} />
        {!collapsed ? <span className="text-xs">{t('sidebar.settings', 'Settings')}</span> : null}
      </button>
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
  onSetupRequired,
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
              aria-label={t('sidebar.searchTitle', 'Search chats (⌘K)')}
              aria-expanded={showSearch}
              className={`w-9 h-9 flex items-center justify-center rounded-lg border border-border-subtle transition-colors cursor-pointer ${showSearch ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
              title={t('sidebar.searchTitle', 'Search chats (⌘K)')}
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
                aria-label={t('sidebar.search', 'Search recent chats…')}
                placeholder={t('sidebar.search', 'Search recent chats…')}
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

          {/* Recent conversations — ThreadList owns its own scroll container so it
              can virtualize rows without fighting the parent over the
              scroll element reference. */}
          {!collapsed ? <div className="flex min-h-[120px] flex-1 flex-col overflow-hidden px-2 py-2">
            <h2 className="mb-1 px-2 py-1 text-2xs font-semibold uppercase tracking-widest text-text-muted">
              {t('sidebar.recentWork', 'Recent chats')}
            </h2>
            {!collapsed ? (
              <p className="px-2 pb-1 text-2xs leading-snug text-text-muted">
                {t('sidebar.recentWorkHint', 'Quick switch. Objectives and Kanban live under Projects.')}
              </p>
            ) : null}
            <ThreadList onSelect={() => onViewChange('chat')} searchQuery={searchQuery} />
          </div> : <div className="flex-1" />}

          {/* Secondary diagnostics entry. Runtime and MCP state live once in the status bar. */}
          {!collapsed ? <div className="max-h-[28vh] shrink-0 overflow-y-auto border-t border-border-subtle px-2 py-2">
            <SidebarLowerBranding lower={branding?.lower} />
            <button onClick={() => onViewChange('health')}
              aria-current={currentView === 'health' ? 'page' : undefined}
              title={t('sidebar.healthCenter', 'Health Center')}
              className={`sidebar-nav-item mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs transition-colors ${currentView === 'health' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}>
              <Icon name="heart-pulse" size={16} />
              {t('sidebar.healthCenter', 'Health Center')}
            </button>
          </div> : (
            <div className="shrink-0 border-t border-border-subtle px-2 py-2">
              <button onClick={() => onViewChange('health')}
                aria-current={currentView === 'health' ? 'page' : undefined}
                aria-label={t('sidebar.healthCenter', 'Health Center')}
                title={t('sidebar.healthCenter', 'Health Center')}
                className={`sidebar-nav-item sidebar-nav-primary justify-center px-0 ${currentView === 'health' ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}>
                <Icon name="heart-pulse" size={16} />
              </button>
            </div>
          )}

          <SidebarSettingsFooter collapsed={collapsed} showSettings={showSettings} onSettings={() => setShowSettings(true)} />
      </aside>
      {showSettings ? (
        <Suspense fallback={<div className="fixed inset-0 z-[60] grid place-items-center text-xs text-text-muted">{t('settings.loading', 'Loading settings...')}</div>}>
          <SettingsPanel
            onClose={() => setShowSettings(false)}
            onSetupRequired={onSetupRequired}
          />
        </Suspense>
      ) : null}
    </>
  )
}
