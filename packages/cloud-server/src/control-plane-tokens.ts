import { randomBytes, scryptSync } from 'node:crypto'
import { constantTimeEquals as constantTimeStringEqual } from '@open-cowork/shared/node'

const scryptHashPrefixV2 = 'scrypt-v2'

// Per-secret random-salt scrypt hash, shared by every credential family (cloud API
// tokens, channel-interaction tokens, managed-worker credentials). Each call mints a
// fresh 128-bit salt and stores it inline as `scrypt-v2:<salt>:<hash>`, so a DB-only
// compromise cannot precompute one scrypt table against every stored credential.
export function hashSecretWithRandomSalt(plaintext: string) {
  const salt = randomBytes(16).toString('base64url')
  return `${scryptHashPrefixV2}:${salt}:${scryptSync(plaintext, salt, 32).toString('base64url')}`
}

// Verify a v2 per-secret-salted scrypt hash. Any stored hash that is not in the
// `scrypt-v2:<salt>:<hash>` shape fails closed — there is no constant-salt legacy fallback.
export function verifySecretHash(plaintext: string, storedHash: string) {
  const parts = storedHash.split(':')
  if (parts[0] === scryptHashPrefixV2 && parts[1] && parts[2]) {
    return constantTimeStringEqual(scryptSync(plaintext, parts[1], 32).toString('base64url'), parts[2])
  }
  return false
}

export function hashCloudApiToken(plaintext: string) {
  return hashSecretWithRandomSalt(plaintext)
}

export function verifyCloudApiTokenHash(plaintext: string, tokenHash: string) {
  return verifySecretHash(plaintext, tokenHash)
}

export function plaintextMatchesCloudApiTokenId(plaintext: string, tokenId: string) {
  return plaintext.startsWith(`occ_${tokenId}_`)
}

export function hashChannelInteractionToken(plaintext: string) {
  return hashSecretWithRandomSalt(plaintext)
}

export function hashScimToken(plaintext: string) {
  return hashSecretWithRandomSalt(plaintext)
}

export function verifyScimTokenHash(plaintext: string, tokenHash: string) {
  return verifySecretHash(plaintext, tokenHash)
}

export function verifyChannelInteractionTokenHash(plaintext: string, tokenHash: string) {
  return verifySecretHash(plaintext, tokenHash)
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
