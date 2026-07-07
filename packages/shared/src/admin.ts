// Admin control-plane contract (#896).
//
// The single source of truth for the shapes the Admin surface exchanges with the
// cloud control plane. The renderer (desktop + cloud web), the typed `CoworkAPI`
// bridge, the desktop cloud adapter/transport, and the browser HTTP client all
// speak these types, so the admin control plane is byte-identical across surfaces.
//
// Secrets are NEVER carried here: provider keys expose only metadata (last4 +
// fingerprint), and the SSO config exposes only "has secret" booleans. Effective
// permissions drive every gate — sections and destructive actions are shown/enabled
// strictly from the caller's resolved `AdminAccess.permissions`.

import type {
  ManagedDesktopPolicy,
  ManagedDesktopPolicyView,
  ManagedPolicyExtensionClasses,
  ManagedPolicyKeyManagement,
} from './workspace.js'

// The control-plane permission vocabulary (mirrors the server's
// control-plane-permissions module). Fine-grained scopes an admin can grant a
// custom role; the Admin surface gates its sections/actions against these.
export const CONTROL_PLANE_PERMISSIONS = [
  'org:read',
  'org:manage',
  'members:read',
  'members:manage',
  'roles:manage',
  'sso:manage',
  'api_tokens:read',
  'api_tokens:manage',
  'billing:manage',
  'policy:manage',
  'audit:read',
  'sessions:read',
  'sessions:write',
  'workflows:manage',
  'operations:view',
  'diagnostics:view',
] as const

export type ControlPlanePermission = typeof CONTROL_PLANE_PERMISSIONS[number]

export type ControlPlaneRole = 'owner' | 'admin' | 'member'
export type ControlPlaneMembershipStatus = 'active' | 'invited' | 'disabled'

// The caller's own resolved access, delivered from the authenticated principal.
// `permissions` is authoritative (built-in role map, or the custom role's map when
// assigned); the Admin surface renders purely from it.
export type AdminAccess = {
  role: ControlPlaneRole | null
  customRoleKey: string | null
  permissions: ControlPlanePermission[]
  email: string | null
  ssoVerified: boolean
}

export function hasAdminPermission(
  access: Pick<AdminAccess, 'permissions'> | null | undefined,
  permission: ControlPlanePermission,
): boolean {
  return Boolean(access?.permissions?.includes(permission))
}

// Any permission that unlocks at least one Admin section — drives whether the Admin
// entry point is offered at all.
export const ADMIN_SURFACE_PERMISSIONS: readonly ControlPlanePermission[] = [
  'members:read',
  'members:manage',
  'roles:manage',
  'policy:manage',
  'audit:read',
  'sso:manage',
  'billing:manage',
  'org:read',
  'org:manage',
]

export function canAccessAdminSurface(access: Pick<AdminAccess, 'permissions'> | null | undefined): boolean {
  return ADMIN_SURFACE_PERMISSIONS.some((permission) => hasAdminPermission(access, permission))
}

// -- Members -----------------------------------------------------------------

export type AdminMember = {
  orgId: string
  accountId: string
  email: string
  displayName: string | null
  role: ControlPlaneRole
  customRoleKey: string | null
  status: ControlPlaneMembershipStatus
  createdAt: string
  updatedAt: string
}

export type AdminMemberListInput = {
  query?: string | null
  limit?: number | null
}

export type AdminMemberInviteInput = {
  email: string
  role?: ControlPlaneRole | null
}

export type AdminMemberInviteResult = {
  member: AdminMember
  inviteToken: string | null
  inviteExpiresAt: string | null
}

export type AdminMemberUpdateInput = {
  role?: ControlPlaneRole | null
  status?: ControlPlaneMembershipStatus | null
  // Disabling a member requires echoing the accountId as a typed confirmation.
  confirm?: string | null
}

// -- Custom roles ------------------------------------------------------------

export type AdminCustomRole = {
  orgId: string
  roleKey: string
  name: string
  description: string | null
  baseRole: ControlPlaneRole
  permissions: ControlPlanePermission[]
  createdAt: string
  updatedAt: string
}

export type AdminCreateRoleInput = {
  roleKey: string
  name: string
  description?: string | null
  baseRole?: ControlPlaneRole | null
  permissions: ControlPlanePermission[]
}

export type AdminUpdateRoleInput = {
  name?: string | null
  description?: string | null
  baseRole?: ControlPlaneRole | null
  permissions?: ControlPlanePermission[] | null
}

// -- Managed policy ----------------------------------------------------------

export type AdminManagedPolicyRecord = ManagedDesktopPolicy & {
  orgId: string
  createdAt: string
  updatedAt: string
}

export type AdminManagedPolicyResult = {
  policy: AdminManagedPolicyRecord | null
  view: ManagedDesktopPolicyView
}

// Tri-state partial update: an absent field is unchanged; `null` clears an
// allow-list to unrestricted; an array constrains.
export type AdminSetPolicyInput = {
  allowedProviders?: string[] | null
  deniedProviders?: string[]
  allowedModels?: string[] | null
  deniedModels?: string[]
  keyManagement?: ManagedPolicyKeyManagement | null
  extensions?: Partial<ManagedPolicyExtensionClasses> | null
  features?: Record<string, boolean> | null
  permissionCeilings?: Partial<Record<string, string>> | null
  updateChannel?: string | null
}

