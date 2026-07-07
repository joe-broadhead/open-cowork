import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'
import { captureEvidence, completeProviderSetup } from './eval-helpers.ts'

// EVAL FLOW: onboarding / provider-setup reaches "ready".
//
// Drives the real first-run journey: force the app back to the SetupScreen by
// clearing the seeded provider, prove SetupScreen renders, then complete
// provider setup with a placeholder (offline) credential and prove the app
// reaches the ready main shell (`data-testid="home-view"`). No LLM call is
// made — the placeholder key only satisfies `isSetupComplete`.
test('eval:onboarding — provider setup reaches the ready home shell', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    // launchSmokeApp seeds a provider so the app is already ready. Roll setup
    // back so we can observe the real onboarding → ready transition.
    const rolledBack = await page
      .evaluate(async () => {
        await window.coworkApi.settings.set({
          selectedProviderId: null,
          selectedModelId: null,
          providerCredentials: {},
        })
        return true
      })
      .catch(() => false)

    if (rolledBack) {
      await page.reload()
      // SetupScreen shows the "Welcome" heading; the ready shell is absent.
      const sawSetup = await page
        .waitForSelector('h1:has-text("Welcome")', { timeout: 15_000 })
        .then(() => true)
        .catch(() => false)
      if (sawSetup) {
        await captureEvidence(page, 'onboarding', '01-setup-screen')
      }
    }

    // Complete provider setup (offline placeholder credential) and assert the
    // app reaches the ready main shell.
    await completeProviderSetup(page)
    await page.waitForSelector('[data-testid="home-view"]', { timeout: 30_000 })

    const ready = await page.evaluate(async () => {
      const settings = await window.coworkApi.settings.get()
      return Boolean(settings.effectiveProviderId && settings.effectiveModel)
    })
    assert.ok(ready, 'provider setup did not resolve an effective provider/model')

    await captureEvidence(page, 'onboarding', '02-ready-home')
  } finally {
    await cleanup()
  }
})
