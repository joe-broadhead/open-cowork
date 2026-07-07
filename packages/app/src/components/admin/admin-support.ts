// Admin control-plane surface — pure support logic (#896).
//
// No JSX: section metadata, RBAC section-gating, conditional-billing selection,
// permission-catalog copy, and formatting/download helpers. Kept separate so the
// gating rules are unit-testable without rendering.

import type {
  AdminAccess,
  AdminAuditEvent,
  AdminEntitlements,
  ControlPlanePermission,
  ControlPlaneRole,
} from '@open-cowork/shared'
import { hasAdminPermission } from '@open-cowork/shared'
import type { IconName } from '../ui'

export type AdminSectionId =
  | 'members'
  | 'roles'
  | 'policies'
  | 'providers'
  | 'usage'
  | 'audit'
  | 'deployment'
  | 'billing'

export type AdminSectionDef = {
  id: AdminSectionId
  icon: IconName
  labelKey: string
  fallback: string
  // Any of these permissions unlocks the section. Empty ⇒ open to any admin member.
  permissions: ControlPlanePermission[]
  // Billing renders only when the entitlements adapter is on.
  requiresBilling?: boolean
}

// The section catalog, in nav order. Deployment is always offered (org overview is
// member-readable); Billing is conditional on the billing adapter being enabled.
export const ADMIN_SECTIONS: readonly AdminSectionDef[] = [
  { id: 'members', icon: 'users', labelKey: 'admin.section.members', fallback: 'Members', permissions: ['members:read', 'members:manage'] },
  { id: 'roles', icon: 'badge-check', labelKey: 'admin.section.roles', fallback: 'Roles', permissions: ['roles:manage'] },
  { id: 'policies', icon: 'sliders', labelKey: 'admin.section.policies', fallback: 'Policies', permissions: ['policy:manage'] },
  { id: 'providers', icon: 'network', labelKey: 'admin.section.providers', fallback: 'Providers & Models', permissions: ['policy:manage', 'sso:manage'] },
  { id: 'usage', icon: 'gauge', labelKey: 'admin.section.usage', fallback: 'Usage', permissions: ['operations:view', 'diagnostics:view', 'billing:manage'] },
  { id: 'audit', icon: 'list-checks', labelKey: 'admin.section.audit', fallback: 'Audit', permissions: ['audit:read'] },
  { id: 'deployment', icon: 'route', labelKey: 'admin.section.deployment', fallback: 'Deployment', permissions: ['org:read', 'org:manage'] },
  { id: 'billing', icon: 'briefcase', labelKey: 'admin.section.billing', fallback: 'Billing', permissions: ['billing:manage'], requiresBilling: true },
]

export function sectionUnlocked(
  section: AdminSectionDef,
  access: Pick<AdminAccess, 'permissions'> | null | undefined,
  entitlements: Pick<AdminEntitlements, 'billingEnabled'> | null | undefined,
): boolean {
  if (section.requiresBilling && !entitlements?.billingEnabled) return false
  if (section.permissions.length === 0) return true
  return section.permissions.some((permission) => hasAdminPermission(access, permission))
}

// The sections this caller may open — the nav renders exactly these, and an empty
// result means the whole surface is permission-gated.
export function availableAdminSections(
  access: Pick<AdminAccess, 'permissions'> | null | undefined,
  entitlements: Pick<AdminEntitlements, 'billingEnabled'> | null | undefined,
): AdminSectionDef[] {
  return ADMIN_SECTIONS.filter((section) => sectionUnlocked(section, access, entitlements))
}

export function canManage(
  access: Pick<AdminAccess, 'permissions'> | null | undefined,
  permission: ControlPlanePermission,
): boolean {
  return hasAdminPermission(access, permission)
}

// -- Permission catalog copy --------------------------------------------------

export type PermissionCatalogEntry = {
  permission: ControlPlanePermission
  label: string
  description: string
  category: string
}

const PERMISSION_COPY: Record<ControlPlanePermission, { label: string; description: string; category: string }> = {
  'org:read': { label: 'View organization', description: 'See org profile, plan, and deployment status.', category: 'Organization' },
  'org:manage': { label: 'Manage organization', description: 'Change org settings, signup mode, and profile.', category: 'Organization' },
  'members:read': { label: 'View members', description: 'List members and their roles.', category: 'Members' },
  'members:manage': { label: 'Manage members', description: 'Invite, update, and deprovision members.', category: 'Members' },
  'roles:manage': { label: 'Manage roles', description: 'Create and edit custom roles.', category: 'Members' },
  'sso:manage': { label: 'Manage SSO', description: 'Configure SSO and SCIM provisioning.', category: 'Identity' },
  'api_tokens:read': { label: 'View API tokens', description: 'List issued API tokens.', category: 'Identity' },
  'api_tokens:manage': { label: 'Manage API tokens', description: 'Issue and revoke API tokens.', category: 'Identity' },
  'billing:manage': { label: 'Manage billing', description: 'Manage the subscription and plan.', category: 'Billing' },
  'policy:manage': { label: 'Manage policy', description: 'Set the managed desktop policy.', category: 'Policy' },
  'audit:read': { label: 'Read audit log', description: 'Query and export the audit log.', category: 'Audit' },
  'sessions:read': { label: 'View sessions', description: 'Read session activity.', category: 'Workspace' },
  'sessions:write': { label: 'Run sessions', description: 'Create and drive sessions.', category: 'Workspace' },
  'workflows:manage': { label: 'Manage workflows', description: 'Configure automated workflows.', category: 'Workspace' },
  'operations:view': { label: 'View operations', description: 'See operational metrics and usage.', category: 'Operations' },
  'diagnostics:view': { label: 'View diagnostics', description: 'Access the diagnostics bundle.', category: 'Operations' },
}

export function permissionCopy(permission: ControlPlanePermission): PermissionCatalogEntry {
  const copy = PERMISSION_COPY[permission] || { label: permission, description: permission, category: 'Other' }
  return { permission, ...copy }
}

export function permissionCatalogByCategory(permissions: readonly ControlPlanePermission[]): Array<{ category: string; entries: PermissionCatalogEntry[] }> {
  const groups = new Map<string, PermissionCatalogEntry[]>()
  for (const permission of permissions) {
    const entry = permissionCopy(permission)
    const bucket = groups.get(entry.category) || []
    bucket.push(entry)
    groups.set(entry.category, bucket)
  }
  return [...groups.entries()].map(([category, entries]) => ({ category, entries }))
}

// -- Formatting ---------------------------------------------------------------

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatQuantity(value: number, unit: string): string {
  if (unit === 'byte') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let size = value
    let index = 0
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024
      index += 1
    }
    return `${size % 1 === 0 ? size : size.toFixed(1)} ${units[index]}`
  }
  return `${value.toLocaleString()}${unit && unit !== 'count' ? ` ${unit}` : ''}`
}

export function roleLabel(role: ControlPlaneRole | null): string {
  if (role === 'owner') return 'Owner'
  if (role === 'admin') return 'Admin'
  if (role === 'member') return 'Member'
  return 'Unknown'
}

export function describeAuditEvent(event: AdminAuditEvent): string {
  const target = event.targetType ? `${event.targetType}${event.targetId ? `:${event.targetId}` : ''}` : ''
  return target ? `${event.eventType} → ${target}` : event.eventType
}

// Trigger a browser download of exported text. No-op guard for non-DOM test envs
// that lack URL.createObjectURL / anchor click.
export function downloadTextFile(filename: string, contentType: string, content: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false
  }
  try {
    const blob = new Blob([content], { type: contentType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}
