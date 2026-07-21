/**
 * Shared OpenCode V2 client kernel (audit 2026-07-21 P1-2).
 *
 * Desktop runtime-host and cloud-server both need a consistent way to construct
 * the native V2 client. Session API call shapes remain product-owned; this module
 * only owns client construction + health probe helpers so spawn/client wiring
 * cannot drift independently.
 *
 * Does not invent classic→V2 shims for non-working routes on pin 1.18.1.
 */
import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeClientConfig,
} from '@opencode-ai/sdk/v2'

export type OpencodeV2Client = OpencodeClient
export type OpencodeV2ClientConfig = OpencodeClientConfig

/** Construct the native OpenCode SDK v2 client (shared kernel entry). */
export function createOpencodeV2Client(config: OpencodeV2ClientConfig): OpencodeV2Client {
  return createOpencodeClient(config)
}

/**
 * Best-effort health probe against a V2 client. Returns false on missing
 * native health API or transport failure — never throws for probe use.
 */
export async function probeOpencodeV2Health(
  client: OpencodeV2Client,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const health = client.v2?.health
    if (!health || typeof health.get !== 'function') {
      return { ok: false, detail: 'OpenCode SDK v2 health API unavailable' }
    }
    await health.get({ throwOnError: true })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
