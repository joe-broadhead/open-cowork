import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

const RECENT_SOURCE_TITLE = 'Navigation source thread'
const RECENT_TARGET_TITLE = 'Navigation target thread'
const RECENT_THREAD_MARKER = 'navigation-regression-marker'

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

test('sidebar Threads button opens the indexed Threads workspace', async () => {
  const fixtures = Array.from({ length: 6 }, (_, index) => makeThreadIndexFixture(index))
  const { page, cleanup } = await launchSmokeApp({
    seedBeforeLaunch: ({ dataRoot }) => {
      writeFileSync(join(dataRoot, 'sessions.json'), JSON.stringify(fixtures, null, 2))
    },
  })

  try {
    await waitForAppShell(page, 30_000)
    await page.getByRole('button', { name: 'Threads', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search threads' }).waitFor({ timeout: 10_000 })
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

test('home recent-thread CTA routes through the real session activation path', async () => {
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

    await page.evaluate(async (targetTitle) => {
      const target = await window.coworkApi.session.create()
      await window.coworkApi.session.rename(target.id, targetTitle)
    }, RECENT_TARGET_TITLE)

    await page.reload()
    await waitForAppShell(page, 30_000)

    await page.locator('main').getByRole('button', { name: RECENT_SOURCE_TITLE }).click()
    await page.getByText(RECENT_THREAD_MARKER, { exact: false }).waitFor({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Home', exact: true }).first().click()
    await page.locator('main').getByRole('button', { name: RECENT_TARGET_TITLE }).click()
    await page.locator('main').getByText(RECENT_TARGET_TITLE, { exact: true }).waitFor({ timeout: 10_000 })

    const markerCount = await page.getByText(RECENT_THREAD_MARKER, { exact: false }).count()
    assert.equal(markerCount, 0, 'switching via Home recent threads should hydrate the selected thread, not keep the prior transcript visible')
  } finally {
    await cleanup()
  }
})

test('sidebar Crews button opens the supervised team workspace', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)

    await page.getByRole('button', { name: 'Crews', exact: true }).click()
    await page.locator('main').getByRole('heading', { name: 'Supervised agent teams' }).waitFor({ timeout: 10_000 })

    await page.locator('main').getByRole('button', { name: 'Create starter crew' }).click()
    await page.locator('main').getByText('Operations Crew', { exact: true }).first().waitFor({ timeout: 10_000 })

    await page.locator('main').getByRole('button', { name: 'Run team' }).click()
    await page.locator('main').getByText('Trace timeline', { exact: true }).waitFor({ timeout: 10_000 })

    const crewState = await page.evaluate(async () => {
      const list = await window.coworkApi.crews.list()
      const first = list.crews[0]
      if (!first) {
        return { crewCount: 0, nodeCount: 0, traceCount: 0 }
      }
      const detail = await window.coworkApi.crews.get(first.definition.id)
      const latestRun = detail?.runs[0]
      const runDetail = latestRun ? await window.coworkApi.crews.runDetail(latestRun.id) : null
      return {
        crewCount: list.crews.length,
        nodeCount: runDetail?.nodes.length || 0,
        traceCount: runDetail?.traceEvents.length || 0,
      }
    })

    assert.equal(crewState.crewCount, 1)
    assert.equal(crewState.nodeCount, 6)
    assert.equal(crewState.traceCount >= 7, true)
  } finally {
    await cleanup()
  }
})

test('gated Operations button opens the command center route', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)
    await page.evaluate(() => {
      window.localStorage.setItem('open-cowork.feature.operationsCommandCenter', 'true')
    })
    await page.reload()
    await waitForAppShell(page, 30_000)

    await page.getByRole('button', { name: 'Operations', exact: true }).click()
    await page.locator('main').getByRole('heading', { name: 'Operations' }).waitFor({ timeout: 10_000 })

    const summary = await page.evaluate(async () => window.coworkApi.operations.summary())
    assert.equal(typeof summary.totalWorkItems, 'number')
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
    await page.getByPlaceholder(/Search threads/i).waitFor({ timeout: 10_000 })
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
    await page.getByRole('button', { name: /Done/i }).waitFor({ timeout: 10_000 })
  } finally {
    await cleanup()
  }
})
