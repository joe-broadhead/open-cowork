/// <reference types="node" />
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { constantTimeEquals, constantTimeEqualsDigest } from './constant-time.js'

/**
 * Shared channel webhook security primitives (audit P1-1 / JOE-934).
 *
 * Prefer this module over copy-pasted HMAC/Ed25519 verifiers in either
 * Durable Gateway (`products/gateway/src/channels/*`) or monorepo providers.
 * Bridge-mode providers that re-sign with Open Cowork ingress signatures
 * should keep using `gateway-provider-webhook` helpers; native platform
 * verify lives here.
 */

const ED25519_SPKI_DER_PREFIX = '302a300506032b6570032100'

/** Meta / WhatsApp Cloud API: `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyMetaHubSignature256(
  appSecret: string | null | undefined,
  signatureHeader: string | string[] | null | undefined,
  rawBody: string,
): boolean {
  const secret = String(appSecret || '')
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
  if (!secret || !header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const actual = header.slice('sha256='.length)
  try {
    const expectedBuffer = Buffer.from(expected, 'hex')
    const actualBuffer = Buffer.from(actual, 'hex')
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  } catch {
    return false
  }
}

/** Meta webhook challenge: hub.verify_token must match configured token. */
export function verifyMetaHubVerifyToken(
  expectedToken: string | null | undefined,
  providedToken: string | null | undefined,
): boolean {
  return constantTimeEqualsDigest(String(expectedToken || ''), String(providedToken || ''))
}

/**
 * Discord interactions: Ed25519 over `timestamp + rawBody` with app public key.
 * Returns false on missing/malformed inputs or verification failure.
 */
export function verifyDiscordInteractionSignature(
  publicKeyHex: string | null | undefined,
  signatureHex: string | null | undefined,
  timestamp: string | null | undefined,
  rawBody: string,
): boolean {
  if (!publicKeyHex || !signatureHex || !timestamp) return false
  try {
    const keyBytes = Buffer.from(publicKeyHex, 'hex')
    const signature = Buffer.from(signatureHex, 'hex')
    if (keyBytes.length !== 32 || signature.length !== 64) return false
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from(ED25519_SPKI_DER_PREFIX, 'hex'), keyBytes]),
      format: 'der',
      type: 'spki',
    })
    return verifySignature(null, Buffer.from(timestamp + rawBody), key, signature)
  } catch {
    return false
  }
}

/** Telegram Bot API: `X-Telegram-Bot-Api-Secret-Token` constant-time compare. */
export function verifyTelegramWebhookSecretToken(
  expectedSecret: string | null | undefined,
  providedSecret: string | null | undefined,
): boolean {
  return constantTimeEqualsDigest(String(expectedSecret || ''), String(providedSecret || ''))
}

const DEFAULT_SLACK_SIGNATURE_MAX_SKEW_SECONDS = 60 * 5

/**
 * Slack Events / Interactions: `X-Slack-Signature: v0=<hex>` over
 * `v0:{timestamp}:{rawBody}` with the app signing secret.
 *
 * Also enforces timestamp skew (default 5 minutes). Replay caches remain
 * product-local (providers keep their own seen-signature maps).
 */
export function verifySlackRequestSignature(
  signingSecret: string | null | undefined,
  signatureHeader: string | string[] | null | undefined,
  timestampHeader: string | string[] | null | undefined,
  rawBody: string,
  options: { maxSkewSeconds?: number; nowMs?: number } = {},
): boolean {
  const secret = String(signingSecret || '')
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader
  if (!secret || !signature || !timestamp || !rawBody) return false
  if (!signature.startsWith('v0=')) return false
  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) return false
  const nowMs = options.nowMs ?? Date.now()
  const maxSkewSeconds = options.maxSkewSeconds ?? DEFAULT_SLACK_SIGNATURE_MAX_SKEW_SECONDS
  if (Math.abs(nowMs / 1000 - timestampSeconds) > maxSkewSeconds) return false
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
  return constantTimeEquals(signature, expected)
}
