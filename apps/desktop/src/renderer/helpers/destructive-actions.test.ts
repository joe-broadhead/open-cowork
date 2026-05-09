import { describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../test/setup'
import {
  confirmAgentRemoval,
  confirmAppReset,
  confirmMcpRemoval,
  confirmSessionDelete,
  confirmSkillRemoval,
} from './destructive-actions'

describe('renderer destructive-action helpers', () => {
  it('delegates every destructive confirmation to the main-owned confirmation API', async () => {
    const requestDestructive = vi.fn(async (request) => ({
      token: `token:${request.action}`,
      expiresAt: '2026-05-09T12:00:30.000Z',
    }))
    installRendererTestCoworkApi({
      confirm: { requestDestructive },
    })

    await expect(confirmSessionDelete('session-1')).resolves.toMatchObject({ token: 'token:session.delete' })
    await expect(confirmAgentRemoval({ name: 'analyst', scope: 'machine', directory: null })).resolves.toMatchObject({ token: 'token:agent.remove' })
    await expect(confirmMcpRemoval({ name: 'github', scope: 'project', directory: '/repo' })).resolves.toMatchObject({ token: 'token:mcp.remove' })
    await expect(confirmSkillRemoval({ name: 'chart-creator', scope: 'machine', directory: null })).resolves.toMatchObject({ token: 'token:skill.remove' })
    await expect(confirmAppReset()).resolves.toMatchObject({ token: 'token:app.reset' })

    expect(requestDestructive).toHaveBeenNthCalledWith(1, { action: 'session.delete', sessionId: 'session-1' })
    expect(requestDestructive).toHaveBeenNthCalledWith(2, {
      action: 'agent.remove',
      target: { name: 'analyst', scope: 'machine', directory: null },
    })
    expect(requestDestructive).toHaveBeenNthCalledWith(3, {
      action: 'mcp.remove',
      target: { name: 'github', scope: 'project', directory: '/repo' },
    })
    expect(requestDestructive).toHaveBeenNthCalledWith(4, {
      action: 'skill.remove',
      target: { name: 'chart-creator', scope: 'machine', directory: null },
    })
    expect(requestDestructive).toHaveBeenNthCalledWith(5, { action: 'app.reset' })
  })
})