// -- Providers / provider keys -----------------------------------------------

export type AdminProviderKeyStatus =
  | 'pending_validation'
  | 'active'
  | 'disabled'
  | 'expired'
  | 'invalid'
  | 'unsupported'

export type AdminProviderKeySecret = {
  secretId: string
  providerId: string
  status: AdminProviderKeyStatus
  credentialKind: 'plaintext' | 'kms_ref'
  // Only the last four characters are ever surfaced — the key itself never leaves
  // the control plane.
  last4: string
  keyFingerprint: string
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
  updatedAt: string
}

export type AdminSetProviderKeyInput = {
  apiKey?: string | null
  kmsRef?: string | null
  credentialKind?: 'plaintext' | 'kms_ref' | null
}

// -- SSO (read-only status for the Providers section) ------------------------

export type AdminSsoProtocol = 'saml' | 'oidc'

export type AdminSsoConfig = {
  protocol: AdminSsoProtocol
  enabled: boolean
  enforced: boolean
  displayName: string | null
  verifiedDomains: string[]
  scimEnabled: boolean
  hasOidcClientSecret: boolean
  hasSamlIdpCertificate: boolean
  hasScimToken: boolean
}

// -- Usage -------------------------------------------------------------------

export type AdminUsageEvent = {
  eventId: string
  eventType: string
  quantity: number
  unit: string
  accountId: string | null
  createdAt: string
}

export type AdminUsageTotal = {
  eventType: string
  unit: string
  quantity: number
}

export type AdminUsageQuota = {
  quotaKey: string
  label: string
  unit: 'count' | 'byte' | 'minute'
  enabled: boolean
  limit: number | null
  used: number
  remaining: number | null
  windowMs: number
  resetAt: string
}

export type AdminUsageSummary = {
  enabled: boolean
  generatedAt: string
  events: AdminUsageEvent[]
  totals: AdminUsageTotal[]
  quotas: AdminUsageQuota[]
}

// -- Audit -------------------------------------------------------------------

export type AdminAuditActorType = 'user' | 'api_token' | 'system'

export type AdminAuditEvent = {
  eventId: string
  orgId: string
  accountId: string | null
  actorType: AdminAuditActorType | string
  actorId: string | null
  eventType: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type AdminAuditQuery = {
  actorId?: string | null
  actorType?: AdminAuditActorType | null
  // Free-text event-type prefix (e.g. "member." or "policy.").
  action?: string | null
  targetType?: string | null
  targetId?: string | null
  result?: string | null
  from?: string | null
  to?: string | null
  limit?: number | null
  cursor?: string | null
}

export type AdminAuditPage = {
  events: AdminAuditEvent[]
  nextCursor: string | null
}

export type AdminAuditExportInput = AdminAuditQuery & {
  format?: 'json' | 'csv'
  unredacted?: boolean
}

export type AdminAuditExport = {
  filename: string
  contentType: string
  content: string
}

// -- Entitlements ------------------------------------------------------------

export type AdminEntitlementFeature =
  | 'sessions'
  | 'prompts'
  | 'workers'
  | 'workflows'
  | 'artifacts'
  | 'byok'
  | 'channels'

export type AdminEntitlementResource =
  | 'seats'
  | 'concurrent_sessions'
  | 'concurrent_workflow_runs'
  | 'active_workers'

export type AdminEntitlements = {
  provider: string
  // When false the plan does not gate anything (unlimited) — the surface still
  // reads `billingEnabled` to decide whether to render the Billing section.
  gatingEnabled: boolean
  // The single flag the Admin surface reads to conditionally render Billing.
  billingEnabled: boolean
  planKey: string | null
  planLabel: string | null
  subscriptionStatus: string | null
  seats: number | null
  features: Partial<Record<AdminEntitlementFeature, boolean>>
  limits: Partial<Record<AdminEntitlementResource, number | null>>
}

// -- Deployment / org overview -----------------------------------------------

export type AdminOverview = {
  org: {
    orgId: string
    tenantId: string
    name: string
    planKey: string | null
    status: string
  }
  signup: {
    mode: 'disabled' | 'closed' | 'invite' | 'domain' | 'open'
    allowSelfServiceSignup: boolean
    allowedEmailDomains: string[]
    invitesEnabled: boolean
  }
  profile: {
    name: string
    label: string | null
    description: string | null
  }
  features: Record<string, boolean>
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
  runtime: {
    configSource: string
    machineRuntimeConfig: string
    localStdioMcps: string
    hostProjectDirectories: string
  }
  gateway: {
    channelsEnabled: boolean
    webhooksEnabled: boolean
  }
  providerKeys?: {
    allowedProviderIds: string[] | null
    kmsRefsEnabled: boolean
    kmsRefPrefixesConfigured: boolean
    envRefsEnabled: boolean
  }
}
