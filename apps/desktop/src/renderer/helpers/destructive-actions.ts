import type {
  DestructiveConfirmationRequest,
  ScopedArtifactRef,
} from '@open-cowork/shared'

async function requestToken(request: DestructiveConfirmationRequest, message: string) {
  if (!window.confirm(message)) return null
  return window.coworkApi.confirm.requestDestructive(request)
}

export async function confirmSessionDelete(sessionId: string) {
  return requestToken(
    { action: 'session.delete', sessionId },
    'Delete this thread? This cannot be undone.',
  )
}

export async function confirmAgentRemoval(target: ScopedArtifactRef) {
  return requestToken(
    { action: 'agent.remove', target },
    `Delete agent "${target.name}"? This cannot be undone.`,
  )
}

export async function confirmMcpRemoval(target: ScopedArtifactRef) {
  return requestToken(
    { action: 'mcp.remove', target },
    `Remove MCP "${target.name}"? This cannot be undone.`,
  )
}

export async function confirmSkillRemoval(target: ScopedArtifactRef) {
  return requestToken(
    { action: 'skill.remove', target },
    `Remove skill "${target.name}"? This cannot be undone.`,
  )
}

export async function confirmAppReset() {
  return requestToken(
    { action: 'app.reset' },
    'Reset all app data?\n\nThis deletes every saved thread, credential, custom agent, skill, and MCP from this machine. The app will relaunch with a fresh first-run experience. This cannot be undone.',
  )
}
