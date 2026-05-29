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

export const DEFAULT_CLOUD_WEB_ROUTE: CloudWebRouteId = 'threads'

export const CLOUD_WEB_ROUTES: CloudWebRoute[] = [
  {
    id: 'threads',
    label: 'Threads',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: 'Cloud threads from web, desktop, and gateway.',
  },
  {
    id: 'chat',
    label: 'Chat',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: 'Selected cloud session timeline and composer.',
  },
  {
    id: 'agents',
    label: 'Agents',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: 'Profile-allowed agents and runtime capability status.',
  },
  {
    id: 'capabilities',
    label: 'Tools & Skills',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: 'Allowed tools, skills, and MCP capability verdicts.',
  },
  {
    id: 'workflows',
    label: 'Workflows',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: 'Workflow definitions, runs, and status.',
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    surface: 'workbench',
    requiresAuth: true,
    requiresAdmin: false,
    summary: 'Cloud artifact metadata and downloads.',
  },
  {
    id: 'org',
    label: 'Org',
    surface: 'admin',
    requiresAuth: false,
    requiresAdmin: false,
    summary: 'Organization profile, role, and deployment policy.',
  },
  {
    id: 'members',
    label: 'Members',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: 'Member, invite, and role administration.',
  },
  {
    id: 'policy',
    label: 'Profiles & Policy',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: false,
    summary: 'Runtime profile and feature verdicts.',
  },
  {
    id: 'byok',
    label: 'BYOK',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: 'Write-only provider key status and rotation.',
  },
  {
    id: 'connections',
    label: 'Connections',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: 'Scoped API tokens for desktop and gateway clients.',
  },
  {
    id: 'billing',
    label: 'Billing',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: 'Subscription and entitlement state.',
  },
  {
    id: 'gateway',
    label: 'Gateway',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: 'Headless agents and channel bindings.',
  },
  {
    id: 'audit',
    label: 'Audit',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: 'Redacted audit events for sensitive actions.',
  },
  {
    id: 'usage',
    label: 'Usage',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: false,
    summary: 'Recent metering and quota events.',
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    surface: 'admin',
    requiresAuth: true,
    requiresAdmin: true,
    summary: 'Redacted health and support data.',
  },
]

export const CLOUD_WEB_ROUTE_GROUPS: CloudWebRouteGroup[] = [
  {
    id: 'workbench',
    label: 'Workbench',
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
