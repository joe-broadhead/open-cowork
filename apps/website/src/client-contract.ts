import type { PublicBrandingConfig } from '@open-cowork/shared'
import type { CloudWebAdminSurfaceEntry } from './admin-surface-matrix.ts'
import type { CloudWebRoute, CloudWebRouteId } from './app-shell.ts'
import type { CloudWebRouteApiMatrixEntry } from './route-api-matrix.ts'
import type { CloudWebWorkbenchParityEntry } from './workbench-parity.ts'

export type CloudWebEndpointId =
  | 'authMe'
  | 'config'
  | 'workspace'
  | 'byok'
  | 'byokSave'
  | 'byokValidate'
  | 'byokDisable'
  | 'apiTokens'
  | 'apiTokenCreate'
  | 'apiTokenRevoke'
  | 'channelAgents'
  | 'channelAgentCreate'
  | 'channelBindings'
  | 'channelBindingCreate'
  | 'billingSubscription'
  | 'billingCheckout'
  | 'billingPortal'
  | 'usageEvents'
  | 'usageSummary'
  | 'diagnostics'
  | 'runtimeStatus'
  | 'workerHeartbeats'
  | 'sessions'
  | 'sessionView'
  | 'sessionEvents'
  | 'sessionPrompt'
  | 'sessionPermissionRespond'
  | 'sessionQuestionReply'
  | 'sessionQuestionReject'
  | 'sessionArtifacts'
  | 'sessionArtifact'
  | 'capabilitiesCatalog'
  | 'capabilityTools'
  | 'capabilitySkills'
  | 'workflows'
  | 'workflow'
  | 'workflowRun'
  | 'workflowPause'
  | 'workflowResume'
  | 'workflowArchive'
  | 'projectSourceValidate'
  | 'projectSnapshots'
  | 'adminPolicy'
  | 'adminMembers'
  | 'adminMemberInvite'
  | 'adminMemberUpdate'
  | 'adminAudit'
  | 'adminWorkerPools'
  | 'adminWorkers'
  | 'adminWorkerHeartbeats'
  | 'channelDeliveries'
  | 'channelDeliveryRetry'
  | 'channelDeliveryDeadLetter'

export type CloudWebEndpoint = {
  id: CloudWebEndpointId
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  csrf: boolean
}

