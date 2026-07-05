import { randomBytes, scryptSync } from 'node:crypto'
import { constantTimeEquals as constantTimeStringEqual } from '@open-cowork/shared/node'

const legacyCloudApiTokenSalt = 'open-cowork-cloud-api-token-hash-v1'
const channelInteractionTokenSalt = 'open-cowork-channel-interaction-token-v1'
const scryptHashPrefixV2 = 'scrypt-v2'

// Per-secret random-salt scrypt hash, shared by every credential family (cloud API
// tokens, channel-interaction tokens, managed-worker credentials). Each call mints a
// fresh 128-bit salt and stores it inline as `scrypt-v2:<salt>:<hash>`, so a DB-only
// compromise cannot precompute one scrypt table against every stored credential.
export function hashSecretWithRandomSalt(plaintext: string) {
  const salt = randomBytes(16).toString('base64url')
  return `${scryptHashPrefixV2}:${salt}:${scryptSync(plaintext, salt, 32).toString('base64url')}`
}

// Verify a v2 salted hash, falling back to the family's legacy constant-salt hash so
// credentials issued before the rotation keep authenticating until they are re-issued.
export function verifySecretHash(
  plaintext: string,
  storedHash: string,
  legacyHash: (plaintext: string) => string,
) {
  const parts = storedHash.split(':')
  if (parts[0] === scryptHashPrefixV2 && parts[1] && parts[2]) {
    return constantTimeStringEqual(scryptSync(plaintext, parts[1], 32).toString('base64url'), parts[2])
  }
  return constantTimeStringEqual(legacyHash(plaintext), storedHash)
}

export function hashCloudApiToken(plaintext: string) {
  return hashSecretWithRandomSalt(plaintext)
}

export function verifyCloudApiTokenHash(plaintext: string, tokenHash: string) {
  return verifySecretHash(plaintext, tokenHash, legacyCloudApiTokenHash)
}

export function plaintextMatchesCloudApiTokenId(plaintext: string, tokenId: string) {
  return plaintext.startsWith(`occ_${tokenId}_`)
}

export function hashChannelInteractionToken(plaintext: string) {
  return hashSecretWithRandomSalt(plaintext)
}

export function verifyChannelInteractionTokenHash(plaintext: string, tokenHash: string) {
  return verifySecretHash(plaintext, tokenHash, legacyChannelInteractionTokenHash)
}

export function plaintextMatchesChannelInteractionId(plaintext: string, interactionId: string) {
  return plaintext.startsWith(`occi_${interactionId}_`)
}

export function generateCloudApiToken(input: { tokenId?: string, secret?: string } = {}) {
  const tokenId = input.tokenId || `tok_${randomBytes(12).toString('base64url')}`
  const secret = input.secret || randomBytes(32).toString('base64url')
  return {
    tokenId,
    plaintext: `occ_${tokenId}_${secret}`,
  }
}

export function generateChannelInteractionToken(input: { interactionId: string, secret?: string }) {
  const secret = input.secret || randomBytes(24).toString('base64url')
  return `occi_${input.interactionId}_${secret}`
}

function legacyCloudApiTokenHash(plaintext: string) {
  return `scrypt:${scryptSync(plaintext, legacyCloudApiTokenSalt, 32).toString('base64url')}`
}

function legacyChannelInteractionTokenHash(plaintext: string) {
  return `scrypt:${scryptSync(plaintext, channelInteractionTokenSalt, 32).toString('base64url')}`
}
