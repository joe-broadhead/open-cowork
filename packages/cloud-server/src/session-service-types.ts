import type { CloudAbuseConfig, CloudSessionViewRecord, WorkflowDetail, WorkflowRun } from '@open-cowork/shared'
import type {
  ApiTokenScope,
  BillingSubscriptionRecord,
  ChannelProviderId,
  ControlPlanePermission,
  SessionCommandRecord,
  SessionProjectionRecord,
  SessionRecord,
  UsageEventRecord,
} from './control-plane-store.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { ByokSecretMetadata } from './byok-secret-store.ts'
import type { CloudRuntimePromptPart } from './runtime-adapter.ts'
import type { PublicApiTokenRecord } from './services/api-token-policy.ts'

export type CloudPrincipal = {
  tenantId: string
  tenantName?: string
  userId: string
  email: string
  orgId?: string
  accountId?: string
  role?: 'owner' | 'admin' | 'member'
  // Resolved during ensurePrincipal from the member's effective permission set
  // (custom-role map when assigned, else the built-in role map). Authoritative for
  // permission-based authorization once populated.
  permissions?: ControlPlanePermission[]
  // The custom role assigned to this member, if any. When set, `permissions` is the
  // custom role's map (a possible downgrade of the built-in role).
  customRoleKey?: string | null
  authSource?: 'user' | 'api_token' | 'local' | 'header' | 'worker'
  // Set true when this principal was minted by the enterprise SSO login binding
  // (#895) after a verified IdP assertion. An org with SSO-only enforcement rejects a
  // non-SSO (local / OIDC-end-user) login for its verified domains; an SSO-verified
  // principal bypasses that gate. Absent/false ⇒ authenticated via a non-SSO path.
  ssoVerified?: boolean
  tokenId?: string
  tokenScopes?: ApiTokenScope[]
  workerId?: string
  workerPoolId?: string
  workerCredentialId?: string
  workerScopes?: string[]
}

export type CloudUsageTotalRecord = {
  eventType: string
  unit: string
  quantity: number
}

export type CloudUsageQuotaWindowRecord = {
  quotaKey: string
  label: string
  unit: 'count' | 'byte' | 'minute'
  enabled: boolean
  limit: number | null
  used: number
  remaining: number | null
  windowMs: number
  windowStartedAt: string
  resetAt: string
  policyCode: string
}

export type CloudUsageSummary = {
  enabled: boolean
  generatedAt: string
  totalsScope: 'recent_events'
  eventSampleLimit: number
  events: UsageEventRecord[]
  totals: CloudUsageTotalRecord[]
  quotas: CloudUsageQuotaWindowRecord[]
}

export type CloudDiagnosticsBundle = {
  generatedAt: string
  redaction: 'secrets-redacted'
  org: {
    orgId: string
    tenantId: string
    role: string
    profileName: string
  }
  runtime: {
    role: CloudRuntimePolicy['role']
    profileName: string
    canExecute: boolean
    commandProcessing: 'inline' | 'durable' | 'delegated'
    checkpoints: boolean
    heartbeatCount: number
    heartbeats: Array<{
      workerId: string
      role: string
      activeSessionCount: number
      lastSeenAt: string
      ageMs: number
      stale: boolean
    }>
  }
  billing: {
    enabled: boolean
    mode: 'disabled' | 'self-host' | 'managed'
    providerId: string
    subscription: BillingSubscriptionRecord | null
    entitlements: Record<string, unknown>
    active: boolean
    plans: Array<{
      planKey: string
      label: string
      default: boolean
      entitlements: Record<string, unknown>
    }>
  }
  byok: {
    configuredProviders: number
    providers: ByokSecretMetadata[]
  }
  usage: CloudUsageSummary
  gateway: {
    agents: {
      total: number
      active: number
      disabled: number
    }
    bindingsByProvider: Record<string, number>
    deliveriesByStatus: Record<string, number>
    deliveriesByStatusScope: 'recent_deliveries'
    deliverySampleLimit: number
  }
  links: {
    deploymentDocs: string
    managedByokRunbook: string
  }
}

export type IssuedPublicApiTokenRecord = {
  token: PublicApiTokenRecord
  plaintext: string
}

export type CloudSessionView = CloudSessionViewRecord<SessionRecord> & {
  projection: SessionProjectionRecord | null
}

export type CreateCloudSessionRecordInput = {
  tenantId: string
  userId: string
  orgId?: string | null
  accountId?: string | null
  profileName: string
  sessionId?: string | null
  title?: string | null
  deferRuntime?: boolean
}

export type CloudWorkflowStartResult = {
  tenantId: string
  workflow: WorkflowDetail
  run: WorkflowRun
  sessionId: string
  command: SessionCommandRecord
}

export type ChannelActorInput = {
  identityId?: string | null
  provider?: ChannelProviderId | null
  externalWorkspaceId?: string | null
  externalUserId?: string | null
}

export type ChannelInteractionResolutionInput = ChannelActorInput & {
  token?: string | null
  externalInteractionId?: string | null
  response?: unknown
  answers?: unknown[]
  reject?: boolean
}

export const SESSION_IMPORT_MAX_MESSAGES = 2_000
export const HOUR_MS = 60 * 60 * 1000

export const DISABLED_ABUSE_POLICY: CloudAbuseConfig = {
  enabled: false,
  maxConcurrentSessionsPerOrg: null,
  maxConcurrentWorkflowRunsPerOrg: null,
  maxActiveWorkersPerOrg: null,
  maxQueuedCommandsPerOrg: null,
  maxQueueAgeMs: null,
  maxPromptsPerHour: null,
  maxWorkflowRunsPerHour: null,
  maxGatewayPromptsPerHour: null,
  maxWorkerMinutesPerHour: null,
  maxGatewayDeliveriesPerHour: null,
  maxGatewayChannelBindingsPerOrg: null,
  maxArtifactBytesPerDay: null,
  httpRateLimit: {
    enabled: false,
    windowMs: 60 * 1000,
    maxRequests: 600,
  },
  authBackoff: {
    enabled: false,
    windowMs: 60 * 1000,
    maxFailures: 10,
    backoffMs: 60 * 1000,
  },
}

export function promptParts(text: string): CloudRuntimePromptPart[] {
  return [{ type: 'text', text }]
}

export function importAuditActor(principal: CloudPrincipal): { actorType: 'user' | 'api_token', actorId: string, accountId: string | null } {
  return {
    actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
    actorId: principal.tokenId || principal.userId,
    accountId: principal.accountId || principal.userId,
  }
}
