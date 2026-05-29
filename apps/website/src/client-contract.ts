import type { PublicBrandingConfig } from '@open-cowork/shared'
import type { CloudWebRoute, CloudWebRouteId } from './app-shell.ts'

export type CloudWebEndpointId =
  | 'authMe'
  | 'config'
  | 'workspace'
  | 'byok'
  | 'apiTokens'
  | 'channelAgents'
  | 'channelBindings'
  | 'billingSubscription'
  | 'usageEvents'
  | 'sessions'
  | 'sessionView'
  | 'sessionEvents'
  | 'sessionPrompt'
  | 'sessionPermissionRespond'
  | 'sessionQuestionReply'
  | 'sessionQuestionReject'
  | 'sessionArtifacts'
  | 'sessionArtifact'
  | 'projectSourceValidate'
  | 'projectSnapshots'

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
  routes: CloudWebRoute[]
  defaultRoute: string
  api: CloudWebEndpoint[]
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
  sessions: unknown[]
  sessionViews: Record<string, unknown>
  runtimeActions: Record<string, boolean>
  artifactPanel: {
    sessionId: string | null
    artifactId: string | null
    metadata: Record<string, unknown> | null
    status: 'idle' | 'loading' | 'error'
    error: string | null
  }
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
    id: 'apiTokens',
    method: 'GET',
    path: '/api/api-tokens',
    csrf: false,
  },
  {
    id: 'channelAgents',
    method: 'GET',
    path: '/api/channels/agents',
    csrf: false,
  },
  {
    id: 'channelBindings',
    method: 'GET',
    path: '/api/channels/bindings',
    csrf: false,
  },
  {
    id: 'billingSubscription',
    method: 'GET',
    path: '/api/billing/subscription',
    csrf: false,
  },
  {
    id: 'usageEvents',
    method: 'GET',
    path: '/api/usage/events?limit=20',
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
]
