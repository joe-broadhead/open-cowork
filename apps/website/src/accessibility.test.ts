import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cloudWebsiteHtml } from './render.ts'
import { createCloudWebBrowserHarness, waitFor } from './browser-test-harness.ts'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => any }

function staticDocument() {
  const html = cloudWebsiteHtml({
    role: 'admin',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
      agents: true,
      customSkills: true,
      customMcps: true,
    },
  })
  return new JSDOM(html).window.document as Document
}

function cssText(document: Document) {
  return [...document.querySelectorAll('style')]
    .map((style) => style.textContent || '')
    .join('\n')
}

function hexToRgb(value: string) {
  const compact = value.trim().replace(/^#/, '')
  assert.equal(compact.length, 6, `Expected six-digit hex color: ${value}`)
  return [
    Number.parseInt(compact.slice(0, 2), 16),
    Number.parseInt(compact.slice(2, 4), 16),
    Number.parseInt(compact.slice(4, 6), 16),
  ] as const
}

function luminance([red, green, blue]: readonly [number, number, number]) {
  const channel = (value: number) => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return (0.2126 * channel(red)) + (0.7152 * channel(green)) + (0.0722 * channel(blue))
}

function contrast(left: string, right: string) {
  const leftLum = luminance(hexToRgb(left))
  const rightLum = luminance(hexToRgb(right))
  const lighter = Math.max(leftLum, rightLum)
  const darker = Math.min(leftLum, rightLum)
  return (lighter + 0.05) / (darker + 0.05)
}

test('cloud web static shell has labelled controls, landmarks, and valid interactive table semantics', () => {
  const document = staticDocument()

  assert.ok(document.querySelector('main.main'), 'main landmark exists')
  assert.equal(document.querySelector('nav[aria-label="Cloud Web sections"]')?.tagName, 'NAV')
  assert.equal(document.querySelector('#chat-timeline')?.getAttribute('aria-live'), 'polite')
  assert.ok(document.querySelector('[data-workbench-pane="threads"]'), 'thread pane is labelled')
  assert.ok(document.querySelector('[data-workbench-pane="conversation"]'), 'conversation pane is labelled')
  assert.ok(document.querySelector('[data-workbench-pane="review"]'), 'review pane is labelled')
  assert.equal(document.querySelector('[data-action-cluster="true"]')?.getAttribute('role'), 'toolbar')

  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-route-link]')) {
    assert.ok(link.href.includes('#'), `route link has hash href: ${link.textContent}`)
    assert.ok(link.textContent?.trim(), 'route link has text')
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) {
    assert.ok(button.textContent?.trim() || button.getAttribute('aria-label'), 'button has accessible text')
    assert.notEqual(button.getAttribute('role'), 'row', 'clickable row buttons must not replace row semantics')
  }

  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) {
    if (control.type === 'hidden') continue
    const labelled = Boolean(
      control.closest('label')?.textContent?.trim()
      || (control.id && document.querySelector(`label[for="${control.id}"]`)?.textContent?.trim())
      || control.getAttribute('aria-label')
      || control.getAttribute('aria-labelledby'),
    )
    assert.equal(labelled, true, `${control.tagName.toLowerCase()} ${control.name || control.id} is labelled`)
  }

  for (const panel of document.querySelectorAll<HTMLElement>('[data-route-panel]')) {
    assert.equal(panel.getAttribute('aria-hidden'), null, 'static panels let client script own aria-hidden after hydration')
  }
})

test('cloud web CSS keeps focus, reduced motion, responsive layout, and default color contrast gates', () => {
  const document = staticDocument()
  const css = cssText(document)
  assert.match(css, /a:focus-visible/)
  assert.match(css, /--ring-focus: 0 0 0 2px var\(--focus\);/)
  assert.match(css, /\.nav-links a\[data-active="true"\]:focus-visible\s*\{[\s\S]*box-shadow: var\(--ring-selected\), var\(--ring-focus\);/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /@media \(max-width: 920px\)/)
  assert.match(css, /\.workbench-split\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\) minmax\(320px, 360px\)/)
  assert.match(css, /@media \(max-width: 920px\)\s*\{[\s\S]*\.ui-workbench-layout,\s*\.ui-workbench-layout--with-review\s*\{[\s\S]*grid-template-columns: 1fr;/)
  assert.match(css, /@media \(max-width: 920px\)\s*\{[\s\S]*\.form-grid\s*\{\s*grid-template-columns: 1fr;/)
  assert.ok(contrast('#e8e9f3', '#1b1b26') >= 4.5, 'body text contrasts with background')
  assert.ok(contrast('#8a8da0', '#23232f') >= 4.5, 'muted text contrasts with elevated surface')
  assert.ok(contrast('#8da4f5', '#23232f') >= 4.5, 'links and secondary actions contrast with elevated surface')
  assert.ok(contrast('#fc92b4', '#23232f') >= 4.5, 'danger text contrasts with elevated surface')
})

test('cloud web hydrated shell manages route focus state and admin visibility for keyboard users', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    const chatLink = harness.document.querySelector('[data-route-link="chat"]')
    const adminNav = harness.document.querySelector('[data-admin-nav]') as HTMLDetailsElement | null
    assert.equal(chatLink?.getAttribute('aria-current'), 'page')
    assert.equal(adminNav?.open, false)
    assert.equal(harness.document.querySelector('[data-route-panel="chat"]')?.getAttribute('aria-hidden'), 'false')

    harness.clickText('[data-route-link]', 'History')
    await waitFor(() => {
      assert.equal(harness.document.body.dataset.route, 'threads')
      assert.equal(harness.document.querySelector('[data-route-link="threads"]')?.getAttribute('aria-current'), 'page')
      assert.equal(harness.document.querySelector('[data-route-panel="chat"]')?.getAttribute('aria-hidden'), 'true')
    })

    harness.clickText('button', 'New chat')
    await waitFor(() => {
      assert.equal(harness.document.body.dataset.route, 'chat')
      const active = harness.document.activeElement as HTMLTextAreaElement | null
      assert.equal(active?.name, 'text')
      assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /What shall we cowork on today/)
    })

    harness.clickText('[data-route-link]', 'Connections')
    await waitFor(() => {
      assert.equal(harness.document.body.dataset.route, 'connections')
      assert.equal(adminNav?.open, true)
      assert.equal(harness.document.querySelector('[data-route-link="connections"]')?.getAttribute('aria-current'), 'page')
    })

    const selectedThread = harness.document.querySelector('#thread-list .row-link') as HTMLButtonElement | null
    assert.ok(selectedThread)
    assert.equal(selectedThread.getAttribute('aria-pressed'), 'false')
    assert.equal(harness.document.querySelector('button[role="row"]'), null)
  } finally {
    harness.close()
  }
})
