import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

// Smoke: the packaged desktop renderer must actually LAY OUT the app shell —
// sidebar rail beside the main pane — not just mount the DOM.
//
// Regression gate for the unified-UI Tailwind blind spot: Tailwind v4's
// automatic source detection roots at apps/desktop, while all UI source lives
// in packages/app + packages/ui. When utility extraction misses those roots
// (fixed via @source directives in packages/app/src/styles/globals.css), the
// CSS bundle drops every utility class, the shell's `flex` computes to
// display:block, and the sidebar renders full-width with main content stacked
// underneath — while every DOM/logic assertion still passes. This test looks
// at COMPUTED layout so that failure mode goes red in CI.

test('app shell computes a real flex layout with a bounded sidebar rail', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await waitForAppShell(page)
    await page.waitForSelector('aside', { timeout: 15_000 })
    await page.waitForSelector('main', { timeout: 15_000 })

    const layout = await page.evaluate(() => {
      const aside = document.querySelector('aside')
      const main = document.querySelector('main')
      const shell = aside?.parentElement
      const shellStyle = shell ? getComputedStyle(shell) : null
      // Direct probe for the P0 class: if Tailwind utility extraction broke,
      // a bare `flex` utility no longer computes to display:flex.
      const probe = document.createElement('div')
      probe.className = 'flex'
      document.body.appendChild(probe)
      const probeDisplay = getComputedStyle(probe).display
      probe.remove()
      return {
        innerWidth: window.innerWidth,
        shellDisplay: shellStyle?.display ?? null,
        asideWidth: aside?.getBoundingClientRect().width ?? null,
        asideHeight: aside?.getBoundingClientRect().height ?? null,
        mainLeft: main?.getBoundingClientRect().left ?? null,
        mainWidth: main?.getBoundingClientRect().width ?? null,
        probeDisplay,
      }
    })

    assert.equal(
      layout.probeDisplay,
      'flex',
      'the bare `flex` utility must compute to display:flex — Tailwind utility extraction is broken (check the @source roots in packages/app/src/styles/globals.css)',
    )
    assert.equal(
      layout.shellDisplay,
      'flex',
      `the app shell (aside's parent) must lay out as flex, got ${layout.shellDisplay}`,
    )
    assert.ok(
      layout.asideWidth !== null && layout.asideWidth >= 48 && layout.asideWidth <= 480,
      `sidebar rail width must be a bounded column (48-480px), got ${layout.asideWidth}px at window width ${layout.innerWidth}px`,
    )
    assert.ok(
      layout.asideWidth !== null && layout.innerWidth > 0 && layout.asideWidth <= layout.innerWidth * 0.45,
      `sidebar must not consume the window (got ${layout.asideWidth}px of ${layout.innerWidth}px)`,
    )
    assert.ok(
      layout.mainLeft !== null && layout.asideWidth !== null && layout.mainLeft >= layout.asideWidth - 1,
      `main pane must sit BESIDE the sidebar, not under it (main.left=${layout.mainLeft}, aside.width=${layout.asideWidth})`,
    )
    assert.ok(
      layout.mainWidth !== null && layout.mainWidth > 200,
      `main pane must have real width beside the rail, got ${layout.mainWidth}px`,
    )
  } finally {
    await cleanup()
  }
})
