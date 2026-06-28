export type AppView =
  | 'home'
  | 'chat'
  | 'projects'
  | 'knowledge'
  | 'approvals'
  | 'playbooks'
  | 'team'
  | 'channels'
  | 'tools'
  | 'artifacts'
  | 'health'
  | 'ui-primitives'

export type LegacyAppView = 'threads' | 'workflows' | 'agents' | 'capabilities'

export type AppNavigationTarget = AppView | LegacyAppView | 'settings'

const APP_VIEWS: readonly AppView[] = [
  'home',
  'chat',
  'projects',
  'knowledge',
  'approvals',
  'playbooks',
  'team',
  'channels',
  'tools',
  'artifacts',
  'health',
  'ui-primitives',
]

const APP_VIEW_SET = new Set<string>(APP_VIEWS)

const LEGACY_VIEW_ALIASES: Record<LegacyAppView, AppView> = {
  threads: 'projects',
  workflows: 'playbooks',
  agents: 'team',
  capabilities: 'tools',
}

export function normalizeAppView(view: AppNavigationTarget | string): AppView | 'settings' | null {
  if (view === 'settings') return view
  if (view in LEGACY_VIEW_ALIASES) return LEGACY_VIEW_ALIASES[view as LegacyAppView]
  if (APP_VIEW_SET.has(view)) return view as AppView
  return null
}
