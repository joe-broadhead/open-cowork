import type { OpencodeClient } from '@opencode-ai/sdk/v2'

/**
 * Typed process-wide holder for the daemon's live OpenCode client.
 *
 * The heartbeat and other long-lived timers need the client the daemon created
 * at boot without threading it through every call site. A module-level binding
 * replaces the previous untyped `(globalThis as any).__gatewayClient` global:
 * one process owns one daemon, so a module singleton is the right scope and it
 * keeps the accessor fully typed.
 */
let daemonClient: OpencodeClient | undefined

export function setDaemonClient(client: OpencodeClient): void {
  daemonClient = client
}

export function getDaemonClient(): OpencodeClient | undefined {
  return daemonClient
}
