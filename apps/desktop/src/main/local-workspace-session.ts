/**
 * Progressive local WorkspaceSessionPort wiring (post-#961 hardening).
 *
 * Adapts the process-local sessionEngine singleton behind the shared port so
 * high-traffic IPC can migrate off direct engine imports without inventing a
 * second session implementation.
 */
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import {
  createLocalWorkspaceSessionPort,
  type WorkspaceSessionPort,
} from './workspace-session-port.ts'

let localPort: WorkspaceSessionPort | null = null

/**
 * Module-level local session port wrapping methods that exist on sessionEngine.
 * Full IPC cutover remains progressive; callers should prefer this over raw
 * sessionEngine for port-shaped surfaces (getSessionView first).
 */
export function getLocalSessionPort(): WorkspaceSessionPort {
  if (!localPort) {
    localPort = createLocalWorkspaceSessionPort({
      getSessionView: (sessionId) => sessionEngine.getSessionView(sessionId),
    })
  }
  return localPort
}
