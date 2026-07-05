import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: Home is the welcoming landing surface. It should stay aligned
// with the Studio launchpad: greeting, composer, assign-to picker,
// starter cards, in-motion feed, team strip, and runtime status.

test('home renders the Studio launchpad, composer, status strip, and no removed dashboard content', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    // Greeting is a single time-of-day line now: "Good {morning|afternoon|evening}."
    // with the time word in accent. The word varies by wall-clock, so match the
    // stable lead word "Good" (the inline English fallback from studioHome.greeting.lead).
    await page.waitForSelector('h1:has-text("Good")', { timeout: 30_000 })

    // The composer textarea is the primary action on Home. Its
    // placeholder mentions @-mention; we match a loose regex so i18n
    // rewrites don't break the assertion.
    const composer = page.locator('textarea').first()
    await composer.waitFor({ timeout: 10_000 })
    const placeholder = await composer.getAttribute('placeholder')
    assert.ok(
      /@mention|@agent|@menciona|@menzion|@mentionn|@nenne|@aذكر|@упомя|@로|@ から|@/i.test(placeholder || ''),
      `expected the composer placeholder to reference @-mention (got "${placeholder}")`,
    )

    await page.getByText('Assign to', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: /Build.*default/i }).waitFor({ timeout: 10_000 })

    await page.getByText('Start with a handoff', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('In motion', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('In progress', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('Waiting on you', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('Fresh artifacts', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('Your team', { exact: true }).waitFor({ timeout: 10_000 })

    // The status strip stays on Home and reports the managed runtime
    // connection state without reintroducing a separate dashboard route.
    await page.locator('main').getByText(/MCPs/i).first().waitFor({ timeout: 5_000 })

    // These headings belonged to the removed Pulse/dashboard surface.
    // If they reappear on Home, the strip-back regressed.
    for (const heading of ['Workspace state', 'Cost and tokens by sub-agent', 'Threads, tokens, and cost', 'Pulse']) {
      const count = await page.locator(`text=${heading}`).count()
      assert.equal(count, 0, `Home should not show the Pulse heading "${heading}" — regression`)
    }
  } finally {
    await cleanup()
  }
})
