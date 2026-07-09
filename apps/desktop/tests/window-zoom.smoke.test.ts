import assert from 'node:assert/strict'
import test from 'node:test'
import type { ElectronApplication } from 'playwright-core'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

async function getMainWindowZoomFactor(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    const window = windows.find((candidate) => {
      const url = candidate.webContents.getURL()
      return url.includes('index.html') || url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')
    }) || windows[0]
    if (!window) throw new Error('No Electron window is available')
    return window.webContents.getZoomFactor()
  })
}

test('desktop window zoom persists through preload settings and renderer reload', async () => {
  const { app, page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    assert.equal(await getMainWindowZoomFactor(app), 1)

    await page.evaluate(async () => {
      await window.coworkApi.settings.set({ windowZoomFactor: 1.25 })
    })

    await page.reload()
    await page.waitForFunction(() => Boolean(
      document.querySelector('#root')
      && typeof window.coworkApi?.settings?.get === 'function',
    ))
    await waitForAppShell(page)

    const afterReloadSettings = await page.evaluate(async () => window.coworkApi.settings.get())
    assert.equal(afterReloadSettings.windowZoomFactor, 1.25)
    assert.equal(await getMainWindowZoomFactor(app), 1.25)
  } finally {
    await cleanup()
  }
})
