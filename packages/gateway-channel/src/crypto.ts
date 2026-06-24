import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets, signatures, and tokens.
 *
 * Single source of truth for the gateway daemon and every channel provider
 * (Slack/Telegram/webhook/email signature + shared-secret checks), which had
 * each carried a slightly drifted copy. Empty or non-string inputs return
 * false so a missing/blank expected secret can never authenticate, and a
 * length mismatch short-circuits before timingSafeEqual (which throws on
 * unequal-length buffers).
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
