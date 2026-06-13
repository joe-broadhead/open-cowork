import type { CloudWebRouteId, CloudWebSurface } from './app-shell.ts'
import type { CloudWebEndpointId } from './client-contract.ts'

export type CloudWebRouteRequiredRole = 'public' | 'member' | 'admin' | 'operator'
export type CloudWebRoutePaginationMode = 'cursor' | 'bounded-page' | 'local-bounded' | 'not-applicable' | 'deferred'
export type CloudWebRouteCursorState = 'implemented' | 'not-applicable' | 'deferred'
export type CloudWebRouteRedactionSanitizer = 'server' | 'safeOperationalMetadata' | 'safeArtifactMetadata' | 'metadata-only'

export type CloudWebRoutePaginationContract = {
  mode: CloudWebRoutePaginationMode
  cursor: CloudWebRouteCursorState
  limit: number | null
  implemented: boolean
}

export type CloudWebRouteRedactionContract = {
  serverRedacted: boolean
  browserSanitizer: CloudWebRouteRedactionSanitizer
  rawSecretsAllowed: false
}

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
  paginationContract: CloudWebRoutePaginationContract
  redaction: string
  redactionContract: CloudWebRouteRedactionContract
  tests: string[]
}

function paginationContract(
  mode: CloudWebRoutePaginationMode,
  cursor: CloudWebRouteCursorState,
  limit: number | null,
  implemented = true,
): CloudWebRoutePaginationContract {
  return { mode, cursor, limit, implemented }
}

function redactionContract(
  browserSanitizer: CloudWebRouteRedactionSanitizer,
  serverRedacted = true,
): CloudWebRouteRedactionContract {
  return { browserSanitizer, serverRedacted, rawSecretsAllowed: false }
}

