import { describe, expect, it } from 'vitest'
import type { AdminAccess, AdminEntitlements } from '@open-cowork/shared'
import { canAccessAdminSurface } from '@open-cowork/shared'
import {
  availableAdminSections,
  canManage,
  formatQuantity,
  permissionCatalogByCategory,
  sectionUnlocked,
  ADMIN_SECTIONS,
} from './admin-support'

function access(permissions: AdminAccess['permissions']): AdminAccess {
  return { role: 'admin', customRoleKey: null, permissions, email: 'a@b.co', ssoVerified: false }
}

const billingOff: Pick<AdminEntitlements, 'billingEnabled'> = { billingEnabled: false }
const billingOn: Pick<AdminEntitlements, 'billingEnabled'> = { billingEnabled: true }

describe('admin-support RBAC gating', () => {
  it('offers only the sections a permission unlocks', () => {
    const ids = availableAdminSections(access(['audit:read']), billingOff).map((section) => section.id)
    expect(ids).toEqual(['audit'])
  })

  it('offers members + roles + policies for a broad admin', () => {
    const ids = availableAdminSections(access(['members:manage', 'roles:manage', 'policy:manage']), billingOff).map((section) => section.id)
    expect(ids).toEqual(['members', 'roles', 'policies', 'providers'])
  })

  it('returns no sections when the caller has no admin permissions', () => {
    expect(availableAdminSections(access([]), billingOff)).toEqual([])
    expect(canAccessAdminSurface(access([]))).toBe(false)
    expect(canAccessAdminSurface(access(['members:read']))).toBe(true)
  })

  it('exposes canManage as a direct permission check', () => {
    expect(canManage(access(['members:manage']), 'members:manage')).toBe(true)
    expect(canManage(access(['members:read']), 'members:manage')).toBe(false)
  })
})

describe('admin-support conditional billing', () => {
  it('hides Billing when the billing adapter is off, even with billing:manage', () => {
    const ids = availableAdminSections(access(['billing:manage']), billingOff).map((section) => section.id)
    expect(ids).not.toContain('billing')
  })

  it('shows Billing only when the adapter is on AND the caller can manage billing', () => {
    expect(availableAdminSections(access(['billing:manage']), billingOn).map((s) => s.id)).toContain('billing')
    // Adapter on but no billing permission ⇒ still hidden.
    const billingSection = ADMIN_SECTIONS.find((section) => section.id === 'billing')!
    expect(sectionUnlocked(billingSection, access(['audit:read']), billingOn)).toBe(false)
  })
})

describe('admin-support formatting', () => {
  it('formats byte quantities', () => {
    expect(formatQuantity(2048, 'byte')).toBe('2 KB')
    expect(formatQuantity(5, 'count')).toBe('5')
  })

  it('groups the permission catalog by category', () => {
    const grouped = permissionCatalogByCategory(['members:manage', 'members:read', 'audit:read'])
    const members = grouped.find((group) => group.category === 'Members')
    expect(members?.entries.map((entry) => entry.permission)).toEqual(['members:manage', 'members:read'])
  })
})
