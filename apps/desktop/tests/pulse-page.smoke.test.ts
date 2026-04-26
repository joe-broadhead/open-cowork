import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: Pulse is the diagnostic dashboard that used to live on Home.
// It pulls from runtime status, model info, MCP connections, dashboard
// summary, perf, custom agents, capabilities — if any of those paths
// throw or the layout breaks, the whole page empties. This test is a
// direct port of the old home-page smoke with the one navigation step
// added (sidebar → Pulse) because the page is no longer the default
// landing surface.

test('pulse page renders the dashboard with runtime + usage pills', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    // Wait for the new Home to paint first — Pulse is lazy-loaded so
    // we need the renderer fully mounted before clicking into it.
    await page.waitForSelector('h1', { timeout: 30_000 })

    // Click through to Pulse via the sidebar. The button label is the
    // source of truth; matching by accessible name keeps us resilient
    // to icon / class changes.
    await page.getByRole('button', { name: 'Pulse', exact: true }).first().click()

    // Wait for the Pulse hero to paint. Header copy anchors the page.
    await page.waitForSelector(
      'h1:has-text("Workspace state, capabilities, and runtime health in one view.")',
      { timeout: 30_000 },
    )

    for (const label of ['Runtime', 'Provider', 'Context', 'MCP', 'Capabilities']) {
      const count = await page.locator(`text=${label}`).count()
      assert.ok(count > 0, `expected to see "${label}" pill label on Pulse`)
    }

    for (const eyebrow of ['Capabilities', 'Agents', 'Usage', 'Agent usage', 'Performance']) {
      const count = await page.getByText(eyebrow, { exact: true }).count()
      assert.ok(count > 0, `expected to see "${eyebrow}" metric card eyebrow on Pulse`)
    }

    await page.getByRole('button', { name: /New thread/ }).waitFor({ timeout: 5_000 })
    await page.getByRole('button', { name: /Open directory/ }).waitFor({ timeout: 5_000 })
  } finally {
    await cleanup()
  }
})
