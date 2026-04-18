import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: the end-to-end "new thread" path through the Home composer.
// Catches regressions in: Home → chat view transition, session.create
// IPC, pending-prompt dispatch, ChatInput mount on the fresh session,
// and the `@`-mention picker. This is the single most user-visible
// path — if any one of these breaks, a real user can't send their
// first message.

test('Home composer starts a thread and the @-mention picker opens in chat', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    // New Home is composer-first — the textarea is the primary action,
    // not a "New thread" button.
    await page.waitForSelector('h1:has-text("What shall we cowork on today?")', { timeout: 30_000 })

    const homeComposer = page.locator('textarea').first()
    await homeComposer.waitFor({ timeout: 10_000 })
    await homeComposer.fill('research the top 3 competitors to Linear')
    await homeComposer.press('Enter')

    // Submitting on Home creates + activates a session and routes the
    // view to chat. Wait for the Home greeting to drop out of the DOM
    // as our transition signal, then confirm the chat composer mounted.
    await page.waitForSelector('h1:has-text("What shall we cowork on today?")', {
      state: 'detached',
      timeout: 15_000,
    })

    const chatComposer = page.locator('textarea').first()
    await chatComposer.waitFor({ timeout: 15_000 })

    // Type `@` into the chat composer — the inline mention picker
    // should surface built-in agents. We don't pin a specific agent
    // name; any of the ones shipped in the default config qualifies.
    await chatComposer.fill('')
    await chatComposer.type('@')
    const pickerAppeared = await page.waitForSelector(
      'text=/research|explore|build|plan|charts/i',
      { timeout: 5_000 },
    ).then(() => true).catch(() => false)
    assert.ok(pickerAppeared, '@-mention picker did not surface any agent rows in chat')
  } finally {
    await cleanup()
  }
})
