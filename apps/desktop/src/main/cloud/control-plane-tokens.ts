import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const legacyCloudApiTokenSalt = 'open-cowork-cloud-api-token-hash-v1'
const channelInteractionTokenSalt = 'open-cowork-channel-interaction-token-v1'
const cloudApiTokenHashPrefix = 'scrypt-v2'

export function hashCloudApiToken(plaintext: string) {
  const salt = randomBytes(16).toString('base64url')
  return `${cloudApiTokenHashPrefix}:${salt}:${scryptSync(plaintext, salt, 32).toString('base64url')}`
}

export function verifyCloudApiTokenHash(plaintext: string, tokenHash: string) {
  const parts = tokenHash.split(':')
  if (parts[0] === cloudApiTokenHashPrefix && parts[1] && parts[2]) {
    return constantTimeStringEqual(
      scryptSync(plaintext, parts[1], 32).toString('base64url'),
      parts[2],
    )
  }
  return constantTimeStringEqual(legacyCloudApiTokenHash(plaintext), tokenHash)
}

export function plaintextMatchesCloudApiTokenId(plaintext: string, tokenId: string) {
  return plaintext.startsWith(`occ_${tokenId}_`)
}

export function hashChannelInteractionToken(plaintext: string) {
  return `scrypt:${scryptSync(plaintext, channelInteractionTokenSalt, 32).toString('base64url')}`
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

function constantTimeStringEqual(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
