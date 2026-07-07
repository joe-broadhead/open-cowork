import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'
import { compareToBaseline, setColorScheme } from './eval-helpers.ts'

// EVAL FLOW: visual regression on key surfaces in light + dark.
//
// Captures the Home and Team surfaces in both color schemes and diffs each
// against a committed baseline PNG using an in-renderer, dependency-free pixel
// comparison (see compareToBaseline). A large structural change (broken
// layout, blank surface, theme flip) pushes the diff ratio over threshold and
// fails the eval; sub-pixel churn stays under it.
//
// BASELINES: none are committed initially. On the first nightly run each
// surface seeds its baseline under apps/desktop/tests/visual-baselines/ and
// passes with a note; a maintainer reviews and commits those PNGs so
// subsequent runs diff against them. Re-seed intentionally with
// OPEN_COWORK_EVAL_UPDATE_BASELINES=1.

async function gotoHome(page: import('playwright-core').Page) {
  await page.getByRole('button', { name: 'Home', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("Good")', { timeout: 30_000 })
}

async function gotoTeam(page: import('playwright-core').Page) {
  await page.getByRole('button', { name: 'Team', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("Coworkers")', { timeout: 30_000 })
  await page.getByText('Built-in coworkers', { exact: true }).waitFor({ timeout: 10_000 })
}

test('eval:visual — home and team match baselines in light and dark', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await waitForAppShell(page)

    const surfaces: Array<{ name: string; goto: () => Promise<void> }> = [
      { name: 'home', goto: () => gotoHome(page) },
      { name: 'team', goto: () => gotoTeam(page) },
    ]

    for (const scheme of ['light', 'dark'] as const) {
      await setColorScheme(page, scheme)
      for (const surface of surfaces) {
        await surface.goto()
        // Let fonts/animation settle before the pixel capture.
        await page.waitForTimeout(450)
        const result = await compareToBaseline(page, `${surface.name}-${scheme}`)
        assert.ok(
          result.passed,
          `visual regression on ${surface.name}-${scheme}: diff ${(result.diffRatio * 100).toFixed(2)}% exceeded ${(result.threshold * 100).toFixed(2)}%`,
        )
      }
    }
  } finally {
    await cleanup()
  }
})
