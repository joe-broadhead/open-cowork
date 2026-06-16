import type { PublicBrandingConfig } from '@open-cowork/shared'
import type { CloudWebAdminSurfaceEntry } from './admin-surface-matrix.ts'
import type { CloudWebRoute, CloudWebRouteId } from './app-shell.ts'
import type { CloudWebEndpoint as CloudWebEndpointContract } from './client-endpoints.ts'
import type { CloudWebRouteApiMatrixEntry } from './route-api-matrix.ts'
import type { CloudWebWorkbenchParityEntry } from './workbench-parity.ts'

export { CLOUD_WEB_CLIENT_ENDPOINTS } from './client-endpoints.ts'
export type { CloudWebEndpoint, CloudWebEndpointId } from './client-endpoints.ts'

export type CloudWebClientBootstrap = {
  role: string
  profileName: string
  features: Record<string, boolean>
  publicBranding: PublicBrandingConfig
  theme?: {
    defaultPreset: string
    defaultScheme?: 'dark' | 'light'
    defaultAccent?: string
    defaultDensity?: 'compact' | 'regular' | 'comfy'
    tenantBrandingLocked: boolean
    accents?: Array<{
      id: string
      label: string
      accent: string
      accent2: string
    }>
  }
  routes: CloudWebRoute[]
  defaultRoute: string
  api: CloudWebEndpointContract[]
  routeMatrix: CloudWebRouteApiMatrixEntry[]
  adminSurfaces: CloudWebAdminSurfaceEntry[]
  workbenchParity: CloudWebWorkbenchParityEntry[]
  sessionEventTypes: string[]
}

export type CloudWebAuthStatus = 'loading' | 'signed-out' | 'signed-in'
export type CloudWebConnectionStatus = 'idle' | 'connecting' | 'open' | 'retrying' | 'closed' | 'error'

export type CloudWebClientStateContract = {
  authStatus: CloudWebAuthStatus
  activeRoute: CloudWebRouteId
  workspace: unknown | null
  csrfToken: string | null
  selectedSessionId: string | null
  sessionSelectionGeneration: number
  sessions: unknown[]
  sessionList: {
    nextCursor: string | null
    hasMore: boolean
    isLoading: boolean
    isLoadingMore: boolean
    lastSyncedAt: string | null
    totalEstimate: number | null
    error: string | null
  }
  sessionViews: Record<string, unknown>
  runtimeActions: Record<string, boolean>
  artifactPanel: {
    sessionId: string | null
    artifactId: string | null
    metadata: Record<string, unknown> | null
    status: 'idle' | 'loading' | 'error'
    error: string | null
  }
  capabilities: {
    tools: unknown[]
    skills: unknown[]
    error: string | null
  }
  workflows: {
    workflows: unknown[]
    runs: unknown[]
    error: string | null
  }
  channels: {
    providers: unknown[]
    agents: unknown[]
    bindings: unknown[]
    people: unknown[]
    deliveries: unknown[]
    watches: unknown[]
    error: string | null
  }
  usageSummary: unknown | null
  deliveries: unknown[]
  diagnostics: unknown | null
  diagnosticsError: string | null
  admin: {
    policy: unknown | null
    members: unknown[]
    workerPools: unknown[]
    workers: unknown[]
    auditEvents: unknown[]
    error: string | null
    workerError: string | null
  }
  selectedWorkflowId: string | null
  workspaceEvents: {
    status: CloudWebConnectionStatus
    cursor: number
    error: string | null
  }
  sessionEvents: {
    status: CloudWebConnectionStatus
    sessionId: string | null
    cursor: number
    error: string | null
  }
}
