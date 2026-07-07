import type { AuditActorInput } from './control-plane-account-inputs.ts'
import type { ControlPlaneRole } from './control-plane-enums.ts'

// The control-plane RBAC vocabulary: the named permission set, the built-in
// role → permission maps, and the custom-role record/input shapes an org can
// define beyond owner/admin/member. Pure types + pure resolution helpers only,
// so the store contract, both store implementations, the principal/role/member
// services, and the route layer can all share one authoritative model. Keeping
// this dependency-light also keeps it SSO/SCIM/admin-ready: a role definition is
// a plain permission map, decoupled from how a principal was authenticated.

export type ControlPlanePermission =
  | 'org:read'
  | 'org:manage'
  | 'members:read'
  | 'members:manage'
  | 'roles:manage'
  | 'api_tokens:read'
  | 'api_tokens:manage'
  | 'billing:manage'
  | 'sessions:read'
  | 'sessions:write'
  | 'workflows:manage'
  | 'operations:view'
  | 'diagnostics:view'

// The canonical, ordered permission catalog. New permissions are appended here
// and become assignable to custom roles immediately.
export const CONTROL_PLANE_PERMISSIONS: readonly ControlPlanePermission[] = [
  'org:read',
  'org:manage',
  'members:read',
  'members:manage',
  'roles:manage',
  'api_tokens:read',
  'api_tokens:manage',
  'billing:manage',
  'sessions:read',
  'sessions:write',
  'workflows:manage',
  'operations:view',
  'diagnostics:view',
] as const

const CONTROL_PLANE_PERMISSION_SET = new Set<string>(CONTROL_PLANE_PERMISSIONS)

// Built-in roles keep their existing broad capabilities so nothing that programs
// against owner/admin/member changes. Custom roles are how an org expresses a
// NARROWER (or differently-shaped) capability set than the built-ins.
export const BUILTIN_ROLE_PERMISSIONS: Record<ControlPlaneRole, readonly ControlPlanePermission[]> = {
  owner: [...CONTROL_PLANE_PERMISSIONS],
  admin: [...CONTROL_PLANE_PERMISSIONS],
  member: ['org:read', 'members:read', 'sessions:read', 'sessions:write'],
} as const

const CUSTOM_ROLE_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/
const BUILTIN_ROLE_KEYS = new Set<string>(['owner', 'admin', 'member'])

export type CustomRoleRecord = {
  orgId: string
  roleKey: string
  name: string
  description: string | null
  // The built-in role a custom role is layered on for privilege comparisons
  // (e.g. owner-protection). The effective permission set is `permissions`, not
  // the base role's map — the base role only classifies seniority.
  baseRole: ControlPlaneRole
  permissions: ControlPlanePermission[]
  createdAt: string
  updatedAt: string
}

export type CreateCustomRoleInput = {
  orgId: string
  roleKey: string
  name: string
  description?: string | null
  baseRole?: ControlPlaneRole
  permissions: readonly string[]
  createdAt?: Date
  actor?: AuditActorInput
}

export type UpdateCustomRoleInput = {
  orgId: string
  roleKey: string
  name?: string | null
  description?: string | null
  baseRole?: ControlPlaneRole | null
  permissions?: readonly string[] | null
  updatedAt?: Date
  actor?: AuditActorInput
}

export type RevokeApiTokensForAccountInput = {
  orgId: string
  accountId: string
  reason?: string | null
  revokedAt?: Date
  actor?: AuditActorInput
}

// The resolved effective permissions for one member: the base membership role,
// the assigned custom-role key (if any), and the authoritative permission set.
export type MemberPermissionResolution = {
  orgId: string
  accountId: string
  role: ControlPlaneRole
  customRoleKey: string | null
  permissions: ControlPlanePermission[]
}

export function isControlPlanePermission(value: unknown): value is ControlPlanePermission {
  return typeof value === 'string' && CONTROL_PLANE_PERMISSION_SET.has(value)
}

// Validate + dedupe + order a caller-supplied permission list against the catalog.
// Rejects unknown permissions so a typo can never silently create a role that
// grants nothing (or, worse, reads as granting something it does not).
export function normalizeControlPlanePermissions(
  values: readonly unknown[] | null | undefined,
  label = 'Role permissions',
): ControlPlanePermission[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  const seen = new Set<ControlPlanePermission>()
  for (const value of values) {
    if (!isControlPlanePermission(value)) {
      throw new Error(`${label} includes an unsupported permission: ${String(value)}.`)
    }
    seen.add(value)
  }
  return CONTROL_PLANE_PERMISSIONS.filter((permission) => seen.has(permission))
}

// Custom-role keys are stable slugs used as the membership's assignment pointer.
// They must not collide with the built-in role names, which membership.role uses.
export function normalizeCustomRoleKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!CUSTOM_ROLE_KEY_PATTERN.test(key)) {
    throw new Error('Custom role key must be 2-64 chars of lowercase letters, digits, "-" or "_", starting with a letter.')
  }
  if (BUILTIN_ROLE_KEYS.has(key)) {
    throw new Error(`Custom role key "${key}" collides with a built-in role.`)
  }
  return key
}

export function builtinRolePermissions(role: ControlPlaneRole): ControlPlanePermission[] {
  return [...(BUILTIN_ROLE_PERMISSIONS[role] || BUILTIN_ROLE_PERMISSIONS.member)]
}

// The single source of truth for a member's effective permissions: an assigned
// custom role REPLACES the built-in role's map (it is the org-authored permission
// map); with no custom role the built-in map applies. Ordered by the catalog.
export function resolveEffectivePermissions(input: {
  role: ControlPlaneRole
  customRole?: CustomRoleRecord | null
}): ControlPlanePermission[] {
  if (input.customRole) {
    const set = new Set(input.customRole.permissions)
    return CONTROL_PLANE_PERMISSIONS.filter((permission) => set.has(permission))
  }
  return builtinRolePermissions(input.role)
}

// Permissions present in `before` but absent from `after` — the trigger for
// credential revocation when a role change strips capabilities.
export function permissionsRemoved(
  before: readonly ControlPlanePermission[],
  after: readonly ControlPlanePermission[],
): ControlPlanePermission[] {
  const kept = new Set(after)
  return before.filter((permission) => !kept.has(permission))
}

export function hasPermission(
  permissions: readonly ControlPlanePermission[] | null | undefined,
  permission: ControlPlanePermission,
): boolean {
  return Boolean(permissions?.includes(permission))
}
