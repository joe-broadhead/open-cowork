import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AdminMember } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { MembersSection } from './MembersSection'

function member(overrides: Partial<AdminMember> = {}): AdminMember {
  return {
    orgId: 'o1',
    accountId: 'acct-1',
    email: 'sam@acme.co',
    displayName: 'Sam',
    role: 'member',
    customRoleKey: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function installMembers(list: () => Promise<AdminMember[]>, invite = vi.fn()) {
  installRendererTestCoworkApi({
    admin: { members: { list: vi.fn(list), invite, update: vi.fn(), assignRole: vi.fn() } },
  })
}

describe('MembersSection', () => {
  it('hides mutating controls when the caller cannot manage members', async () => {
    installMembers(async () => [member()])
    render(<MembersSection canManage={false} />)
    expect(await screen.findByText('sam@acme.co')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /invite member/i })).not.toBeInTheDocument()
    expect(screen.getByText(/view only/i)).toBeInTheDocument()
  })

  it('renders the designed empty state', async () => {
    installMembers(async () => [])
    render(<MembersSection canManage />)
    expect(await screen.findByText(/no members yet/i)).toBeInTheDocument()
  })

  it('renders an error state with retry when loading fails', async () => {
    installMembers(async () => { throw new Error('nope') })
    render(<MembersSection canManage />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/nope/i)
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('validates the invite email inline before calling the API', async () => {
    const invite = vi.fn(async () => ({ member: member(), inviteToken: null, inviteExpiresAt: null }))
    installMembers(async () => [member()], invite)
    render(<MembersSection canManage />)
    await screen.findByText('sam@acme.co')
    await userEvent.click(screen.getByRole('button', { name: /invite member/i }))
    await userEvent.click(screen.getByRole('button', { name: /send invite/i }))
    expect(await screen.findByText(/valid email address/i)).toBeInTheDocument()
    expect(invite).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText(/email/i), 'new@acme.co')
    await userEvent.click(screen.getByRole('button', { name: /send invite/i }))
    await waitFor(() => expect(invite).toHaveBeenCalledWith({ email: 'new@acme.co', role: 'member' }))
  })
})
