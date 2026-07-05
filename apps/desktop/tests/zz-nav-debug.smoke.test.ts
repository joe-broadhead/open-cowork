import test from 'node:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

test('DEBUG dump workspace switcher menu state', async () => {
  const { page, cleanup } = await launchSmokeApp({
    seedBeforeLaunch: ({ dataRoot }) => {
      writeFileSync(join(dataRoot, 'gateway-workspaces.json'), JSON.stringify([{
        id: 'gateway:smoke',
        baseUrl: 'http://127.0.0.1:8799',
        label: 'Smoke Gateway',
        lastSyncedAt: null,
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }], null, 2))
    },
  })
  try {
    await waitForAppShell(page, 30_000)
    await page.getByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i }).click()
    await page.waitForTimeout(2500)
    const items = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()))
    const ws = await page.evaluate(async () => (await window.coworkApi.workspace.list()).map((w) => ({ id: w.id, label: w.label, status: w.status, authority: w.authority, kind: w.kind })))
    console.error('DEBUG_MENU_ITEMS=' + JSON.stringify(items))
    console.error('DEBUG_WORKSPACES=' + JSON.stringify(ws))
  } finally {
    await cleanup()
  }
})
