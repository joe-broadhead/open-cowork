import assert from 'node:assert/strict'
import test from 'node:test'
import {
  E2E_SETUP_VALIDATION_KEY,
  cleanupSmokePaths,
  createSmokePaths,
  launchSmokeSession,
  type SmokeSession,
} from './smoke-helpers.ts'
import { captureEvidence } from './eval-helpers.ts'

// EVAL FLOW: onboarding / provider-setup reaches "ready".
//
// Drives first run at the narrow supported viewport, proves an invalid key
// cannot survive relaunch as "complete", then validates the exact main-owned
// fixture key and enters Home. The E2E authority is local; no provider is called.
test('eval:onboarding — durable provider validation gates Home across relaunch at 800px', async () => {
  const paths = createSmokePaths({ preserveProviderCredentialRequirements: true })
  let session: SmokeSession | null = null
  try {
    session = await launchSmokeSession(paths, { bootstrapSettings: false })
    let page = session.page
    await page.setViewportSize({ width: 800, height: 900 })
    await page.getByRole('heading', { name: /Welcome/ }).waitFor({ timeout: 30_000 })
    assert.equal(await page.locator('[data-testid="home-view"]').count(), 0)
    assert.equal((await page.evaluate(async () => window.coworkApi.settings.get())).setupComplete, false)

    const credential = page.getByLabel('OpenRouter API Key')
    await credential.fill('invalid-e2e-key')
    await page.getByRole('button', { name: 'Test connection' }).click()
    await page.getByRole('alert').filter({ hasText: /credential was rejected/i }).first().waitFor({ timeout: 60_000 })
    assert.equal(await page.getByRole('button', { name: 'Get Started' }).isDisabled(), true)
    assert.equal((await page.evaluate(async () => window.coworkApi.settings.get())).setupComplete, false)
    await captureEvidence(page, 'onboarding', '01-invalid-credential')

    await session.close()
    session = null

    session = await launchSmokeSession(paths, { bootstrapSettings: false })
    page = session.page
    await page.setViewportSize({ width: 800, height: 900 })
    await page.getByRole('heading', { name: /Welcome/ }).waitFor({ timeout: 30_000 })
    const relaunched = await page.evaluate(async () => ({
      settings: await window.coworkApi.settings.get(),
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    assert.equal(relaunched.settings.setupComplete, false)
    assert.equal(relaunched.width, 800)
    assert.ok(relaunched.scrollWidth <= relaunched.width, 'Setup overflowed horizontally at 800px')
    assert.equal(await page.locator('[data-testid="home-view"]').count(), 0)
    await captureEvidence(page, 'onboarding', '02-relaunch-still-setup')

    await page.getByLabel('OpenRouter API Key').fill(E2E_SETUP_VALIDATION_KEY)
    await page.getByRole('button', { name: 'Test connection' }).click()
    await page.getByText(/Connection tested\. You can start using/).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Get Started' }).click()
    await page.waitForSelector('[data-testid="home-view"]', { timeout: 60_000 })

    const ready = await page.evaluate(async () => {
      const settings = await window.coworkApi.settings.get()
      return {
        setupComplete: settings.setupComplete,
        providerId: settings.effectiveProviderId,
        modelId: settings.effectiveModel,
      }
    })
    assert.equal(ready.setupComplete, true)
    assert.equal(ready.providerId, 'openrouter')
    assert.ok(ready.modelId, 'provider setup did not retain a validated model')

    await captureEvidence(page, 'onboarding', '03-ready-home')
  } finally {
    await session?.close()
    cleanupSmokePaths(paths)
  }
})
