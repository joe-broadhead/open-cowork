import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import {
  createResourceDeepLink,
  createResourceIdentity,
} from '../../../packages/shared/src/resource-identity.ts'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

const RECENT_SOURCE_TITLE = 'Navigation source thread'
const RECENT_TARGET_TITLE = 'Navigation target thread'
const RECENT_THREAD_MARKER = 'navigation-regression-marker'
const DEEP_LINK_THREAD_MARKER = 'canonical-resource-deep-link-marker'

function makeThreadIndexFixture(index: number) {
  const createdAt = new Date(Date.UTC(2026, 1, index + 1, 10, 0, 0)).toISOString()
  const updatedAt = new Date(Date.UTC(2026, 1, index + 1, 11, 0, 0)).toISOString()
  return {
    id: `threads_view_fixture_${index}`,
    title: `Threads workspace fixture ${index + 1}`,
    directory: null,
    opencodeDirectory: '/tmp/open-cowork-threads-fixture',
    createdAt,
    updatedAt,
    kind: 'interactive',
    automationId: null,
    runId: null,
    providerId: index % 2 === 0 ? 'openrouter' : 'codex',
    modelId: index % 2 === 0 ? 'openrouter/sonnet' : 'codex/gpt-5',
    summary: null,
    parentSessionId: null,
    changeSummary: null,
    revertedMessageId: null,
    managedByCowork: true as const,
  }
}

test('sidebar Projects button opens the indexed Projects workspace', async () => {
  const fixtures = Array.from({ length: 6 }, (_, index) => makeThreadIndexFixture(index))
  const { page, cleanup } = await launchSmokeApp({
    seedBeforeLaunch: ({ dataRoot }) => {
      writeFileSync(join(dataRoot, 'sessions.json'), JSON.stringify(fixtures, null, 2))
    },
  })

  try {
    await waitForAppShell(page, 30_000)
    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search projects' }).waitFor({ timeout: 10_000 })
    await page.locator('main').getByText('Threads workspace fixture 6', { exact: true }).waitFor({ timeout: 10_000 })

    const indexedCount = await page.evaluate(async () => {
      const result = await window.coworkApi.threads.search({ text: 'Threads workspace fixture', limit: 10 })
      return result.threads.length
    })
    assert.equal(indexedCount, fixtures.length)
  } finally {
    await cleanup()
  }
})

test('workspace switcher lists standalone Gateway authorities without Cloud', async () => {
  const { page, cleanup } = await launchSmokeApp({
    seedBeforeLaunch: ({ dataRoot }) => {
      writeFileSync(join(dataRoot, 'gateway-workspaces.json'), JSON.stringify([{
        id: 'gateway:smoke',
        baseUrl: 'http://127.0.0.1:8799',
        label: 'Smoke Gateway',
        lastSyncedAt: null,
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }], null, 2))
    },
  })

  try {
    await waitForAppShell(page, 30_000)
    await page.getByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i }).click()
    await page.getByRole('menuitem', { name: /Smoke Gateway.*Auth required.*Standalone Gateway/i }).click()

    const active = await page.evaluate(async () => {
      const workspaces = await window.coworkApi.workspace.list()
      const workspace = workspaces.find((entry) => entry.id === 'gateway:smoke')
      const support = await window.coworkApi.workspace.support('gateway:smoke')
      return {
        kind: workspace?.kind,
        authority: workspace?.authority,
        active: workspace?.active,
        sessionListStatus: support.find((entry) => entry.api === 'sessions.list')?.status,
      }
    })
    assert.deepEqual(active, {
      kind: 'gateway',
      authority: 'gateway_standalone',
      active: true,
      sessionListStatus: 'deferred',
    })
  } finally {
    await cleanup()
  }
})

