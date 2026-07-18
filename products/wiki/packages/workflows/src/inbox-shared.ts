import { createHash } from "node:crypto";

export const DEFAULT_INBOX_MAX_BYTES = 10 * 1024 * 1024;

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
