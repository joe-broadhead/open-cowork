import type {
  DestructiveConfirmationRequest,
  ScopedArtifactRef,
} from '@open-cowork/shared'

async function requestToken(request: DestructiveConfirmationRequest) {
  return window.coworkApi.confirm.requestDestructive(request)
}

export async function confirmSessionDelete(sessionId: string) {
  return requestToken({ action: 'session.delete', sessionId })
}

export async function confirmCrewDelete(crewId: string) {
  return requestToken({ action: 'crew.delete', crewId })
}

export async function confirmCrewRetire(crewId: string) {
  return requestToken({ action: 'crew.retire', crewId })
}

export async function confirmAgentRemoval(target: ScopedArtifactRef) {
  return requestToken({ action: 'agent.remove', target })
}

export async function confirmMcpRemoval(target: ScopedArtifactRef) {
  return requestToken({ action: 'mcp.remove', target })
}

export async function confirmSkillRemoval(target: ScopedArtifactRef) {
  return requestToken({ action: 'skill.remove', target })
}

export async function confirmAppReset() {
  return requestToken({ action: 'app.reset' })
}
