import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AdminAccess, AdminEntitlements } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { AdminPage } from './AdminPage'

function makeAccess(permissions: AdminAccess['permissions']): AdminAccess {
  return { role: 'admin', customRoleKey: null, permissions, email: 'admin@acme.co', ssoVerified: false }
}

function makeEntitlements(billingEnabled: boolean): AdminEntitlements {
  return {
    provider: 'metadata',
    gatingEnabled: false,
    billingEnabled,
    planKey: 'pro',
    planLabel: 'Pro',
    subscriptionStatus: 'active',
    seats: 10,
    features: { byok: true },
    limits: { seats: 10 },
  }
}

// A complete admin bridge mock; individual tests override access/entitlements and a
// section loader as needed. Every method resolves to a benign empty value so any
// section can mount without throwing.
function installAdmin(access: AdminAccess, entitlements: AdminEntitlements, overrides: Record<string, unknown> = {}) {
  installRendererTestCoworkApi({
    admin: {
      access: vi.fn(async () => access),
      entitlements: vi.fn(async () => entitlements),
      overview: vi.fn(async () => ({
        org: { orgId: 'o1', tenantId: 't1', name: 'Acme', planKey: 'pro', status: 'active' },
        signup: { mode: 'invite', allowSelfServiceSignup: false, allowedEmailDomains: [], invitesEnabled: true },
        profile: { name: 'default', label: 'Default', description: null },
        features: {},
        allowedAgents: null,
        allowedTools: null,
        allowedMcps: null,
        runtime: { configSource: 'app', machineRuntimeConfig: 'disabled', localStdioMcps: 'disabled', hostProjectDirectories: 'disabled' },
        gateway: { channelsEnabled: true, webhooksEnabled: true },
      })),
      members: { list: vi.fn(async () => []), invite: vi.fn(), update: vi.fn(), assignRole: vi.fn() },
      roles: { catalog: vi.fn(async () => []), list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      policy: { get: vi.fn(async () => ({ policy: null, view: {} })), set: vi.fn() },
      providers: { listKeys: vi.fn(async () => []), setKey: vi.fn(), deleteKey: vi.fn(), sso: vi.fn(async () => null) },
      usage: vi.fn(async () => ({ enabled: true, generatedAt: '', events: [], totals: [], quotas: [] })),
      audit: { query: vi.fn(async () => ({ events: [], nextCursor: null })), export: vi.fn() },
      ...overrides,
    },
  })
}

describe('AdminPage RBAC gating', () => {
  it('renders only the sections the caller has permission for', async () => {
    installAdmin(makeAccess(['audit:read']), makeEntitlements(false))
    render(<AdminPage />)
    const nav = await screen.findByRole('navigation', { name: /admin sections/i })
    expect(within(nav).getByRole('button', { name: /audit/i })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: /members/i })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: /policies/i })).not.toBeInTheDocument()
  })

  it('shows a permission-gated notice when the caller has no admin permissions', async () => {
    installAdmin(makeAccess([]), makeEntitlements(false))
    render(<AdminPage />)
    expect(await screen.findByText(/no admin access/i)).toBeInTheDocument()
  })

  it('surfaces a retry-able error when access resolution fails', async () => {
    installRendererTestCoworkApi({
      admin: {
        access: vi.fn(async () => { throw new Error('boom') }),
        entitlements: vi.fn(async () => makeEntitlements(false)),
      },
    })
    render(<AdminPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/i)
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})

describe('AdminPage conditional billing', () => {
  it('omits the Billing section when the billing adapter is off', async () => {
    installAdmin(makeAccess(['billing:manage', 'org:read']), makeEntitlements(false))
    render(<AdminPage />)
    const nav = await screen.findByRole('navigation', { name: /admin sections/i })
    expect(within(nav).queryByRole('button', { name: /billing/i })).not.toBeInTheDocument()
  })

  it('renders the Billing section when the billing adapter is on', async () => {
    installAdmin(makeAccess(['billing:manage', 'org:read']), makeEntitlements(true))
    render(<AdminPage />)
    const nav = await screen.findByRole('navigation', { name: /admin sections/i })
    const billingNav = within(nav).getByRole('button', { name: /billing/i })
    await userEvent.click(billingNav)
    expect(await screen.findByText(/Subscription plan, entitlements/i)).toBeInTheDocument()
  })
})

describe('AdminPage section states', () => {
  it('shows the designed empty state for a section with no data', async () => {
    installAdmin(makeAccess(['members:manage']), makeEntitlements(false))
    render(<AdminPage />)
    // Members is the first available section; its list resolves empty.
    expect(await screen.findByText(/no members yet/i)).toBeInTheDocument()
  })

  it('shows a section error state when its loader rejects', async () => {
    installAdmin(makeAccess(['members:manage']), makeEntitlements(false), {
      members: { list: vi.fn(async () => { throw new Error('member load failed') }), invite: vi.fn(), update: vi.fn(), assignRole: vi.fn() },
    })
    render(<AdminPage />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/member load failed/i))
  })
})
