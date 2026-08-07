import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: the Wiki surface is a read-only browser over the linked OpenWiki
// root. It must render a page list and open a page's markdown without any
// runtime errors. Private spaces stay visible in the index; body access is
// governed by the CLI (the UI never bypasses grants).

test('wiki surface renders the linked wiki and opens a page', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await page.waitForSelector('h1:has-text("Good")', { timeout: 60_000 })
    await page.locator('button[data-nav-view="wiki"]').waitFor({ timeout: 15_000 })
    await page.locator('button[data-nav-view="wiki"]').click()

    // Either the wiki loads (linked root) or the unlinked empty state shows.
    // We accept both, but require one of them (and no crash overlay).
    await page
      .locator(
        'text=/pages|No wiki is linked yet|Ask a coworker to draft pages|This wiki has no pages yet/',
      )
      .first()
      .waitFor({ timeout: 30_000 })

    const unlinked = await page.getByText('No wiki is linked yet', { exact: true }).count()
    if (unlinked === 0) {
      // A page list rendered — open the first page and expect markdown body.
      const pageItem = page.locator('button[data-wiki-page-id]').first()
      await pageItem.waitFor({ timeout: 15_000 })
      const firstTitle = (await pageItem.textContent())?.trim()
      assert.ok(firstTitle && firstTitle.length > 0, 'page list item should have a title')
      await pageItem.click()
      await page.locator('article, .prose, [data-wiki-body], [data-component=markdown]').first().waitFor({ timeout: 15_000 })
      await page.waitForTimeout(1200)
      await page.screenshot({ path: '/tmp/wiki-view.png' })

      // Right rail: the Obsidian-style link panels must be present.
      await page.getByText('Linked mentions', { exact: true }).waitFor({ timeout: 10_000 })
      await page.getByText('Outgoing links', { exact: true }).waitFor({ timeout: 5_000 })
      await page.getByText('Related', { exact: true }).waitFor({ timeout: 5_000 })

      // Graph view: switch the tab, expect a canvas + node/edge counters.
      await page.getByRole('tab', { name: 'Graph' }).click()
      const canvas = page.locator('canvas').first()
      await canvas.waitFor({ timeout: 10_000 })
      await page.getByText(/nodes · .*edges/).first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      await page.screenshot({ path: '/tmp/wiki-graph.png' })
      // Back to browse.
      await page.getByRole('tab', { name: 'Browse' }).click()
      await page.locator('button[data-wiki-page-id]').first().waitFor({ timeout: 5_000 })
    }
  } finally {
    await cleanup()
  }
})
