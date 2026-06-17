import type {
  ControlPlaneMembershipStatus,
  ControlPlaneRole,
  ControlPlaneStore,
  OrgMemberRecord,
} from '../control-plane-store.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import { signMembershipInviteToken, verifyMembershipInviteToken } from '../membership-invite-token.ts'
import {
  resolvedSignupMode,
  type CloudIdentityPolicy,
} from './api-token-policy.ts'
import {
  normalizeControlPlaneRole,
  normalizeEmailAddress,
  normalizeMembershipStatus,
  stableCloudId,
} from '../session-input-validation.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type PublicOrgMemberRecord = OrgMemberRecord

// Injected by the host so the cloud can email team invites without hard-coupling SMTP. Defaults
// to null (no-op) — the admin still receives the invite token in the API response to share.
export interface CloudEmailMessage { to: string; subject: string; text: string }
export interface CloudEmailSender { send(message: CloudEmailMessage): Promise<void> }

export type MembershipInviteResult = {
  member: PublicOrgMemberRecord
  inviteToken: string | null
  inviteExpiresAt: string | null
}

const MEMBERSHIP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type CloudMemberServiceOptions = {
  store: ControlPlaneStore
  identityPolicy: CloudIdentityPolicy
  inviteSigningSecret: string | Buffer | null
  emailSender: CloudEmailSender | null
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  assertOrgAdmin: (principal: CloudPrincipal) => void
  principalOrgId: (principal: CloudPrincipal) => string
}

export class CloudMemberService {
  private readonly store: ControlPlaneStore
  private readonly identityPolicy: CloudIdentityPolicy
  private readonly inviteSigningSecret: string | Buffer | null
  private readonly emailSender: CloudEmailSender | null
  private readonly ensurePrincipal: CloudMemberServiceOptions['ensurePrincipal']
  private readonly assertOrgAdmin: CloudMemberServiceOptions['assertOrgAdmin']
  private readonly principalOrgId: CloudMemberServiceOptions['principalOrgId']

  constructor(options: CloudMemberServiceOptions) {
    this.store = options.store
    this.identityPolicy = options.identityPolicy
    this.inviteSigningSecret = options.inviteSigningSecret
    this.emailSender = options.emailSender
    this.ensurePrincipal = options.ensurePrincipal
    this.assertOrgAdmin = options.assertOrgAdmin
    this.principalOrgId = options.principalOrgId
  }

