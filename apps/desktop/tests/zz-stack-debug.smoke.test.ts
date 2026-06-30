import test from 'node:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

test('DEBUG stacking analysis', async () => {
  const { page, cleanup } = await launchSmokeApp({
    seedBeforeLaunch: ({ dataRoot }) => {
      writeFileSync(join(dataRoot, 'gateway-workspaces.json'), JSON.stringify([{
        id: 'gateway:smoke', baseUrl: 'http://127.0.0.1:8799', label: 'Smoke Gateway',
        lastSyncedAt: null, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z',
      }], null, 2))
    },
  })
  try {
    await waitForAppShell(page, 30_000)
    await page.getByRole('button', { name: /Local.*Online.*Local workspace/i }).click()
    await page.waitForTimeout(2500)
    const dump = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[]
      const gw = items.find((el) => (el.textContent || '').includes('Smoke Gateway'))
      if (!gw) return { error: 'no gateway menuitem' }
      const r = gw.getBoundingClientRect()
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const top = document.elementFromPoint(cx, cy) as HTMLElement | null
      const ctx = (el: HTMLElement | null) => {
        const chain: string[] = []
        let n: HTMLElement | null = el
        while (n && n !== document.body) {
          const s = getComputedStyle(n)
          if (s.zIndex !== 'auto' || s.transform !== 'none' || s.filter !== 'none' || (s as any).backdropFilter !== 'none' && (s as any).backdropFilter !== undefined || s.position === 'fixed' || s.opacity !== '1' || s.isolation === 'isolate') {
            chain.push(`${n.tagName}.${(n.className || '').toString().split(' ')[0]} z=${s.zIndex} pos=${s.position} tf=${s.transform !== 'none'} bf=${(s as any).backdropFilter} op=${s.opacity}`)
          }
          n = n.parentElement
        }
        return chain
      }
      return {
        gwRect: { cy: Math.round(cy) },
        topAtCenter: top ? `${top.tagName}.${(top.className || '').toString().split(' ').slice(0,2).join('.')}` : null,
        menuZ: getComputedStyle(gw.closest('[role="menu"]') as HTMLElement).zIndex,
        menuStackAncestors: ctx(gw),
        topStackAncestors: top ? ctx(top) : [],
      }
    })
    console.error('STACK_DUMP=' + JSON.stringify(dump, null, 1))
  } finally {
    await cleanup()
  }
})
