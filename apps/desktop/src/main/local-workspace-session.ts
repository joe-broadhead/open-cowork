/**
 * Progressive local WorkspaceSessionPort wiring (post-#961 hardening).
 *
 * Adapts the process-local sessionEngine singleton behind the shared port so
 * high-traffic IPC can migrate off direct engine imports without inventing a
 * second session implementation.
 *
 * Scope today: only `getSessionView` is wired — that is what artifact-handlers
 * need. Other core port methods (`createSession`, `listSessions`, `promptSession`,
 * etc.) are intentionally unmapped: sessionEngine does not expose matching
 * shapes, and inventing stubs would fake a full IPC cutover. Callers that need
 * those operations still use sessionEngine (or cloud adapter) directly until a
 * later progressive PR maps them.
 */
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import {
  createLocalWorkspaceSessionPort,
  type WorkspaceSessionPort,
} from './workspace-session-port.ts'

let localPort: WorkspaceSessionPort | null = null

/**
 * Module-level local session port for progressive port-shaped surfaces.
 * Currently: getSessionView only. Other core methods throw
 * `Local WorkspaceSessionPort method not available` by design.
 */
export function getLocalSessionPort(): WorkspaceSessionPort {
  if (!localPort) {
    localPort = createLocalWorkspaceSessionPort({
      getSessionView: (sessionId) => sessionEngine.getSessionView(sessionId),
    })
  }
  return localPort
}
