import type {
  DestructiveConfirmationRequest,
  ScopedArtifactRef,
} from '@open-cowork/shared'
import { t } from './i18n'

async function requestToken(request: DestructiveConfirmationRequest, message: string) {
  if (!window.confirm(message)) return null
  return window.coworkApi.confirm.requestDestructive(request)
}

export async function confirmSessionDelete(sessionId: string) {
  return requestToken(
    { action: 'session.delete', sessionId },
    t('thread.deleteConfirm', 'Delete this thread? This cannot be undone.'),
  )
}

export async function confirmAgentRemoval(target: ScopedArtifactRef) {
  return requestToken(
    { action: 'agent.remove', target },
    t('agent.deleteConfirm', 'Delete agent "{{name}}"? This cannot be undone.', { name: target.name }),
  )
}

export async function confirmMcpRemoval(target: ScopedArtifactRef) {
  return requestToken(
    { action: 'mcp.remove', target },
    t('mcp.deleteConfirm', 'Remove MCP "{{name}}"? This cannot be undone.', { name: target.name }),
  )
}

export async function confirmSkillRemoval(target: ScopedArtifactRef) {
  return requestToken(
    { action: 'skill.remove', target },
    t('skill.deleteConfirm', 'Remove skill "{{name}}"? This cannot be undone.', { name: target.name }),
  )
}

export async function confirmAppReset() {
  return requestToken(
    { action: 'app.reset' },
    t(
      'settings.reset.confirm',
      'Reset all app data?\n\nThis deletes every saved thread, credential, custom agent, skill, and MCP from this machine. The app will relaunch with a fresh first-run experience. This cannot be undone.',
    ),
  )
}
