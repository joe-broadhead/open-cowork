import { randomBytes, scryptSync } from 'node:crypto'

export function hashCloudApiToken(plaintext: string) {
  return `scrypt:${scryptSync(plaintext, 'open-cowork-cloud-api-token-hash-v1', 32).toString('base64url')}`
}

export function hashChannelInteractionToken(plaintext: string) {
  return `scrypt:${scryptSync(plaintext, 'open-cowork-channel-interaction-token-v1', 32).toString('base64url')}`
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
