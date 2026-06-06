import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { UI_THEME_PRESETS } from '@open-cowork/shared'
import {
  CLOUD_THEME_STORAGE_KEY,
  cloudThemePresetOptions,
} from './cloud-theme.ts'
import { applyCloudThemePreset, installCloudThemePresetControls } from './cloud-theme-client.ts'
import type { CloudWebClientBootstrap } from './client-contract.ts'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string, options?: { url?: string }) => {
    window: Window & typeof globalThis & {
      document: Document
      localStorage: Storage
      Event: typeof Event
    }
  }
}

function bootstrap(tenantBrandingLocked: boolean): CloudWebClientBootstrap {
  return {
    role: 'admin',
    profileName: 'default',
    features: { chat: true },
    publicBranding: { productName: 'Open Cowork Cloud' },
    routes: [],
    defaultRoute: 'chat',
    api: [],
    routeMatrix: [],
    adminSurfaces: [],
    workbenchParity: [],
    sessionEventTypes: [],
    theme: {
      defaultPreset: 'mercury',
      tenantBrandingLocked,
      presets: cloudThemePresetOptions(),
    },
  }
}

type ThemeDom = InstanceType<typeof JSDOM>

function withThemeDom(run: (dom: ThemeDom) => void) {
  const originalDocument = globalThis.document
  const originalLocalStorage = globalThis.localStorage
  const options = cloudThemePresetOptions()
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('')
  const dom = new JSDOM(`<select id="cloud-theme-preset">${options}</select>`, { url: 'https://cloud.example.test/' })
  ;(globalThis as { document?: Document }).document = dom.window.document
  ;(globalThis as { localStorage?: Storage }).localStorage = dom.window.localStorage
  try {
    run(dom)
  } finally {
    ;(globalThis as { document?: Document }).document = originalDocument
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  }
}

test('cloud theme exposes the shared 17-preset catalog', () => {
  const options = cloudThemePresetOptions()
  assert.equal(options.length, 17)
  assert.deepEqual(options.map((option) => option.id), Object.keys(UI_THEME_PRESETS))
})

test('cloud theme switcher applies and persists shared preset tokens when unlocked', () => withThemeDom((dom) => {
  localStorage.setItem(CLOUD_THEME_STORAGE_KEY, 'tokyostorm')
  installCloudThemePresetControls(bootstrap(false))
  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement
  assert.equal(select.disabled, false)
  assert.equal(select.value, 'tokyostorm')
  assert.equal(document.documentElement.dataset.uiTheme, 'tokyostorm')
  assert.equal(document.documentElement.style.getPropertyValue('--color-base'), UI_THEME_PRESETS.tokyostorm.dark.base)

  select.value = 'frappe'
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  assert.equal(localStorage.getItem(CLOUD_THEME_STORAGE_KEY), 'frappe')
  assert.equal(document.documentElement.style.getPropertyValue('--color-accent'), UI_THEME_PRESETS.frappe.dark.accent)
}))

test('cloud theme switcher survives React hydration replacing the select node', () => withThemeDom((dom) => {
  installCloudThemePresetControls(bootstrap(false))
  const options = cloudThemePresetOptions()
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('')
  document.body.innerHTML = `<select id="cloud-theme-preset">${options}</select>`

  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement
  select.value = 'frappe'
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))

  assert.equal(localStorage.getItem(CLOUD_THEME_STORAGE_KEY), 'frappe')
  assert.equal(document.documentElement.dataset.uiTheme, 'frappe')
  assert.equal(document.documentElement.style.getPropertyValue('--color-accent'), UI_THEME_PRESETS.frappe.dark.accent)
}))

test('cloud theme switcher preserves tenant branding when locked', () => withThemeDom(() => {
  localStorage.setItem(CLOUD_THEME_STORAGE_KEY, 'frappe')
  installCloudThemePresetControls(bootstrap(true))
  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement
  assert.equal(select.disabled, true)
  assert.equal(select.dataset.tenantBrandingLocked, 'true')
  assert.equal(document.documentElement.style.getPropertyValue('--color-base'), '')
}))

test('cloud theme applies preset tokens directly', () => withThemeDom(() => {
  applyCloudThemePreset('gruvbox')
  assert.equal(document.documentElement.dataset.uiTheme, 'gruvbox')
  assert.equal(document.documentElement.style.getPropertyValue('--color-base'), UI_THEME_PRESETS.gruvbox.dark.base)
  assert.equal(document.documentElement.style.getPropertyValue('--accent'), UI_THEME_PRESETS.gruvbox.dark.accent)
}))