export type CloudWebClientBootstrap = {
  role: string
  profileName: string
  features: Record<string, boolean>
  publicBranding: PublicBrandingConfig
  theme?: {
    defaultPreset: string
    defaultScheme?: 'dark' | 'light'
    defaultAccent?: string
    tenantBrandingLocked: boolean
    presets: Array<{
      id: string
      label: string
      description: string
      swatches: string[]
    }>
    accents?: Array<{
      id: string
      label: string
      accent: string
      accent2: string
    }>
  }
  routes: CloudWebRoute[]
  defaultRoute: string
  api: CloudWebEndpoint[]
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
    agents: unknown[]
    bindings: unknown[]
    deliveries: unknown[]
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

export const CLOUD_WEB_CLIENT_ENDPOINTS: CloudWebEndpoint[] = [
  {
    id: 'authMe',
    method: 'GET',
    path: '/auth/me',
    csrf: false,
  },
  {
    id: 'config',
    method: 'GET',
    path: '/api/config',
    csrf: false,
  },
  {
    id: 'workspace',
    method: 'GET',
    path: '/api/workspace',
    csrf: false,
  },
  {
    id: 'byok',
    method: 'GET',
    path: '/api/byok',
    csrf: false,
  },
  {
    id: 'byokSave',
    method: 'POST',
    path: '/api/byok/:providerId',
    csrf: true,
  },
  {
    id: 'byokValidate',
    method: 'POST',
    path: '/api/byok/:providerId/validate',
    csrf: true,
  },
  {
    id: 'byokDisable',
    method: 'DELETE',
    path: '/api/byok/:providerId',
    csrf: true,
  },
  {
    id: 'apiTokens',
    method: 'GET',
    path: '/api/api-tokens?limit=100',
    csrf: false,
  },
  {
    id: 'apiTokenCreate',
    method: 'POST',
    path: '/api/api-tokens',
    csrf: true,
  },
  {
    id: 'apiTokenRevoke',
    method: 'DELETE',
    path: '/api/api-tokens/:tokenId',
    csrf: true,
  },
  {
    id: 'channelAgents',
    method: 'GET',
    path: '/api/channels/agents?limit=100',
    csrf: false,
  },
  {
    id: 'channelAgentCreate',
    method: 'POST',
    path: '/api/channels/agents',
    csrf: true,
  },
  {
    id: 'channelBindings',
    method: 'GET',
    path: '/api/channels/bindings?limit=100',
    csrf: false,
  },
  {
    id: 'channelBindingCreate',
    method: 'POST',
    path: '/api/channels/bindings',
    csrf: true,
  },
  {
    id: 'channelDeliveries',
    method: 'GET',
    path: '/api/channels/deliveries?limit=50',
    csrf: false,
  },
  {
    id: 'channelDeliveryRetry',
    method: 'POST',
    path: '/api/channels/deliveries/:deliveryId/retry',
    csrf: true,
  },
  {
    id: 'channelDeliveryDeadLetter',
    method: 'POST',
    path: '/api/channels/deliveries/:deliveryId/dead-letter',
    csrf: true,
  },
  {
    id: 'billingSubscription',
    method: 'GET',
    path: '/api/billing/subscription',
    csrf: false,
  },
  {
    id: 'billingCheckout',
    method: 'POST',
    path: '/api/billing/checkout',
    csrf: true,
  },
  {
    id: 'billingPortal',
    method: 'POST',
    path: '/api/billing/portal',
    csrf: true,
  },
  {
    id: 'usageEvents',
    method: 'GET',
    path: '/api/usage/events?limit=20',
    csrf: false,
  },
  {
    id: 'usageSummary',
    method: 'GET',
    path: '/api/usage/summary?limit=100',
    csrf: false,
  },
  {
    id: 'diagnostics',
    method: 'GET',
    path: '/api/diagnostics',
    csrf: false,
  },
  {
    id: 'runtimeStatus',
    method: 'GET',
    path: '/api/runtime/status',
    csrf: false,
  },
  {
    id: 'workerHeartbeats',
    method: 'GET',
    path: '/api/workers/heartbeats',
    csrf: false,
  },
  {
    id: 'sessions',
    method: 'GET',
    path: '/api/sessions',
    csrf: false,
  },
  {
    id: 'sessionView',
    method: 'GET',
    path: '/api/sessions/:sessionId/view',
    csrf: false,
  },
  {
    id: 'sessionEvents',
    method: 'GET',
    path: '/api/sessions/:sessionId/events',
    csrf: false,
  },
  {
    id: 'sessionPrompt',
    method: 'POST',
    path: '/api/sessions/:sessionId/prompt',
    csrf: true,
  },
  {
    id: 'sessionPermissionRespond',
    method: 'POST',
    path: '/api/sessions/:sessionId/permission-respond',
    csrf: true,
  },
  {
    id: 'sessionQuestionReply',
    method: 'POST',
    path: '/api/sessions/:sessionId/question-reply',
    csrf: true,
  },
  {
    id: 'sessionQuestionReject',
    method: 'POST',
    path: '/api/sessions/:sessionId/question-reject',
    csrf: true,
  },
  {
    id: 'sessionArtifacts',
    method: 'GET',
    path: '/api/sessions/:sessionId/artifacts',
    csrf: false,
  },
  {
    id: 'sessionArtifact',
    method: 'GET',
    path: '/api/sessions/:sessionId/artifacts/:artifactId',
    csrf: false,
  },
  {
    id: 'capabilitiesCatalog',
    method: 'GET',
    path: '/api/capabilities',
    csrf: false,
  },
  {
    id: 'capabilityTools',
    method: 'GET',
    path: '/api/capabilities/tools',
    csrf: false,
  },
  {
    id: 'capabilitySkills',
    method: 'GET',
    path: '/api/capabilities/skills',
    csrf: false,
  },
  {
    id: 'workflows',
    method: 'GET',
    path: '/api/workflows?limit=100',
    csrf: false,
  },
  {
    id: 'workflow',
    method: 'GET',
    path: '/api/workflows/:workflowId',
    csrf: false,
  },
  {
    id: 'workflowRun',
    method: 'POST',
    path: '/api/workflows/:workflowId/run',
    csrf: true,
  },
  {
    id: 'workflowPause',
    method: 'POST',
    path: '/api/workflows/:workflowId/pause',
    csrf: true,
  },
  {
    id: 'workflowResume',
    method: 'POST',
    path: '/api/workflows/:workflowId/resume',
    csrf: true,
  },
  {
    id: 'workflowArchive',
    method: 'POST',
    path: '/api/workflows/:workflowId/archive',
    csrf: true,
  },
  {
    id: 'projectSourceValidate',
    method: 'POST',
    path: '/api/project-sources/validate',
    csrf: true,
  },
  {
    id: 'projectSnapshots',
    method: 'POST',
    path: '/api/project-sources/snapshots',
    csrf: true,
  },
  {
    id: 'adminPolicy',
    method: 'GET',
    path: '/api/admin/policy',
    csrf: false,
  },
  {
    id: 'adminMembers',
    method: 'GET',
    path: '/api/admin/members?limit=100',
    csrf: false,
  },
  {
    id: 'adminMemberInvite',
    method: 'POST',
    path: '/api/admin/members',
    csrf: true,
  },
  {
    id: 'adminMemberUpdate',
    method: 'POST',
    path: '/api/admin/members/:accountId/update',
    csrf: true,
  },
  {
    id: 'adminAudit',
    method: 'GET',
    path: '/api/admin/audit?limit=100',
    csrf: false,
  },
  {
    id: 'adminWorkerPools',
    method: 'GET',
    path: '/api/admin/worker-pools?limit=100',
    csrf: false,
  },
  {
    id: 'adminWorkers',
    method: 'GET',
    path: '/api/admin/workers?limit=100',
    csrf: false,
  },
  {
    id: 'adminWorkerHeartbeats',
    method: 'GET',
    path: '/api/admin/workers/:workerId/heartbeats?limit=50',
    csrf: false,
  },
]
