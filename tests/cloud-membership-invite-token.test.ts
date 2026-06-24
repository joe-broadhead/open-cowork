import test from 'node:test'
import assert from 'node:assert/strict'

import {
  signMembershipInviteToken,
  verifyMembershipInviteToken,
} from '@open-cowork/cloud-server/membership-invite-token'

const SIGNING_KEY = 'membership-invite-signing-secret-key'
const EXP = 2_000_000_000_000

test('membership invite token round-trips a signed payload before expiry', () => {
  const token = signMembershipInviteToken(SIGNING_KEY, {
    orgId: 'org-1', accountId: 'acc-1', email: 'invitee@example.test', role: 'member', exp: EXP,
  })
  assert.deepEqual(verifyMembershipInviteToken(SIGNING_KEY, token, EXP - 1000), {
    orgId: 'org-1', accountId: 'acc-1', email: 'invitee@example.test', role: 'member', exp: EXP,
  })
})

test('membership invite token rejects expiry, wrong secret, tampering, and malformed input', () => {
  const token = signMembershipInviteToken(SIGNING_KEY, {
    orgId: 'org-1', accountId: 'acc-1', email: 'invitee@example.test', role: 'admin', exp: EXP,
  })

  // Expired.
  assert.equal(verifyMembershipInviteToken(SIGNING_KEY, token, EXP + 1), null)
  // Wrong signing secret.
  assert.equal(verifyMembershipInviteToken('a-different-secret-key', token, EXP - 1), null)

  // Tampered payload (privilege escalation member→owner) keeps the old signature → rejected.
  const [, signature] = token.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({
    orgId: 'org-1', accountId: 'acc-1', email: 'invitee@example.test', role: 'owner', exp: EXP,
  })).toString('base64url')
  assert.equal(verifyMembershipInviteToken(SIGNING_KEY, `${forgedPayload}.${signature}`, EXP - 1), null)

  // Malformed inputs.
  assert.equal(verifyMembershipInviteToken(SIGNING_KEY, 'not-a-token', EXP - 1), null)
  assert.equal(verifyMembershipInviteToken(SIGNING_KEY, 'only-one-part.', EXP - 1), null)
  assert.equal(verifyMembershipInviteToken(SIGNING_KEY, '', EXP - 1), null)
})
