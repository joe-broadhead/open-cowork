import type { CloudWebRouteId, CloudWebSurface } from './app-shell.ts'
import type { CloudWebEndpointId } from './client-contract.ts'

export type CloudWebRouteRequiredRole = 'public' | 'member' | 'admin' | 'operator'

export type CloudWebRouteApiMatrixEntry = {
  routeId: CloudWebRouteId
  surface: CloudWebSurface
  requiredRole: CloudWebRouteRequiredRole
  endpointIds: CloudWebEndpointId[]
  states: {
    loading: string
    empty: string
    error: string
  }
  disabledBehavior: string
  pagination: string
  redaction: string
  tests: string[]
}

export const CLOUD_WEB_ROUTE_API_MATRIX: CloudWebRouteApiMatrixEntry[] = [
  {
    routeId: 'threads',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['sessions', 'sessionView', 'projectSourceValidate', 'projectSnapshots'],
    states: {
      loading: 'Thread list renders an empty table until /api/sessions returns.',
      empty: 'No cloud threads loaded.',
      error: 'Policy, quota, billing, and project-source denials render through the global status.',
    },
    disabledBehavior: 'Create controls are disabled when chat is unavailable or the user is signed out.',
    pagination: 'Browser page size is bounded by CLOUD_WEB_THREAD_PAGE_SIZE with Load more for local rendering; backend pagination is deferred until the sessions API exposes cursors.',
    redaction: 'Local host paths and local MCP process details are never accepted as cloud thread context.',
    tests: ['render.test.ts', 'browser-e2e.test.ts', 'performance.test.ts'],
  },
  {
    routeId: 'chat',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['sessionView', 'sessionEvents', 'sessionPrompt', 'sessionPermissionRespond', 'sessionQuestionReply', 'sessionQuestionReject'],
    states: {
      loading: 'Selected session timeline hydrates from /api/sessions/:sessionId/view before SSE.',
      empty: 'No thread selected.',
      error: 'Composer and runtime action errors render stable policy/quota/billing messages.',
    },
    disabledBehavior: 'Composer is disabled until a cloud session is selected and chat policy is enabled.',
    pagination: 'Session SSE resumes from the durable projection sequence; no browser-only projection model exists.',
    redaction: 'Runtime details are rendered from Cloud projections and sanitized before browser display.',
    tests: ['browser-e2e.test.ts', 'render.test.ts', 'cloud-continuation-e2e.test.ts'],
  },
  {
    routeId: 'agents',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['workspace', 'capabilitiesCatalog'],
    states: {
      loading: 'Agent list derives from workspace policy and capability metadata.',
      empty: 'No agents loaded.',
      error: 'Capability policy errors render as unavailable surface notes.',
    },
    disabledBehavior: 'Refresh is disabled when agent/skill/MCP features are disabled by profile policy.',
    pagination: 'Capability filtering is local and performance-tested against hundreds of entries.',
    redaction: 'Custom content is metadata-only; machine-local MCP commands and secrets are not exposed.',
    tests: ['render.test.ts', 'performance.test.ts'],
  },
  {
    routeId: 'capabilities',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['capabilitiesCatalog', 'capabilityTools', 'capabilitySkills'],
    states: {
      loading: 'Tools and skills render empty lists until capability metadata returns.',
      empty: 'No tools loaded / No skills loaded.',
      error: 'Profile-disabled capabilities show explicit unavailable-surface notes.',
    },
    disabledBehavior: 'Controls are disabled when all capability surfaces are policy-disabled.',
    pagination: 'Local filtering is bounded and covered by performance tests; API cursoring is deferred.',
    redaction: 'Machine-scoped MCPs are displayed as policy-limited metadata, not executable local commands.',
    tests: ['render.test.ts', 'performance.test.ts'],
  },
  {
    routeId: 'workflows',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['workflows', 'workflow', 'workflowRun', 'workflowPause', 'workflowResume', 'workflowArchive'],
    states: {
      loading: 'Workflow tables render empty rows until /api/workflows returns.',
      empty: 'No workflows loaded.',
      error: 'Disabled workflow policy and action failures render through the workflow panel/status.',
    },
    disabledBehavior: 'Workflow create/run controls are disabled when workflows are disabled by profile policy.',
    pagination: 'The route consumes the current workflow summary payload; run-history cursoring is deferred.',
    redaction: 'Workflow rows expose cloud metadata only, never worker credentials or local paths.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'artifacts',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['sessionArtifacts', 'sessionArtifact'],
    states: {
      loading: 'Artifact inspector starts idle until a selected session artifact is inspected.',
      empty: 'No artifacts loaded.',
      error: 'Artifact metadata/download errors stay in the artifact panel.',
    },
    disabledBehavior: 'Artifact body fetches happen only from explicit Inspect/Download actions.',
    pagination: 'Selected-session artifact lists use the cloud artifact API; cross-session artifact browsing is deferred.',
    redaction: 'Signed URLs, object keys, buckets, tokens, and raw object-store internals are stripped from metadata.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'org',
    surface: 'admin',
    requiredRole: 'public',
    endpointIds: ['authMe', 'config', 'workspace'],
    states: {
      loading: 'Org route is the signed-out and bootstrap fallback while auth resolves.',
      empty: 'Signed-out state shows sign-in copy.',
      error: 'Auth errors route the shell to signed-out mode.',
    },
    disabledBehavior: 'Signed-in-only routes and controls are hidden while signed out.',
    pagination: 'Not applicable.',
    redaction: 'Bootstrap JSON carries public branding and feature metadata only.',
    tests: ['browser-e2e.test.ts', 'accessibility.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'members',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['adminMembers', 'adminMemberInvite', 'adminMemberUpdate'],
    states: {
      loading: 'Member table renders empty rows until admin data returns.',
      empty: 'No member records loaded.',
      error: 'Admin API denial renders in the member table.',
    },
    disabledBehavior: 'Invite and role controls are disabled for members and when signup mode is not invite.',
    pagination: 'Admin members endpoint accepts q and limit; the browser currently loads the first bounded page.',
    redaction: 'Member rows expose identity and role/status only.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'policy',
    surface: 'admin',
    requiredRole: 'member',
    endpointIds: ['adminPolicy', 'adminWorkerPools', 'adminWorkers', 'adminWorkerHeartbeats'],
    states: {
      loading: 'Policy and worker summaries load after sign-in.',
      empty: 'No policy loaded / No worker pools loaded.',
      error: 'Policy or worker summary errors render as explicit admin-surface messages.',
    },
    disabledBehavior: 'Mutating policy controls are not exposed in v1; summaries remain read-only.',
    pagination: 'Worker pools and workers load bounded first pages with limit=100.',
    redaction: 'Worker health summaries exclude credentials and heartbeat secrets.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'byok',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['byok'],
    states: {
      loading: 'Provider status metadata loads after sign-in.',
      empty: 'No configured providers.',
      error: 'Provider policy and validation failures render in status.',
    },
    disabledBehavior: 'Key entry, validation, and disable controls are admin-only.',
    pagination: 'Not applicable; BYOK status is provider-scoped metadata.',
    redaction: 'Plaintext provider keys are write-only and never re-rendered from state.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'connections',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['apiTokens'],
    states: {
      loading: 'Token list loads after sign-in.',
      empty: 'No issued tokens.',
      error: 'Token issue/revoke errors render in status.',
    },
    disabledBehavior: 'Token issue and revoke controls are admin-only and destructive actions require typed confirmation.',
    pagination: 'API token list is bounded by server defaults; cursoring is deferred.',
    redaction: 'Token plaintext is shown once only after creation and never persisted.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'billing',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['billingSubscription'],
    states: {
      loading: 'Subscription state loads with the dashboard bootstrap.',
      empty: 'Self-host mode renders billing disabled.',
      error: 'Checkout/portal errors render in status.',
    },
    disabledBehavior: 'Billing controls are disabled for self-host mode and non-admin users.',
    pagination: 'Not applicable.',
    redaction: 'Billing UI renders entitlement state, not provider secrets.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'gateway',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['channelAgents', 'channelBindings', 'channelDeliveries', 'channelDeliveryRetry', 'channelDeliveryDeadLetter'],
    states: {
      loading: 'Gateway agents, bindings, and delivery backlog load after sign-in.',
      empty: 'No gateway agents, bindings, or deliveries loaded.',
      error: 'Gateway API denial leaves explicit unavailable surface state.',
    },
    disabledBehavior: 'Gateway setup, binding, retry, and dead-letter actions are admin-only.',
    pagination: 'Delivery backlog loads the first 50 rows; provider streams are handled by Gateway, not the browser.',
    redaction: 'Channel credential refs are metadata only; channel secrets are not rendered.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'audit',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['adminAudit'],
    states: {
      loading: 'Audit list loads after admin bootstrap.',
      empty: 'No audit events loaded.',
      error: 'Admin denial renders in the audit list.',
    },
    disabledBehavior: 'Export is admin-only and exports redacted audit events.',
    pagination: 'Audit endpoint loads the first 100 events; cursor export is deferred.',
    redaction: 'Audit metadata is expected to be server-redacted before browser export.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'usage',
    surface: 'admin',
    requiredRole: 'member',
    endpointIds: ['usageEvents', 'usageSummary'],
    states: {
      loading: 'Usage quota and totals load during dashboard refresh.',
      empty: 'No usage events recorded yet.',
      error: 'Usage API failures render through the global status.',
    },
    disabledBehavior: 'Usage is read-only; export is available for the visible redacted summary.',
    pagination: 'Usage events load limit=20 and summaries load limit=100.',
    redaction: 'Usage events contain metering dimensions only, not prompts or secrets.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'diagnostics',
    surface: 'admin',
    requiredRole: 'operator',
    endpointIds: ['diagnostics', 'runtimeStatus', 'workerHeartbeats'],
    states: {
      loading: 'Diagnostics are loaded only after Prepare bundle.',
      empty: 'Prepare a bundle to inspect redacted support data.',
      error: 'Operator/admin boundary errors remain visible in the diagnostics panel.',
    },
    disabledBehavior: 'Diagnostics controls are hidden from non-admin users and may still require operator-token privileges.',
    pagination: 'Diagnostics includes bounded worker heartbeat and gateway delivery samples.',
    redaction: 'Diagnostics bundle is recursively redacted for tokens, cookies, API keys, object URLs, and credential refs.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
]

export function findCloudWebRouteApiMatrix(routeId: CloudWebRouteId) {
  return CLOUD_WEB_ROUTE_API_MATRIX.find((entry) => entry.routeId === routeId) || null
}
