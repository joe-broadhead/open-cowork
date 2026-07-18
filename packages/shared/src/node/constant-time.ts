/// <reference types="node" />
import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Canonical constant-time string comparison (audit 2026-07-18).
 *
 * Empty/missing inputs never match. Length mismatch short-circuits (lengths are
 * not treated as secret); for secret-length tokens prefer
 * {@link constantTimeEqualsDigest}.
 */
export function constantTimeEquals(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Compare secrets via fixed-length SHA-256 digests so comparison time never
 * depends on secret length or shared prefix (preferred for bearer tokens).
 */
export function constantTimeEqualsDigest(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}
