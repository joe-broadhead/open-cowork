import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

const RECENT_SOURCE_TITLE = 'Navigation source thread'
const RECENT_TARGET_TITLE = 'Navigation target thread'
const RECENT_THREAD_MARKER = 'navigation-regression-marker'

test('home recent-thread CTA routes through the real session activation path', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page, 30_000)

    await page.evaluate(async ({ sourceTitle, targetTitle, marker }) => {
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

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const view = await window.coworkApi.session.activate(source.id, { force: true })
        if (view.messages.some((message) => message.content.includes(marker))) break
        await new Promise((resolve) => window.setTimeout(resolve, 200))
      }

      const target = await window.coworkApi.session.create()
      await window.coworkApi.session.rename(target.id, targetTitle)
    }, {
      sourceTitle: RECENT_SOURCE_TITLE,
      targetTitle: RECENT_TARGET_TITLE,
      marker: RECENT_THREAD_MARKER,
    })

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
