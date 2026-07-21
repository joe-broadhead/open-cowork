/**
 * Shared OpenCode V2 client kernel (audit 2026-07-21 P1-2 / JOE-943).
 *
 * Desktop runtime-host, cloud-server, and standalone-gateway construct the
 * native V2 client through this module so spawn/client wiring cannot drift.
 * Session API call shapes and event pumps remain product-owned; this kernel
 * owns client construction, authenticated config, and health probes.
 *
 * Does not invent classic→V2 shims for non-working routes on pin 1.18.1.
 * Durable Gateway remains on classic root `@opencode-ai/sdk` until JOE-941.
 */
import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeClientConfig,
} from '@opencode-ai/sdk/v2'

export type OpencodeV2Client = OpencodeClient
export type OpencodeV2ClientConfig = OpencodeClientConfig

export type ManagedOpencodeAuthLike = {
  authorizationHeader: string
}

/** Construct the native OpenCode SDK v2 client (shared kernel entry). */
export function createOpencodeV2Client(config: OpencodeV2ClientConfig): OpencodeV2Client {
  return createOpencodeClient(config)
}

/**
 * Shared client config for managed OpenCode servers that use Basic/bearer
 * Authorization (desktop managed runtime + cloud worker). Optional directory
 * scopes V2 location-sensitive routes (Standalone pattern).
 */
export function buildAuthenticatedOpencodeV2ClientConfig(
  baseUrl: string,
  auth: ManagedOpencodeAuthLike,
  directory?: string | null,
): OpencodeV2ClientConfig & { directory?: string } {
  return {
    baseUrl,
    headers: {
      Authorization: auth.authorizationHeader,
    },
    ...(directory ? { directory } : {}),
  }
}

/** Convenience: config + construct for managed-server clients. */
export function createAuthenticatedOpencodeV2Client(
  baseUrl: string,
  auth: ManagedOpencodeAuthLike,
  directory?: string | null,
): OpencodeV2Client {
  return createOpencodeV2Client(buildAuthenticatedOpencodeV2ClientConfig(baseUrl, auth, directory))
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
