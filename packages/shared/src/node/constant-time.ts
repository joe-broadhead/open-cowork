import { timingSafeEqual } from 'node:crypto'

// Single canonical constant-time string comparison (audit P3-7) — collapses the 6–8 cloud-server
// copies across three spellings. Includes the falsy guard the copies omitted: empty/missing inputs
// never match, so a misconfigured empty secret can't be bypassed by an empty provided value. The
// length check is allowed to short-circuit (lengths aren't secret) and gives timingSafeEqual the
// equal-length buffers it requires.
export function constantTimeEquals(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
