import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets, signatures, and tokens.
 *
 * Kept package-local (gateway-channel has no composite rootDir for shared/node
 * source imports). Algorithm matches `@open-cowork/shared/node` `constantTimeEquals`
 * — both must stay byte-compatible (audit 2026-07-18).
 *
 * Empty or non-string inputs return false so a missing/blank expected secret
 * can never authenticate.
 */
export function constantTimeStringEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