test('home launchpad in-motion row routes through the real session activation path', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)

    const sourceId = await page.evaluate(async ({ sourceTitle, marker }) => {
      const source = await window.coworkApi.session.create()
      await window.coworkApi.session.rename(source.id, sourceTitle)
      await window.coworkApi.session.activate(source.id)
      try {
        await window.coworkApi.session.prompt(source.id, marker)
      } catch {
        // The smoke harness uses fake provider credentials. We only need
        // the optimistic user turn to persist so the source transcript is
        // observably different from the empty target thread.
      }

      return source.id
    }, {
      sourceTitle: RECENT_SOURCE_TITLE,
      marker: RECENT_THREAD_MARKER,
    })

    await page.waitForFunction(({ id, marker }) => {
      const state = window as unknown as {
        __openCoworkRecentThreadProbe?: {
          id: string
          marker: string
          found: boolean
          inFlight: boolean
        }
      }
      const current = state.__openCoworkRecentThreadProbe
      if (!current || current.id !== id || current.marker !== marker) {
        state.__openCoworkRecentThreadProbe = { id, marker, found: false, inFlight: false }
      }
      if (state.__openCoworkRecentThreadProbe.inFlight) {
        return state.__openCoworkRecentThreadProbe.found
      }
      state.__openCoworkRecentThreadProbe.inFlight = true
      void window.coworkApi.session.activate(id, { force: true })
        .then((view) => {
          state.__openCoworkRecentThreadProbe = {
            id,
            marker,
            found: view.messages.some((message) => message.content.includes(marker)),
            inFlight: false,
          }
        })
        .catch(() => {
          state.__openCoworkRecentThreadProbe = { id, marker, found: false, inFlight: false }
        })
      return state.__openCoworkRecentThreadProbe?.found === true
    }, {
      id: sourceId,
      marker: RECENT_THREAD_MARKER,
    }, { timeout: 15_000 })

    await page.evaluate(async ({ sourceTitle, targetTitle, sourceSessionId }) => {
      const project = await window.coworkApi.coordination.createProject({
        title: 'Navigation launchpad project',
        objective: 'Exercise Home launchpad routing through real coordination feed rows.',
        team: ['build'],
      })
      await window.coworkApi.coordination.createTask({
        projectId: project.id,
        title: sourceTitle,
        spec: 'Open the source thread from the Home launchpad.',
        status: 'running',
        column: 'doing',
        priority: 'high',
        assigneeAgent: 'build',
        assignedSessionId: sourceSessionId,
      })
      const target = await window.coworkApi.session.create()
      await window.coworkApi.session.rename(target.id, targetTitle)
      await window.coworkApi.coordination.createTask({
        projectId: project.id,
        title: targetTitle,
        spec: 'Open the target thread from the Home launchpad.',
        status: 'running',
        column: 'doing',
        priority: 'med',
        assigneeAgent: 'build',
        assignedSessionId: target.id,
      })
    }, {
      sourceTitle: RECENT_SOURCE_TITLE,
      targetTitle: RECENT_TARGET_TITLE,
      sourceSessionId: sourceId,
    })

    await page.reload()
    await waitForAppShell(page, 30_000)

    const launchpadMotion = page.locator('main .home-motion')
    await launchpadMotion.getByText('In motion', { exact: true }).waitFor({ timeout: 10_000 })
    await launchpadMotion.getByRole('button', { name: new RegExp(RECENT_SOURCE_TITLE) }).click()
    await page.getByText(RECENT_THREAD_MARKER, { exact: false }).waitFor({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Home', exact: true }).first().click()
    await launchpadMotion.getByRole('button', { name: new RegExp(RECENT_TARGET_TITLE) }).click()
    await page.getByTestId('chat-thread-title').getByText(RECENT_TARGET_TITLE, { exact: true }).waitFor({ timeout: 10_000 })

    const markerCount = await page.getByText(RECENT_THREAD_MARKER, { exact: false }).count()
    assert.equal(markerCount, 0, 'switching via Home launchpad rows should hydrate the selected thread, not keep the prior transcript visible')
  } finally {
    await cleanup()
  }
})

test('canonical local session deep link opens the exact thread', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)

    const sessionId = await page.evaluate(async ({ marker }) => {
      const session = await window.coworkApi.session.create()
      await window.coworkApi.session.rename(session.id, 'Deep link target thread')
      try {
        await window.coworkApi.session.prompt(session.id, marker)
      } catch {
        // The smoke harness has fake provider credentials. The optimistic
        // user turn is enough to prove the exact session was hydrated.
      }
      return session.id
    }, { marker: DEEP_LINK_THREAD_MARKER })

    const deepLink = createResourceDeepLink(createResourceIdentity({
      authority: 'desktop-local',
      kind: 'session',
      workspaceId: 'local',
      sessionId,
    }))

    await page.getByRole('button', { name: 'Home', exact: true }).first().click()
    await page.evaluate((link) => {
      window.dispatchEvent(new CustomEvent('open-cowork:open-resource', {
        detail: { deepLink: link },
      }))
    }, deepLink)

    await page.getByText(DEEP_LINK_THREAD_MARKER, { exact: false }).waitFor({ timeout: 15_000 })
    const noticeCount = await page.getByTestId('resource-navigation-notice').count()
    assert.equal(noticeCount, 0)
  } finally {
    await cleanup()
  }
})

test('search shortcut reveals the sidebar search when the sidebar is collapsed', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)

    await page.locator('.drag button').first().click()
    await page.getByRole('button', { name: 'Home', exact: true }).first().waitFor({ state: 'hidden', timeout: 10_000 })

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-cowork:toggle-search')))
    await page.getByPlaceholder(/Search projects and chats/i).waitFor({ timeout: 10_000 })
  } finally {
    await cleanup()
  }
})

test('settings shortcut reveals the sidebar settings when the sidebar is collapsed', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)

    await page.locator('.drag button').first().click()
    await page.getByRole('button', { name: 'Home', exact: true }).first().waitFor({ state: 'hidden', timeout: 10_000 })

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-cowork:open-settings')))
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Close dialog' }).waitFor({ timeout: 10_000 })
  } finally {
    await cleanup()
  }
})
