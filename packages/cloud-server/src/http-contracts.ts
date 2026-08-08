import type { IncomingMessage } from 'node:http'

import type {
  KnowledgeStore,
  PublicBrandingConfig,
} from '@open-cowork/shared'
import type { WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import type { CloudArtifactService } from './artifact-service.ts'
import type { CompiledCloudRuntimeCapabilityPolicy } from './cloud-runtime-capability-policy.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import type { CloudReadinessReport } from './readiness.ts'
import type { CloudProgressWatchdogSnapshot } from './progress-watchdog.ts'
import type {
  CloudCookieSession,
  CloudSessionCookieManager,
} from './session-cookie-auth.ts'
import type {
  CloudPrincipal,
  CloudSessionService,
} from './session-service.ts'
import type {
  CloudSseReplayHub,
  CloudSseStreamRegistry,
} from './sse-replay.ts'
import type { CloudWorker } from './worker.ts'

export type CloudAuthResolver = (
  req: IncomingMessage,
) => Promise<CloudPrincipal> | CloudPrincipal

export type CloudBrowserAuthRedirect = {
  location: string
  setCookieHeaders?: string[]
}

export type CloudBrowserAuthCallback = {
  principal: CloudPrincipal
  redirectTo: string
  setCookieHeaders?: string[]
}

export type CloudBrowserAuthProvider = {
  isCallbackPath(pathname: string): boolean
  login(
    req: IncomingMessage,
    url: URL,
  ): Promise<CloudBrowserAuthRedirect> | CloudBrowserAuthRedirect
  callback(
    req: IncomingMessage,
    url: URL,
  ): Promise<CloudBrowserAuthCallback> | CloudBrowserAuthCallback
}

export type CloudDesktopAuthConfig = {
  mode: 'oidc'
  issuerUrl: string
  clientId: string
  scope: string
}

export type CloudHttpServerOptions = {
  service: CloudSessionService
  artifacts?: CloudArtifactService | null
  policy: CloudRuntimePolicy
  publicBranding?: PublicBrandingConfig | null
  auth?: CloudAuthResolver
  browserAuth?: CloudBrowserAuthProvider | null
  desktopAuth?: CloudDesktopAuthConfig | null
  worker?: CloudWorker | null
  webhookSecurity?: WorkflowWebhookSecurityStore | null
  internalToken?: string | null
  sessionCookies?: CloudSessionCookieManager | null
  observability?: CloudObservabilityAdapter | null
  autoProcessCommands?: boolean
  corsOrigin?: string | null
  strictTransportSecurity?: boolean
  maxBodyBytes?: number
  ssePollMs?: number
  // Connection caps are resolved and validated by cloud bootstrap before they
  // reach the HTTP layer. Undefined values use the documented server defaults.
  maxSseConnectionsPerOrg?: number
  maxConnections?: number
  sseReplayHub?: CloudSseReplayHub
  sseStreamRegistry?: CloudSseStreamRegistry
  trustProxyHeaders?: boolean
  trustedProxyCidrs?: readonly string[] | null
  readiness?: () => Promise<CloudReadinessReport> | CloudReadinessReport
  progress?: () => Promise<CloudProgressWatchdogSnapshot> | CloudProgressWatchdogSnapshot
  knowledgeDataDir?: string | null
  /**
   * Backend for cloud knowledge wiki reads/writes. When omitted, the server
   * falls back to a SQLite store rooted at knowledgeDataDir. Cloud app
   * composition injects Postgres when the control plane is durable.
   */
  knowledgeStore?: KnowledgeStore
  /**
   * Signing secret for tenant-scoped knowledge-agent proposal tokens. The
   * public proposal route fails closed when this value is omitted.
   */
  knowledgeAgentTokenSecret?: string | null
  /** Effective SDK-native ceiling, rechecked per request and fail-closed when omitted. */
  runtimeCapabilityPolicy?: CompiledCloudRuntimeCapabilityPolicy | null
}

export type CloudHttpRouteContext = {
  principal: CloudPrincipal
  authSource: 'cookie' | 'resolver'
  cookieSession: CloudCookieSession | null
  url: URL
  segments: string[]
}

export class CloudHttpError extends Error {
  readonly status: number
  readonly publicMessage: string
  readonly policyCode: string | null
  readonly retryAfterMs: number | null

  constructor(status: number, message: string, details: {
    policyCode?: string | null
    retryAfterMs?: number | null
  } = {}) {
    super(message)
    this.status = status
    this.publicMessage = message
    this.policyCode = details.policyCode || null
    this.retryAfterMs = details.retryAfterMs || null
  }
}
