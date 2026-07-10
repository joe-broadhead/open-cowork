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
  | 'admin'
  | 'ui-primitives'

export type AppNavigationTarget = AppView | 'settings'

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
  'admin',
  'ui-primitives',
]

const APP_VIEW_SET = new Set<string>(APP_VIEWS)

export function normalizeAppView(view: AppNavigationTarget | string): AppView | 'settings' | null {
  if (view === 'settings') return view
  if (APP_VIEW_SET.has(view)) return view as AppView
  return null
}