export const CLOUD_WEB_ROUTE_API_MATRIX: CloudWebRouteApiMatrixEntry[] = [
  {
    routeId: 'threads',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: [
      'sessions',
      'sessionView',
      'projectSourceValidate',
      'projectSnapshots',
      'coordinationBoard',
      'coordinationProjects',
      'coordinationProjectCreate',
      'coordinationProject',
      'coordinationPlanWithCleo',
      'coordinationTasks',
      'coordinationTaskCreate',
      'coordinationTask',
      'coordinationTaskMove',
      'coordinationTaskAssign',
      'coordinationTaskLinkWork',
      'coordinationTaskWorkTarget',
      'coordinationWatches',
      'coordinationWatchCreate',
      'coordinationWatch',
      'coordinationWatchPause',
      'coordinationWatchResume',
      'coordinationWatchDelete',
    ],
    states: {
      loading: 'Projects board renders a loading state until /api/coordination/board returns.',
      empty: 'No projects loaded; the board invites creating a durable project objective and planning with Cleo.',
      error: 'Policy, quota, billing, coordination, and project-source denials render through the global status or board notice.',
    },
    disabledBehavior: 'Project create, move, assign, and Cleo planning controls are disabled when chat/project actions are unavailable or the user is signed out.',
    pagination: 'Projects and tasks are bounded API lists for the board; chat history remains sidebar-scoped and paged through /api/sessions cursor pages without being the Projects route content.',
    paginationContract: paginationContract('cursor', 'implemented', 200),
    redaction: 'Local host paths and local MCP process details are never accepted as cloud chat context.',
    redactionContract: redactionContract('metadata-only'),
    tests: ['render.test.ts', 'browser-e2e.test.ts', 'performance.test.ts'],
  },
  {
    routeId: 'chat',
    surface: 'workbench',
    requiredRole: 'public',
    endpointIds: ['launchpadFeed', 'sessionView', 'sessionEvents', 'sessionPrompt', 'sessionPermissionRespond', 'sessionQuestionReply', 'sessionQuestionReject'],
    states: {
      loading: 'Chat Home is the default public route while auth resolves; selected signed-in sessions hydrate from /api/sessions/:sessionId/view before SSE.',
      empty: 'Signed-out Home shows a disabled composer; a signed-in ready composer creates a chat-only Cloud session on first send.',
      error: 'Composer and runtime action errors render stable policy/quota/billing messages.',
    },
    disabledBehavior: 'Composer is disabled only when signed out, chat policy is disabled, a submit is in progress, or the selected chat is closed.',
    pagination: 'Session SSE resumes from the durable projection sequence; no browser-only projection model exists.',
    paginationContract: paginationContract('cursor', 'implemented', null),
    redaction: 'Runtime details are rendered from Cloud projections and sanitized before browser display.',
    redactionContract: redactionContract('safeOperationalMetadata'),
    tests: ['browser-e2e.test.ts', 'render.test.ts', 'cloud-continuation-e2e.test.ts'],
  },
  {
    routeId: 'agents',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['workspace', 'capabilitiesCatalog'],
    states: {
      loading: 'Coworker list derives from workspace policy and capability metadata.',
      empty: 'No coworkers loaded.',
      error: 'Capability policy errors render as unavailable surface notes.',
    },
    disabledBehavior: 'Refresh is disabled when coworker, skill, or MCP features are disabled by profile policy.',
    pagination: 'Capability filtering is local and performance-tested against hundreds of entries.',
    paginationContract: paginationContract('local-bounded', 'not-applicable', 500),
    redaction: 'Custom content is metadata-only; machine-local MCP commands and secrets are not exposed.',
    redactionContract: redactionContract('metadata-only'),
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
    paginationContract: paginationContract('local-bounded', 'deferred', 500),
    redaction: 'Machine-scoped MCPs are displayed as policy-limited metadata, not executable local commands.',
    redactionContract: redactionContract('metadata-only'),
    tests: ['render.test.ts', 'performance.test.ts'],
  },
  {
    routeId: 'workflows',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['workflows', 'workflow', 'workflowRun', 'workflowPause', 'workflowResume', 'workflowArchive'],
    states: {
      loading: 'Playbook tables render empty rows until /api/workflows returns.',
      empty: 'No playbooks loaded.',
      error: 'Disabled playbook policy and action failures render through the playbook panel/status.',
    },
    disabledBehavior: 'Playbook create/run controls are disabled when workflows are disabled by profile policy.',
    pagination: 'The route consumes the current playbook summary payload; run-history cursoring is deferred.',
    paginationContract: paginationContract('bounded-page', 'deferred', 100),
    redaction: 'Playbook rows expose cloud metadata only, never worker credentials or local paths.',
    redactionContract: redactionContract('metadata-only'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'channels',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: [
      'channelProviders',
      'channelAgents',
      'channelAgentCreate',
      'channelBindings',
      'channelBindingCreate',
      'channelBindingUpdate',
      'channelIdentities',
      'channelIdentityResolve',
      'channelDeliveries',
      'coordinationWatches',
      'coordinationWatchCreate',
      'coordinationWatchPause',
      'coordinationWatchResume',
      'coordinationWatchDelete',
    ],
    states: {
      loading: 'Provider, agent, binding, people, watch, and delivery lists render empty cards until the Cloud channel endpoints return.',
      empty: 'No connected channels, people, watches, or deliveries loaded.',
      error: 'Gateway/channel API denial renders an unavailable state and does not expose provider credentials or setup internals.',
    },
    disabledBehavior: 'Reads are member-visible; provider connect/disconnect, people resolution, and watch mutation controls are disabled unless the workspace role is owner/admin.',
    pagination: 'Providers are local-bounded; agents, bindings, and people load the first 100 rows; watches load the first 500; delivery status loads the first 50 rows.',
    paginationContract: paginationContract('bounded-page', 'deferred', 100),
    redaction: 'Credential refs, payload secrets, signed URLs, tokens, object keys, and provider internals are stripped before rendering.',
    redactionContract: redactionContract('safeOperationalMetadata'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'artifacts',
    surface: 'workbench',
    requiredRole: 'member',
    endpointIds: ['artifactsIndex', 'sessionArtifacts', 'sessionArtifact'],
    states: {
      loading: 'Artifact inspector starts idle until a selected session artifact is inspected.',
      empty: 'No artifacts loaded.',
      error: 'Artifact metadata/download errors stay in the artifact panel.',
    },
    disabledBehavior: 'Artifact body fetches happen only from explicit Inspect/Download actions.',
    pagination: 'Cross-session artifact browsing uses the bounded Cloud artifact index; selected-session artifact reads remain explicit.',
    paginationContract: paginationContract('bounded-page', 'implemented', 100),
    redaction: 'Signed URLs, object keys, buckets, tokens, and raw object-store internals are stripped from metadata.',
    redactionContract: redactionContract('safeArtifactMetadata'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'org',
    surface: 'admin',
    requiredRole: 'public',
    endpointIds: ['authMe', 'config', 'workspace'],
    states: {
      loading: 'Org route renders an explicit public org/profile surface when opened.',
      empty: 'Public org state shows sign-in copy and signed-in org/profile metadata when available.',
      error: 'Auth errors keep the shell in signed-out mode and route back to the public chat Home.',
    },
    disabledBehavior: 'Signed-in-only routes and controls are hidden while signed out.',
    pagination: 'Not applicable.',
    paginationContract: paginationContract('not-applicable', 'not-applicable', null),
    redaction: 'Bootstrap JSON carries public branding and feature metadata only.',
    redactionContract: redactionContract('server'),
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
    paginationContract: paginationContract('bounded-page', 'deferred', 100),
    redaction: 'Member rows expose identity and role/status only.',
    redactionContract: redactionContract('metadata-only'),
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
    paginationContract: paginationContract('bounded-page', 'deferred', 100),
    redaction: 'Worker health summaries exclude credentials and heartbeat secrets.',
    redactionContract: redactionContract('metadata-only'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'byok',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['byok', 'byokSave', 'byokValidate', 'byokDisable'],
    states: {
      loading: 'Provider status metadata loads after sign-in.',
      empty: 'No configured providers.',
      error: 'Provider policy and validation failures render in status.',
    },
    disabledBehavior: 'Key entry, validation, and disable controls are admin-only.',
    pagination: 'Not applicable; BYOK status is provider-scoped metadata.',
    paginationContract: paginationContract('not-applicable', 'not-applicable', null),
    redaction: 'Plaintext provider keys are write-only and never re-rendered from state.',
    redactionContract: redactionContract('server'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'connections',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['apiTokens', 'apiTokenCreate', 'apiTokenRevoke'],
    states: {
      loading: 'Token list loads after sign-in.',
      empty: 'No issued tokens.',
      error: 'Token issue/revoke errors render in status.',
    },
    disabledBehavior: 'Token issue and revoke controls are admin-only and destructive actions require typed confirmation.',
    pagination: 'API token list is bounded by server defaults; cursoring is deferred.',
    paginationContract: paginationContract('bounded-page', 'deferred', 100),
    redaction: 'Token plaintext is shown once only after creation and never persisted.',
    redactionContract: redactionContract('server'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'billing',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['billingSubscription', 'billingCheckout', 'billingPortal'],
    states: {
      loading: 'Subscription state loads with the dashboard bootstrap.',
      empty: 'Self-host mode renders billing disabled.',
      error: 'Checkout/portal errors render in status.',
    },
    disabledBehavior: 'Billing controls are disabled for self-host mode and non-admin users.',
    pagination: 'Not applicable.',
    paginationContract: paginationContract('not-applicable', 'not-applicable', null),
    redaction: 'Billing UI renders entitlement state, not provider secrets.',
    redactionContract: redactionContract('server'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'gateway',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['channelProviders', 'channelAgents', 'channelAgentCreate', 'channelBindings', 'channelBindingCreate', 'channelBindingUpdate', 'channelIdentities', 'channelIdentityResolve', 'channelDeliveries', 'channelDeliveryRetry', 'channelDeliveryDeadLetter', 'coordinationWatches', 'coordinationWatchCreate', 'coordinationWatchPause', 'coordinationWatchResume', 'coordinationWatchDelete'],
    states: {
      loading: 'Gateway agents, bindings, and delivery backlog load after sign-in.',
      empty: 'No gateway agents, bindings, or deliveries loaded.',
      error: 'Gateway API denial leaves explicit unavailable surface state.',
    },
    disabledBehavior: 'Gateway setup, binding, retry, and dead-letter actions are admin-only.',
    pagination: 'Delivery backlog loads the first 50 rows; provider streams are handled by Gateway, not the browser.',
    paginationContract: paginationContract('bounded-page', 'deferred', 50),
    redaction: 'Channel credential refs are metadata only; channel secrets are not rendered.',
    redactionContract: redactionContract('safeOperationalMetadata'),
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
    paginationContract: paginationContract('bounded-page', 'deferred', 100),
    redaction: 'Audit metadata is expected to be server-redacted before browser export.',
    redactionContract: redactionContract('safeOperationalMetadata'),
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
    paginationContract: paginationContract('bounded-page', 'deferred', 20),
    redaction: 'Usage events contain metering dimensions only, not prompts or secrets.',
    redactionContract: redactionContract('safeOperationalMetadata'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    routeId: 'diagnostics',
    surface: 'admin',
    requiredRole: 'admin',
    endpointIds: ['diagnostics', 'runtimeStatus', 'workerHeartbeats'],
    states: {
      loading: 'Diagnostics are loaded only after Prepare bundle.',
      empty: 'Prepare a bundle to inspect redacted support data.',
      error: 'Operator/admin boundary errors remain visible in the diagnostics panel.',
    },
    disabledBehavior: 'Diagnostics controls are hidden from non-admin users and may still fail closed when the Cloud API requires operator-token privileges.',
    pagination: 'Diagnostics includes bounded worker heartbeat and gateway delivery samples.',
    paginationContract: paginationContract('bounded-page', 'deferred', 50),
    redaction: 'Diagnostics bundle is recursively redacted for tokens, cookies, API keys, object URLs, and credential refs.',
    redactionContract: redactionContract('safeOperationalMetadata'),
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
]

export function findCloudWebRouteApiMatrix(routeId: CloudWebRouteId) {
  return CLOUD_WEB_ROUTE_API_MATRIX.find((entry) => entry.routeId === routeId) || null
}
