import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell, waitForRuntimeReady } from './smoke-helpers.ts'

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
          artifactIndex: typeof api.artifact?.index,
          artifactReadAttachment: typeof api.artifact?.readAttachment,
          artifactUpdateStatus: typeof api.artifact?.updateStatus,
          channelsProviders: typeof api.channels?.providers,
          launchpadFeed: typeof api.launchpad?.feed,
          coordinationBoard: typeof api.coordination?.board,
          workspaceList: typeof api.workspace?.list,
          workspaceActivate: typeof api.workspace?.activate,
          desktopPairingList: typeof api.desktopPairing?.list,
          projectSourceValidate: typeof api.projectSource?.validate,
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
      artifactIndex: 'function',
      artifactReadAttachment: 'function',
      artifactUpdateStatus: 'function',
      channelsProviders: 'function',
      launchpadFeed: 'function',
      coordinationBoard: 'function',
      workspaceList: 'function',
      workspaceActivate: 'function',
      desktopPairingList: 'function',
      projectSourceValidate: 'function',
      onSessionPatch: 'function',
    })
    assert.deepEqual(surface.groups, [
      'admin',
      'agents',
      'app',
      'artifact',
      'auth',
      'capabilities',
      'channels',
      'chart',
      'clipboard',
      'command',
      'confirm',
      'coordination',
      'custom',
      'desktopPairing',
      'diagnostics',
      'dialog',
      'explorer',
      'knowledge',
      'launchpad',
      'mcp',
      'model',
      'on',
      'permission',
      'projectSource',
      'projects',
      'provider',
      'question',
      'runtime',
      'session',
      'settings',
      'threads',
      'tools',
      'updates',
      'workflows',
      'workspace',
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

test('rapid abort and prompt keeps the session event stream usable', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)
    await waitForRuntimeReady(page, 30_000)

    const result = await page.evaluate(async () => {
      const timeout = <T,>(promise: Promise<T>, label: string) => Promise.race([
        promise.then(
          () => ({ label, state: 'resolved' as const }),
          (error: unknown) => ({
            label,
            state: 'rejected' as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
        new Promise<{ label: string; state: 'timeout'; message: string }>((resolve) => {
          setTimeout(() => resolve({ label, state: 'timeout', message: `${label} timed out` }), 15_000)
        }),
      ])

      const session = await window.coworkApi.session.create()
      const observed: string[] = []
      const unsubscribe = window.coworkApi.on.sessionPatch((patch) => {
        if (patch.sessionId !== session.id) return
        const serialized = JSON.stringify(patch)
        if (serialized.includes('abort race prompt one')) observed.push('one')
        if (serialized.includes('abort race prompt two')) observed.push('two')
      })

      try {
        const firstPrompt = window.coworkApi.session.prompt(session.id, 'abort race prompt one')
        await new Promise((resolve) => setTimeout(resolve, 25))
        const abortResult = await timeout(window.coworkApi.session.abort(session.id), 'abort')
        const secondPrompt = window.coworkApi.session.prompt(session.id, 'abort race prompt two')
        const [firstResult, secondResult] = await Promise.all([
          timeout(firstPrompt, 'first prompt'),
          timeout(secondPrompt, 'second prompt'),
        ])
        for (let attempt = 0; attempt < 20 && !observed.includes('two'); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        return {
          abortResult,
          firstResult,
          secondResult,
          sawFirstPrompt: observed.includes('one'),
          sawSecondPrompt: observed.includes('two'),
        }
      } finally {
        unsubscribe()
      }
    })

    assert.notEqual(result.abortResult.state, 'timeout')
    assert.notEqual(result.firstResult.state, 'timeout')
    assert.notEqual(result.secondResult.state, 'timeout')
    assert.equal(result.sawFirstPrompt, true)
    assert.equal(result.sawSecondPrompt, true)
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
