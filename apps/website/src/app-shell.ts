import { cloudWebAdminRouteSummary } from './admin-surface-matrix.ts'
import { cloudWebWorkbenchRouteSummary } from './workbench-parity.ts'

export type CloudWebSurface = 'workbench' | 'admin'

export type CloudWebRouteId =
  | 'threads'
  | 'chat'
  | 'knowledge'
  | 'approvals'
  | 'agents'
  | 'capabilities'
  | 'workflows'
  | 'channels'
  | 'artifacts'
  | 'settings'
  | 'org'
  | 'members'
  | 'policy'
  | 'byok'
  | 'connections'
  | 'billing'
  | 'gateway'
  | 'audit'
  | 'usage'
  | 'diagnostics'

export type CloudWebRoute = {
  id: CloudWebRouteId
  label: string
  surface: CloudWebSurface
  requiresAuth: boolean
  requiresAdmin: boolean
  summary: string
}

export type CloudWebRouteGroup = {
  id: 'studio' | 'manage' | 'admin'
  label: string
  collapsible?: boolean
  routes: CloudWebRoute[]
}

export const DEFAULT_CLOUD_WEB_ROUTE: CloudWebRouteId = 'chat'

export const CLOUD_WEB_ROUTES: CloudWebRoute[] = [
  {
    id: 'chat',
    label: 'Home',
    surface: 'workbench',
    requiresAuth: false,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('chat', 'Start or continue a Cloud chat.'),
  },
  {
    id: 'threads',
    label: 'Projects',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('threads', 'Recent chats and project-backed Cloud work.'),
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('knowledge', 'Versioned Spaces, proposals, review, and graph context.'),
  },
  {
    id: 'approvals',
    label: 'Approvals',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('approvals', 'Pending permission requests and questions across Cloud chats.'),
  },
  {
    id: 'agents',
    label: 'Team',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('agents', 'Profile-allowed coworkers and runtime capability status.'),
  },
  {
    id: 'capabilities',
    label: 'Tools & Skills',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('capabilities', 'Allowed tools, skills, and MCP capability verdicts.'),
  },
  {
    id: 'workflows',
    label: 'Playbooks',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('workflows', 'Saved playbooks, runs, and status.'),
  },
  {
    id: 'channels',
    label: 'Channels',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('channels', 'Connected chat channels and delivery status.'),
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('artifacts', 'Cloud artifact metadata and downloads.'),
  },
  {
    id: 'settings',
    label: 'Settings',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('settings', 'User appearance, notifications, privacy, and cloud profile status.'),
  },
  {
    id: 'org',
    label: 'Org',
    surface: 'admin',
    requiresAuth: false,
    requiresAdmin: false,
    summary: cloudWebAdminRouteSummary('org', 'Organization profile, role, and deployment policy.'),
  },
  {
    id: 'members',
    label: 'Members',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: cloudWebAdminRouteSummary('members', 'Member, invite, and role administration.'),
  },
  {
    id: 'policy',
    label: 'Profiles & Policy',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebAdminRouteSummary('policy', 'Runtime profile and feature verdicts.'),
  },
  {
    id: 'byok',
    label: 'BYOK',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: cloudWebAdminRouteSummary('byok', 'Write-only provider key status and rotation.'),
  },
  {
    id: 'connections',
    label: 'Connections',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: cloudWebAdminRouteSummary('connections', 'Scoped API tokens for desktop and gateway clients.'),
  },
  {
    id: 'billing',
    label: 'Billing',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: cloudWebAdminRouteSummary('billing', 'Subscription and entitlement state.'),
  },
  {
    id: 'gateway',
    label: 'Gateway',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: cloudWebAdminRouteSummary('gateway', 'Headless agents and channel bindings.'),
  },
  {
    id: 'audit',
    label: 'Audit',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: cloudWebAdminRouteSummary('audit', 'Redacted audit events for sensitive actions.'),
  },
  {
    id: 'usage',
    label: 'Usage',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebAdminRouteSummary('usage', 'Recent metering and quota events.'),
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: cloudWebAdminRouteSummary('diagnostics', 'Redacted health and support data.'),
  },
]

export const CLOUD_WEB_ROUTE_GROUPS: CloudWebRouteGroup[] = [
  {
    id: 'studio',
    label: 'Studio',
    routes: CLOUD_WEB_ROUTES.filter((route) => route.id === 'chat' || route.id === 'threads' || route.id === 'knowledge' || route.id === 'approvals'),
  },
  {
    id: 'manage',
    label: 'Manage',
    collapsible: true,
    routes: CLOUD_WEB_ROUTES.filter((route) => route.id === 'agents' || route.id === 'workflows' || route.id === 'channels' || route.id === 'capabilities' || route.id === 'artifacts' || route.id === 'settings'),
  },
  {
    id: 'admin',
    label: 'Admin',
    collapsible: true,
    routes: CLOUD_WEB_ROUTES.filter((route) => route.surface === 'admin'),
  },
]

export function findCloudWebRoute(routeId: string | null | undefined) {
  return CLOUD_WEB_ROUTES.find((route) => route.id === routeId) || null
}

export function cloudWebRoutesForSurface(surface: CloudWebSurface) {
  return CLOUD_WEB_ROUTES.filter((route) => route.surface === surface)
}
