import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import { constantTimeEquals as constantTimeStringEqual } from '@open-cowork/shared/node'

// scrypt is CPU-bound; running it via the async binding hands the work to libuv's
// threadpool instead of blocking the Node event loop, so a burst of token hashes/
// verifies under load cannot starve SSE or other request handling.
const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>

const scryptHashPrefixV2 = 'scrypt-v2'

// Per-secret random-salt scrypt hash, shared by every credential family (cloud API
// tokens, channel-interaction tokens, managed-worker credentials). Each call mints a
// fresh 128-bit salt and stores it inline as `scrypt-v2:<salt>:<hash>`, so a DB-only
// compromise cannot precompute one scrypt table against every stored credential.
export async function hashSecretWithRandomSalt(plaintext: string) {
  const salt = randomBytes(16).toString('base64url')
  const derived = await scrypt(plaintext, salt, 32)
  return `${scryptHashPrefixV2}:${salt}:${derived.toString('base64url')}`
}

// Verify a v2 per-secret-salted scrypt hash. Any stored hash that is not in the
// `scrypt-v2:<salt>:<hash>` shape fails closed — there is no constant-salt fallback.
export async function verifySecretHash(plaintext: string, storedHash: string) {
  const parts = storedHash.split(':')
  if (parts[0] === scryptHashPrefixV2 && parts[1] && parts[2]) {
    const derived = await scrypt(plaintext, parts[1], 32)
    return constantTimeStringEqual(derived.toString('base64url'), parts[2])
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
