import type { ScopedArtifactRef } from './custom-content.js'

export type DestructiveAction =
  | 'session.delete'
  | 'agent.remove'
  | 'mcp.remove'
  | 'skill.remove'
  | 'app.reset'

export type DestructiveConfirmationRequest =
  | {
      action: 'session.delete'
      sessionId: string
    }
  | {
      action: 'agent.remove' | 'mcp.remove' | 'skill.remove'
      target: ScopedArtifactRef
    }
  | {
      // Resets every piece of on-disk state owned by the app:
      // user-data dir, sandbox workspaces, and safeStorage credentials.
      action: 'app.reset'
    }

export interface DestructiveConfirmationGrant {
  token: string
  expiresAt: string
}
