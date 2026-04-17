import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: the Home page is the app's landing surface. It pulls from many
// IPC endpoints (runtime status, model info, MCP connections, dashboard
// summary, perf, custom agents, capabilities) and renders a dashboard
// with pills, metric cards, recent threads, and a new-thread CTA. If any
// of those data paths throw or the layout breaks, the dashboard goes
// empty — this test catches that.

test('home page renders the dashboard with runtime + usage pills', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await page.waitForSelector('h1:has-text("Workspace state, capabilities, and runtime health in one view.")', {
      timeout: 30_000,
    })

    // The runtime / provider / context / MCP / capabilities pills sit in
    // a horizontal strip under the hero. We don't care about the live
    // values (they depend on whether the runtime finished booting in
    // under the 15s wait above) — just that every label rendered.
    for (const label of ['Runtime', 'Provider', 'Context', 'MCP', 'Capabilities']) {
      const count = await page.locator(`text=${label}`).count()
      assert.ok(count > 0, `expected to see "${label}" pill label`)
    }

    // Metric cards by eyebrow.
    for (const eyebrow of ['Capabilities', 'Agents', 'Usage', 'Agent usage', 'Performance']) {
      const count = await page.getByText(eyebrow, { exact: true }).count()
      assert.ok(count > 0, `expected to see "${eyebrow}" metric card eyebrow`)
    }

    // New-thread + open-directory CTAs.
    await page.getByRole('button', { name: /New thread/ }).waitFor({ timeout: 5_000 })
    await page.getByRole('button', { name: /Open directory/ }).waitFor({ timeout: 5_000 })
  } finally {
    await cleanup()
  }
})
