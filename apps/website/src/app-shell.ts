import { cloudWebAdminRouteSummary } from './admin-surface-matrix.ts'
import { cloudWebWorkbenchRouteSummary } from './workbench-parity.ts'

export type CloudWebSurface = 'workbench' | 'admin'

export type CloudWebRouteId =
  | 'threads'
  | 'chat'
  | 'agents'
  | 'capabilities'
  | 'workflows'
  | 'artifacts'
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
  id: CloudWebSurface
  label: string
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
    id: 'agents',
    label: 'Coworkers',
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
    id: 'artifacts',
    label: 'Artifacts',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: cloudWebWorkbenchRouteSummary('artifacts', 'Cloud artifact metadata and downloads.'),
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
    id: 'workbench',
    label: 'Studio',
    routes: CLOUD_WEB_ROUTES.filter((route) => route.surface === 'workbench'),
  },
  {
    id: 'admin',
    label: 'Admin',
    routes: CLOUD_WEB_ROUTES.filter((route) => route.surface === 'admin'),
  },
]

export function findCloudWebRoute(routeId: string | null | undefined) {
  return CLOUD_WEB_ROUTES.find((route) => route.id === routeId) || null
}

export function cloudWebRoutesForSurface(surface: CloudWebSurface) {
  return CLOUD_WEB_ROUTES.filter((route) => route.surface === surface)
}
