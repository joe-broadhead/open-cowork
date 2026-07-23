/**
 * Progressive local WorkspaceSessionPort wiring (JOE-995 / post-#961 hardening).
 *
 * Adapts the process-local sessionEngine singleton behind the shared port so
 * high-traffic IPC can migrate off direct engine imports without inventing a
 * second session implementation.
 *
 * Wired today (honest sessionEngine mappings only):
 * - getSessionView
 * - getSessionInfo (from engine meta + registry title when available)
 *
 * Other core port methods remain unmapped until sessionEngine exposes matching
 * shapes. Callers that need those still use sessionEngine / OpenCode client
 * directly — no fake cutover.
 */
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import { getSessionRecord } from '@open-cowork/runtime-host/session-registry'
import type { SessionInfo } from '@open-cowork/shared'
import {
  createLocalWorkspaceSessionPort,
  type WorkspaceSessionPort,
} from './workspace-session-port.ts'

let localPort: WorkspaceSessionPort | null = null

function localGetSessionInfo(sessionId: string): SessionInfo | null {
  const meta = sessionEngine.getSessionMeta(sessionId)
  if (!meta) return null
  const record = getSessionRecord(sessionId)
  const now = new Date(meta.lastEventAt || Date.now()).toISOString()
  return {
    id: sessionId,
    title: record?.title || sessionId,
    createdAt: record?.createdAt || now,
    updatedAt: record?.updatedAt || now,
  }
}

/**
 * Module-level local session port for progressive port-shaped surfaces.
 * Unmapped core methods throw `Local WorkspaceSessionPort method not available`.
 */
export function getLocalSessionPort(): WorkspaceSessionPort {
  if (!localPort) {
    localPort = createLocalWorkspaceSessionPort({
      getSessionView: (sessionId) => sessionEngine.getSessionView(sessionId),
      getSessionInfo: (sessionId) => localGetSessionInfo(sessionId),
    })
  }
  return localPort
}
