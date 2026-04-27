import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

test('clipboard writes go through the preload and main IPC bridge', async () => {
  const { app, page, cleanup } = await launchSmokeApp()
  const previousText = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await page.waitForFunction(() => typeof window.coworkApi?.clipboard?.writeText === 'function')

    const copied = await page.evaluate(async () => {
      return window.coworkApi.clipboard.writeText('Open Cowork clipboard smoke')
    })

    assert.equal(copied, true)
  } finally {
    await app.evaluate(({ clipboard }, text) => {
      clipboard.writeText(text)
    }, previousText)
    await cleanup()
  }
})
