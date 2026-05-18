import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

test('preload exposes the expected coworkApi surface', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)
    const surface = await page.evaluate(() => {
      const api = window.coworkApi as unknown as Record<string, Record<string, unknown>>
      return {
        groups: Object.keys(api).sort(),
        selectedLeaves: {
          sessionCreate: typeof api.session?.create,
          sessionPrompt: typeof api.session?.prompt,
          settingsSet: typeof api.settings?.set,
          customAddSkill: typeof api.custom?.addSkill,
          workflowsStartDraft: typeof api.workflows?.startDraft,
          chartRenderSvg: typeof api.chart?.renderSvg,
          artifactReadAttachment: typeof api.artifact?.readAttachment,
          onSessionPatch: typeof api.on?.sessionPatch,
        },
      }
    })

    assert.deepEqual(surface.selectedLeaves, {
      sessionCreate: 'function',
      sessionPrompt: 'function',
      settingsSet: 'function',
      customAddSkill: 'function',
      workflowsStartDraft: 'function',
      chartRenderSvg: 'function',
      artifactReadAttachment: 'function',
      onSessionPatch: 'function',
    })
    assert.deepEqual(surface.groups, [
      'agents',
      'app',
      'artifact',
      'auth',
      'capabilities',
      'chart',
      'clipboard',
      'command',
      'confirm',
      'custom',
      'diagnostics',
      'dialog',
      'explorer',
      'mcp',
      'model',
      'on',
      'permission',
      'provider',
      'question',
      'runtime',
      'session',
      'settings',
      'threads',
      'tools',
      'updates',
      'workflows',
    ])
  } finally {
    await cleanup()
  }
})

test('renderer prompt IPC emits an optimistic session patch before runtime failure', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)
    const observed = await page.evaluate(async () => {
      const session = await window.coworkApi.session.create()
      const patches: unknown[] = []
      const unsubscribe = window.coworkApi.on.sessionPatch((patch) => {
        if (patch.sessionId === session.id) patches.push(patch)
      })
      try {
        await window.coworkApi.session.prompt(session.id, 'preload roundtrip smoke')
      } catch {
        // The smoke config intentionally has no real provider credentials.
      } finally {
        unsubscribe()
      }
      return patches.some((patch) => JSON.stringify(patch).includes('preload roundtrip smoke'))
    })

    assert.equal(observed, true)
  } finally {
    await cleanup()
  }
})

test('auth IPC round-trips through preload and main process', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)
    const states = await page.evaluate(async () => ({
      before: await window.coworkApi.auth.status(),
      login: await window.coworkApi.auth.login(),
      logout: await window.coworkApi.auth.logout(),
      after: await window.coworkApi.auth.status(),
    }))

    assert.deepEqual(states, {
      before: { authenticated: true, email: null },
      login: { authenticated: true, email: null },
      logout: { authenticated: true, email: null },
      after: { authenticated: true, email: null },
    })
  } finally {
    await cleanup()
  }
})
