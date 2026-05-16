import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: Home is the welcoming landing surface. After the redesign it's
// a composer-first page: greeting, textarea, agent suggestion pills,
// recent threads, and a small runtime status strip.

test('home renders the greeting, composer, status strip, and no removed dashboard content', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    // Greeting is a single stable line now (we tried rotating and it
    // felt off — product voice is clearer with one tagline). Match the
    // exact copy in the English catalog's inline fallback.
    await page.waitForSelector('h1:has-text("What shall we cowork on today?")', { timeout: 30_000 })

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

    // Agent suggestion pills appear once built-in agents load. At
    // least one pill should be present on a healthy boot.
    const pill = await page.waitForSelector('button:has-text("@")', { timeout: 10_000 }).catch(() => null)
    assert.ok(pill, 'expected at least one @-agent suggestion pill on Home')

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