  async listOrgMembers(
    principal: CloudPrincipal,
    input: { query?: string | null, limit?: number | null } = {},
  ): Promise<PublicOrgMemberRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertOrgAdmin(principal)
    return this.store.listOrgMembers(this.principalOrgId(principal), {
      query: input.query || null,
      limit: input.limit || 100,
    })
  }

  async inviteOrgMember(
    principal: CloudPrincipal,
    input: { email: string, role?: ControlPlaneRole | null },
  ): Promise<MembershipInviteResult> {
    await this.ensurePrincipal(principal)
    this.assertOrgAdmin(principal)
    const signupMode = resolvedSignupMode(this.identityPolicy)
    if (signupMode !== 'invite') {
      throw new CloudServiceError(403, 'Member invites are available only when cloud signup mode is invite.')
    }
    const email = normalizeEmailAddress(input.email)
    const role = normalizeControlPlaneRole(input.role || 'member')
    if (role === 'owner' && principal.role !== 'owner' && principal.authSource !== 'local') {
      throw new CloudServiceError(403, 'Only org owners can invite another owner.')
    }
    const orgId = this.principalOrgId(principal)
    const account = await this.store.createAccount({
      accountId: stableCloudId('account', orgId, email),
      email,
      idpSubject: null,
    })
    const membership = await this.store.upsertMembership({
      orgId,
      accountId: account.accountId,
      role,
      status: 'invited',
      actor: {
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        accountId: principal.accountId || principal.userId,
      },
    })
    const member: PublicOrgMemberRecord = {
      orgId,
      accountId: account.accountId,
      email: account.email,
      displayName: account.displayName,
      role: membership.role,
      status: membership.status,
      createdAt: membership.createdAt,
      updatedAt: membership.updatedAt,
    }
    const invite = this.buildMembershipInvite(orgId, account.accountId, account.email, membership.role)
    if (invite) await this.sendMembershipInviteEmail(account.email, invite.token)
    return { member, inviteToken: invite?.token ?? null, inviteExpiresAt: invite?.expiresAt ?? null }
  }

  // Mints a signed, expiring invite token (null when the server has no signing secret). The
  // returned plaintext token is shown to the admin once and embedded in the invite link.
  private buildMembershipInvite(
    orgId: string,
    accountId: string,
    email: string,
    role: ControlPlaneRole,
  ): { token: string, expiresAt: string } | null {
    if (!this.inviteSigningSecret) return null
    const exp = Date.now() + MEMBERSHIP_INVITE_TTL_MS
    const token = signMembershipInviteToken(this.inviteSigningSecret, { orgId, accountId, email, role, exp })
    return { token, expiresAt: new Date(exp).toISOString() }
  }

  // Best-effort: a failed email never fails the invite — the admin always receives the token in
  // the API response to share directly. No-op when no email sender is injected.
  private async sendMembershipInviteEmail(email: string, token: string): Promise<void> {
    if (!this.emailSender) return
    try {
      await this.emailSender.send({
        to: email,
        subject: 'You have been invited to a team',
        text: `You have been invited to join a team. Use this invite token to accept:\n\n${token}\n\nThis invite expires in 7 days.`,
      })
    } catch {
      // Swallow — issuance already succeeded and the token is returned to the inviter.
    }
  }

  // Token-based acceptance: the signed token is the authority, so this works regardless of signup
  // mode and without requiring the invitee to log in via a matching OIDC email first. The
  // membership row remains the source of truth — a revoked (disabled) membership cannot be
  // re-activated, and an already-active one accepts idempotently.
  async acceptMembershipInvite(token: string): Promise<{
    orgId: string
    accountId: string
    email: string
    role: ControlPlaneRole
    status: ControlPlaneMembershipStatus
  }> {
    if (!this.inviteSigningSecret) {
      throw new CloudServiceError(501, 'Team invites are not enabled: the cloud server has no signing secret configured.', { policyCode: 'invite.disabled' })
    }
    const payload = verifyMembershipInviteToken(this.inviteSigningSecret, token, Date.now())
    if (!payload) {
      throw new CloudServiceError(400, 'Invite link is invalid or has expired.', { policyCode: 'invite.invalid' })
    }
    const memberships = await this.store.listMembershipsForAccount(payload.accountId)
    const existing = memberships.find((entry) => entry.orgId === payload.orgId)
    if (!existing) {
      throw new CloudServiceError(404, 'This invite is no longer available.', { policyCode: 'invite.not_found' })
    }
    if (existing.status === 'disabled') {
      throw new CloudServiceError(403, 'This invite has been revoked.', { policyCode: 'invite.revoked' })
    }
    const membership = existing.status === 'active'
      ? existing
      : await this.store.upsertMembership({
        orgId: payload.orgId,
        accountId: payload.accountId,
        role: existing.role,
        status: 'active',
        actor: { actorType: 'system', actorId: 'membership.invite.accepted' },
      })
    return {
      orgId: payload.orgId,
      accountId: payload.accountId,
      email: payload.email,
      role: membership.role,
      status: membership.status,
    }
  }

  async updateOrgMember(
    principal: CloudPrincipal,
    accountId: string,
    input: {
      role?: ControlPlaneRole | null
      status?: ControlPlaneMembershipStatus | null
      confirm?: string | null
    },
  ): Promise<PublicOrgMemberRecord> {
    await this.ensurePrincipal(principal)
    this.assertOrgAdmin(principal)
    const orgId = this.principalOrgId(principal)
    const members = await this.store.listOrgMembers(orgId, { limit: 500 })
    const existing = members.find((member) => member.accountId === accountId)
    if (!existing) throw new CloudServiceError(404, 'Org member was not found.')
    const nextRole = input.role ? normalizeControlPlaneRole(input.role, existing.role) : existing.role
    const nextStatus = input.status ? normalizeMembershipStatus(input.status, existing.status) : existing.status
    if (nextRole === 'owner' && principal.role !== 'owner' && principal.authSource !== 'local') {
      throw new CloudServiceError(403, 'Only org owners can promote another owner.')
    }
    if (existing.role === 'owner' && principal.role !== 'owner' && principal.authSource !== 'local') {
      throw new CloudServiceError(403, 'Only org owners can change another owner.')
    }
    const currentActorAccountId = principal.accountId || principal.userId
    if (accountId === currentActorAccountId && nextRole !== existing.role) {
      throw new CloudServiceError(400, 'You cannot change your own org role.')
    }
    if (accountId === currentActorAccountId && nextStatus !== 'active') {
      throw new CloudServiceError(400, 'You cannot disable your own active membership.')
    }
    if (nextStatus === 'disabled' && input.confirm !== accountId) {
      throw new CloudServiceError(400, 'Disabling a member requires confirmation.')
    }
    const activeOwnerCount = members.filter((member) => member.role === 'owner' && member.status === 'active').length
    if (existing.role === 'owner' && existing.status === 'active' && (nextRole !== 'owner' || nextStatus !== 'active') && activeOwnerCount <= 1) {
      throw new CloudServiceError(400, 'Cannot remove or demote the last active owner.')
    }
    const updated = await this.store.upsertMembership({
      orgId,
      accountId,
      role: nextRole,
      status: nextStatus,
      actor: {
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        accountId: currentActorAccountId,
      },
    })
    return {
      orgId,
      accountId: existing.accountId,
      email: existing.email,
      displayName: existing.displayName,
      role: updated.role,
      status: updated.status,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    }
  }
}
