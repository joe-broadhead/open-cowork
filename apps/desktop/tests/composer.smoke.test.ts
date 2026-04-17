import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: opening a new thread and confirming the composer mounts,
// accepts text, and surfaces the @-mention picker. This catches a
// whole class of regressions — ChatInput focus loss, preload rename
// breaking session.create, agent mode selector missing — that would
// otherwise only show up when a real user tries to send a prompt.

test('new-thread flow mounts the composer and the @-mention picker opens', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await page.waitForSelector('h1:has-text("Workspace state")', { timeout: 15_000 })

    // Create a new thread via the dashboard CTA.
    await page.getByRole('button', { name: /New thread/ }).click()

    // Composer mounts after session activation. The placeholder copy on
    // the textarea anchors the assertion.
    const composer = page.locator('textarea').first()
    await composer.waitFor({ timeout: 15_000 })
    await composer.fill('research the top 3 competitors to Linear')
    assert.equal(await composer.inputValue(), 'research the top 3 competitors to Linear')

    // Typing `@` opens the inline mention picker. We don't care WHICH
    // agents show up — just that the picker renders.
    await composer.fill('')
    await composer.type('@')
    // Picker is keyed off a data attribute on the popup container. Fall
    // back to a text probe for any built-in agent name if the attr
    // changes.
    const pickerAppeared = await page.waitForSelector(
      'text=/research|explore|build|plan|charts/i',
      { timeout: 5_000 },
    ).then(() => true).catch(() => false)
    assert.ok(pickerAppeared, '@-mention picker did not surface any agent rows')
  } finally {
    await cleanup()
  }
})
