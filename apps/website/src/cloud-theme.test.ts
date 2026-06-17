import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { UI_THEME_PRESETS, accentActionFillToken } from '@open-cowork/shared'
import {
  CLOUD_THEME_ACCENT_STORAGE_KEY,
  CLOUD_THEME_DENSITY_STORAGE_KEY,
  CLOUD_THEME_SCHEME_STORAGE_KEY,
  CLOUD_THEME_STORAGE_KEY,
  cloudAccentPresetOptions,
  cloudDensityOptions,
  cloudThemePresetOptions,
} from './cloud-theme.ts'
import { applyCloudDensity, applyCloudThemePreset, installCloudThemePresetControls } from './cloud-theme-client.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientBootstrap } from './client-contract.ts'

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

function bootstrap(tenantBrandingLocked: boolean, includeSettingsApi = false): CloudWebClientBootstrap {
  return {
    role: 'admin',
    profileName: 'default',
    features: { chat: true },
    publicBranding: { productName: 'Open Cowork Cloud' },
    routes: [],
    defaultRoute: 'chat',
    api: includeSettingsApi ? CLOUD_WEB_CLIENT_ENDPOINTS : [],
    routeMatrix: [],
    adminSurfaces: [],
    workbenchParity: [],
    sessionEventTypes: [],
    theme: {
      defaultPreset: 'mercury',
      defaultScheme: 'dark',
      defaultAccent: 'azure',
      defaultDensity: 'regular',
      tenantBrandingLocked,
      accents: cloudAccentPresetOptions(),
    },
  }
}

type ThemeDom = InstanceType<typeof JSDOM>

function focusTokenForAccent(accent: string) {
  const hex = accent.replace(/^#/, '')
  return `rgba(${Number.parseInt(hex.slice(0, 2), 16)}, ${Number.parseInt(hex.slice(2, 4), 16)}, ${Number.parseInt(hex.slice(4, 6), 16)}, 0.52)`
}

function withThemeDom(run: (dom: ThemeDom) => void) {
  const originalDocument = globalThis.document
  const originalLocalStorage = globalThis.localStorage
  const options = cloudThemePresetOptions()
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('')
  const accents = cloudAccentPresetOptions()
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('')
  const densities = cloudDensityOptions()
    .map((density) => `<option value="${density.id}">${density.label}</option>`)
    .join('')
  const accentButtons = cloudAccentPresetOptions()
    .map((preset) => `<button type="button" data-cloud-theme-accent-button="${preset.id}" aria-pressed="false"></button>`)
    .join('')
  const densityButtons = cloudDensityOptions()
    .map((density) => `<button type="button" data-cloud-density-button="${density.id}" aria-pressed="false"></button>`)
    .join('')
  const dom = new JSDOM(`<select id="cloud-theme-preset">${options}</select><select id="cloud-theme-scheme"><option value="dark">Mercury</option><option value="light">Day</option></select><select id="cloud-theme-accent">${accents}</select><select id="cloud-theme-density">${densities}</select><button type="button" data-cloud-settings-target="cloud-settings-appearance">Appearance</button><section id="cloud-settings-appearance"></section><section data-tenant-branding-locked="false"><select data-cloud-theme-control="preset" data-select-id="cloud-theme-preset">${options}</select><select data-cloud-theme-control="scheme" data-select-id="cloud-theme-scheme"><option value="dark">Mercury</option><option value="light">Day</option></select><div>${accentButtons}</div><div>${densityButtons}</div><button type="button" role="switch" aria-checked="true" data-cloud-user-setting="cloud-setting-notification-voice" data-default-checked="true"></button></section>`, { url: 'https://cloud.example.test/#settings' })
  ;(globalThis as { document?: Document }).document = dom.window.document
  ;(globalThis as { localStorage?: Storage }).localStorage = dom.window.localStorage
  try {
    run(dom)
  } finally {
    ;(globalThis as { document?: Document }).document = originalDocument
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  }
}

async function withThemeDomAsync(run: (dom: ThemeDom) => Promise<void>) {
  const originalDocument = globalThis.document
  const originalLocalStorage = globalThis.localStorage
  const options = cloudThemePresetOptions()
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('')
  const accents = cloudAccentPresetOptions()
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('')
  const densities = cloudDensityOptions()
    .map((density) => `<option value="${density.id}">${density.label}</option>`)
    .join('')
  const accentButtons = cloudAccentPresetOptions()
    .map((preset) => `<button type="button" data-cloud-theme-accent-button="${preset.id}" aria-pressed="false"></button>`)
    .join('')
  const densityButtons = cloudDensityOptions()
    .map((density) => `<button type="button" data-cloud-density-button="${density.id}" aria-pressed="false"></button>`)
    .join('')
  const dom = new JSDOM(`<select id="cloud-theme-preset">${options}</select><select id="cloud-theme-scheme"><option value="dark">Mercury</option><option value="light">Day</option></select><select id="cloud-theme-accent">${accents}</select><select id="cloud-theme-density">${densities}</select><section data-tenant-branding-locked="false"><select data-cloud-theme-control="preset" data-select-id="cloud-theme-preset">${options}</select><select data-cloud-theme-control="scheme" data-select-id="cloud-theme-scheme"><option value="dark">Mercury</option><option value="light">Day</option></select><div>${accentButtons}</div><div>${densityButtons}</div><button type="button" role="switch" aria-checked="true" data-cloud-user-setting="cloud-setting-notification-voice" data-default-checked="true"></button><button type="button" role="switch" aria-checked="false" data-cloud-user-setting="cloud-setting-privacy-share" data-default-checked="false"></button></section>`, { url: 'https://cloud.example.test/' })
  ;(globalThis as { document?: Document }).document = dom.window.document
  ;(globalThis as { localStorage?: Storage }).localStorage = dom.window.localStorage
  try {
    await run(dom)
  } finally {
    ;(globalThis as { document?: Document }).document = originalDocument
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  }
}

function waitForAsyncClientWork() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

void test('cloud theme exposes the shared 18-preset catalog', () => {
  const options = cloudThemePresetOptions()
  assert.equal(options.length, 18)
  assert.deepEqual(options.map((option) => option.id), Object.keys(UI_THEME_PRESETS))
})

void test('cloud theme switcher applies and persists shared preset tokens when unlocked', () => withThemeDom((dom) => {
  localStorage.setItem(CLOUD_THEME_STORAGE_KEY, 'tokyostorm')
  localStorage.setItem(CLOUD_THEME_SCHEME_STORAGE_KEY, 'light')
  localStorage.setItem(CLOUD_THEME_ACCENT_STORAGE_KEY, 'teal')
  localStorage.setItem(CLOUD_THEME_DENSITY_STORAGE_KEY, 'compact')
  installCloudThemePresetControls(bootstrap(false))
  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement
  const scheme = document.getElementById('cloud-theme-scheme') as HTMLSelectElement
  const accent = document.getElementById('cloud-theme-accent') as HTMLSelectElement
  const density = document.getElementById('cloud-theme-density') as HTMLSelectElement
  const settingsPreset = document.querySelector('[data-cloud-theme-control="preset"]') as HTMLSelectElement
  const settingsScheme = document.querySelector('[data-cloud-theme-control="scheme"]') as HTMLSelectElement
  const tealButton = document.querySelector('[data-cloud-theme-accent-button="teal"]') as HTMLButtonElement
  const compactButton = document.querySelector('[data-cloud-density-button="compact"]') as HTMLButtonElement
  assert.equal(select.disabled, false)
  assert.equal(select.value, 'tokyostorm')
  assert.equal(scheme.value, 'light')
  assert.equal(accent.value, 'teal')
  assert.equal(density.value, 'compact')
  assert.equal(settingsPreset.value, 'tokyostorm')
  assert.equal(settingsScheme.value, 'light')
  assert.equal(tealButton.getAttribute('aria-pressed'), 'true')
  assert.equal(compactButton.getAttribute('aria-pressed'), 'true')
  assert.equal(document.documentElement.dataset.uiTheme, 'tokyostorm')
  assert.equal(document.documentElement.dataset.colorScheme, 'light')
  assert.equal(document.documentElement.dataset.uiAccent, 'teal')
  assert.equal(document.documentElement.dataset.density, 'compact')
  assert.equal(document.documentElement.style.getPropertyValue('--color-base'), UI_THEME_PRESETS.tokyostorm.light.base)
  assert.equal(document.documentElement.style.getPropertyValue('--color-accent'), '#3f9a8f')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-2'), '#5bb4a8')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-text'), '#2f726a')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-action-foreground'), '#000000')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-action-fill'), accentActionFillToken('#3f9a8f', '#5bb4a8'))

  select.value = 'frappe'
  scheme.value = 'dark'
  accent.value = 'rose'
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  assert.equal(localStorage.getItem(CLOUD_THEME_STORAGE_KEY), 'frappe')
  assert.equal(localStorage.getItem(CLOUD_THEME_SCHEME_STORAGE_KEY), 'dark')
  assert.equal(localStorage.getItem(CLOUD_THEME_ACCENT_STORAGE_KEY), 'rose')
  assert.equal(document.documentElement.style.getPropertyValue('--color-accent'), '#d6587e')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-2'), '#e87b9c')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-text'), '#e87b9c')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-action-foreground'), '#000000')

  settingsPreset.value = 'kanagawa'
  settingsPreset.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  assert.equal(localStorage.getItem(CLOUD_THEME_STORAGE_KEY), 'kanagawa')
  assert.equal(select.value, 'kanagawa')
  assert.equal(document.documentElement.dataset.uiTheme, 'kanagawa')

  density.value = 'comfy'
  density.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  assert.equal(localStorage.getItem(CLOUD_THEME_DENSITY_STORAGE_KEY), 'comfy')
  assert.equal(document.documentElement.dataset.density, 'comfy')

  const roseButton = document.querySelector('[data-cloud-theme-accent-button="rose"]') as HTMLButtonElement
  roseButton.click()
  assert.equal(localStorage.getItem(CLOUD_THEME_ACCENT_STORAGE_KEY), 'rose')
  assert.equal(accent.value, 'rose')
  assert.equal(roseButton.getAttribute('aria-pressed'), 'true')

  const regularButton = document.querySelector('[data-cloud-density-button="regular"]') as HTMLButtonElement
  regularButton.click()
  assert.equal(localStorage.getItem(CLOUD_THEME_DENSITY_STORAGE_KEY), 'regular')
  assert.equal(density.value, 'regular')
  assert.equal(regularButton.getAttribute('aria-pressed'), 'true')

  const notification = document.querySelector('[data-cloud-user-setting="cloud-setting-notification-voice"]') as HTMLButtonElement
  notification.click()
  assert.equal(notification.getAttribute('aria-checked'), 'false')
  assert.equal(localStorage.getItem('open-cowork-cloud-cloud-setting-notification-voice'), 'false')

  let scrolled = false
  const settingsSection = document.getElementById('cloud-settings-appearance') as HTMLElement
  settingsSection.scrollIntoView = () => {
    scrolled = true
  }
  const settingsButton = document.querySelector('[data-cloud-settings-target="cloud-settings-appearance"]') as HTMLButtonElement
  settingsButton.click()
  assert.equal(scrolled, true)
  assert.equal(dom.window.location.hash, '#settings')
}))

void test('cloud settings load and save durable user preferences through the settings API', async () => withThemeDomAsync(async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ path: string, method: string, headers: Record<string, string>, body: unknown }> = []
  document.cookie = 'open_cowork_cloud_csrf=csrf-token'
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://cloud.example.test')
    calls.push({
      path: url.pathname,
      method: String(init.method || 'GET'),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body ? JSON.parse(String(init.body)) : null,
    })
    if (init.method === 'PUT') {
      return new Response(JSON.stringify({
        setting: {
          key: 'cloud-user-preferences',
          value: JSON.parse(String(init.body || '{}')).value,
          updatedAt: '2026-06-15T00:00:00.000Z',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      setting: {
        key: 'cloud-user-preferences',
        value: {
          theme: {
            presetId: 'kanagawa',
            scheme: 'light',
            accentId: 'amber',
            density: 'comfy',
          },
          notifications: {
            voiceReplies: false,
          },
          privacy: {
            shareAnonymizedUsage: true,
          },
        },
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    installCloudThemePresetControls(bootstrap(false, true))
    await waitForAsyncClientWork()

    const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement
    const scheme = document.getElementById('cloud-theme-scheme') as HTMLSelectElement
    const accent = document.getElementById('cloud-theme-accent') as HTMLSelectElement
    const density = document.getElementById('cloud-theme-density') as HTMLSelectElement
    const notification = document.querySelector('[data-cloud-user-setting="cloud-setting-notification-voice"]') as HTMLButtonElement
    const privacy = document.querySelector('[data-cloud-user-setting="cloud-setting-privacy-share"]') as HTMLButtonElement

    assert.equal(calls[0]?.path, '/api/settings/cloud-user-preferences')
    assert.equal(calls[0]?.method, 'GET')
    assert.equal(select.value, 'kanagawa')
    assert.equal(scheme.value, 'light')
    assert.equal(accent.value, 'amber')
    assert.equal(density.value, 'comfy')
    assert.equal(notification.getAttribute('aria-checked'), 'false')
    assert.equal(privacy.getAttribute('aria-checked'), 'true')
    assert.equal(localStorage.getItem(CLOUD_THEME_STORAGE_KEY), 'kanagawa')
    assert.equal(localStorage.getItem(CLOUD_THEME_DENSITY_STORAGE_KEY), 'comfy')
    assert.equal(localStorage.getItem('open-cowork-cloud-cloud-setting-notification-voice'), 'false')

    notification.click()
    await waitForAsyncClientWork()

    const saveCall = calls.find((call) => call.method === 'PUT')
    assert.equal(saveCall?.path, '/api/settings/cloud-user-preferences')
    assert.equal(saveCall?.headers['x-csrf-token'], 'csrf-token')
    assert.deepEqual((saveCall?.body as { value: unknown }).value, {
      theme: {
        presetId: 'kanagawa',
        scheme: 'light',
        accentId: 'amber',
        density: 'comfy',
      },
      notifications: {
        voiceReplies: true,
      },
      privacy: {
        shareAnonymizedUsage: true,
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
}))

void test('cloud settings roll back user preference toggles when durable save fails', async () => withThemeDomAsync(async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ path: string, method: string, body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://cloud.example.test')
    calls.push({
      path: url.pathname,
      method: String(init.method || 'GET'),
      body: init.body ? JSON.parse(String(init.body)) : null,
    })
    if (init.method === 'PUT') {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      setting: {
        key: 'cloud-user-preferences',
        value: {
          notifications: {
            voiceReplies: true,
          },
        },
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    installCloudThemePresetControls(bootstrap(false, true))
    await waitForAsyncClientWork()

    const notification = document.querySelector('[data-cloud-user-setting="cloud-setting-notification-voice"]') as HTMLButtonElement
    assert.equal(notification.getAttribute('aria-checked'), 'true')
    assert.equal(localStorage.getItem('open-cowork-cloud-cloud-setting-notification-voice'), 'true')

    notification.click()
    await waitForAsyncClientWork()
    await waitForAsyncClientWork()

    const saveCall = calls.find((call) => call.method === 'PUT')
    assert.equal(saveCall?.path, '/api/settings/cloud-user-preferences')
    assert.deepEqual((saveCall?.body as { value: unknown }).value, {
      theme: {
        presetId: 'mercury',
        scheme: 'dark',
        accentId: 'azure',
        density: 'regular',
      },
      notifications: {
        voiceReplies: false,
      },
      privacy: {
        shareAnonymizedUsage: false,
      },
    })
    assert.equal(notification.getAttribute('aria-checked'), 'true')
    assert.equal(localStorage.getItem('open-cowork-cloud-cloud-setting-notification-voice'), 'true')
  } finally {
    globalThis.fetch = originalFetch
  }
}))

void test('cloud settings do not save stale defaults before durable preferences hydrate', async () => withThemeDomAsync(async () => {
  const originalFetch = globalThis.fetch
  let resolveGet: ((response: Response) => void) | null = null
  const calls: Array<{ path: string, method: string }> = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://cloud.example.test')
    calls.push({
      path: url.pathname,
      method: String(init.method || 'GET'),
    })
    if (init.method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Promise<Response>((resolve) => {
      resolveGet = resolve
    })
  }) as typeof fetch

  try {
    installCloudThemePresetControls(bootstrap(false, true))
    await waitForAsyncClientWork()

    const notification = document.querySelector('[data-cloud-user-setting="cloud-setting-notification-voice"]') as HTMLButtonElement
    notification.click()
    await waitForAsyncClientWork()
    await waitForAsyncClientWork()

    assert.equal(calls.filter((call) => call.method === 'PUT').length, 0)
    assert.equal(notification.getAttribute('aria-checked'), 'true')

    const resolveInitialPreferences = resolveGet as ((response: Response) => void) | null
    assert.ok(resolveInitialPreferences)
    resolveInitialPreferences(new Response(JSON.stringify({
      setting: {
        key: 'cloud-user-preferences',
        value: {
          notifications: {
            voiceReplies: false,
          },
        },
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await waitForAsyncClientWork()

    assert.equal(notification.getAttribute('aria-checked'), 'false')
    assert.equal(localStorage.getItem('open-cowork-cloud-cloud-setting-notification-voice'), 'false')
  } finally {
    globalThis.fetch = originalFetch
  }
}))

void test('cloud settings serialize durable preference saves so later choices win', async () => withThemeDomAsync(async () => {
  const originalFetch = globalThis.fetch
  const saves: Array<{ body: { value: unknown }, resolve: (response: Response) => void }> = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://cloud.example.test')
    assert.equal(url.pathname, '/api/settings/cloud-user-preferences')
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body || '{}')) as { value: unknown }
      return new Promise<Response>((resolve) => {
        saves.push({ body, resolve })
      })
    }
    return new Response(JSON.stringify({
      setting: {
        key: 'cloud-user-preferences',
        value: {
          notifications: {
            voiceReplies: true,
          },
          privacy: {
            shareAnonymizedUsage: false,
          },
        },
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    installCloudThemePresetControls(bootstrap(false, true))
    await waitForAsyncClientWork()

    const notification = document.querySelector('[data-cloud-user-setting="cloud-setting-notification-voice"]') as HTMLButtonElement
    const privacy = document.querySelector('[data-cloud-user-setting="cloud-setting-privacy-share"]') as HTMLButtonElement
    notification.click()
    await waitForAsyncClientWork()
    privacy.click()
    await waitForAsyncClientWork()
    await waitForAsyncClientWork()

    assert.equal(saves.length, 1)
    assert.deepEqual(saves[0]?.body.value, {
      theme: {
        presetId: 'mercury',
        scheme: 'dark',
        accentId: 'azure',
        density: 'regular',
      },
      notifications: {
        voiceReplies: false,
      },
      privacy: {
        shareAnonymizedUsage: false,
      },
    })

    saves[0]?.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await waitForAsyncClientWork()
    await waitForAsyncClientWork()

    assert.equal(saves.length, 2)
    assert.deepEqual(saves[1]?.body.value, {
      theme: {
        presetId: 'mercury',
        scheme: 'dark',
        accentId: 'azure',
        density: 'regular',
      },
      notifications: {
        voiceReplies: false,
      },
      privacy: {
        shareAnonymizedUsage: true,
      },
    })
    saves[1]?.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  } finally {
    globalThis.fetch = originalFetch
  }
}))

void test('cloud settings ignore stale failed saves after newer preference changes', async () => withThemeDomAsync(async () => {
  const originalFetch = globalThis.fetch
  const saves: Array<{ body: { value: unknown }, resolve: (response: Response) => void }> = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://cloud.example.test')
    assert.equal(url.pathname, '/api/settings/cloud-user-preferences')
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body || '{}')) as { value: unknown }
      return new Promise<Response>((resolve) => {
        saves.push({ body, resolve })
      })
    }
    return new Response(JSON.stringify({
      setting: {
        key: 'cloud-user-preferences',
        value: {
          notifications: {
            voiceReplies: true,
          },
          privacy: {
            shareAnonymizedUsage: false,
          },
        },
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    installCloudThemePresetControls(bootstrap(false, true))
    await waitForAsyncClientWork()

    const notification = document.querySelector('[data-cloud-user-setting="cloud-setting-notification-voice"]') as HTMLButtonElement
    const privacy = document.querySelector('[data-cloud-user-setting="cloud-setting-privacy-share"]') as HTMLButtonElement
    notification.click()
    await waitForAsyncClientWork()
    privacy.click()
    await waitForAsyncClientWork()

    assert.equal(saves.length, 1)
    saves[0]?.resolve(new Response(JSON.stringify({ error: 'temporary' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }))
    await waitForAsyncClientWork()
    await waitForAsyncClientWork()

    assert.equal(notification.getAttribute('aria-checked'), 'false')
    assert.equal(privacy.getAttribute('aria-checked'), 'true')
    assert.equal(saves.length, 2)
    assert.deepEqual(saves[1]?.body.value, {
      theme: {
        presetId: 'mercury',
        scheme: 'dark',
        accentId: 'azure',
        density: 'regular',
      },
      notifications: {
        voiceReplies: false,
      },
      privacy: {
        shareAnonymizedUsage: true,
      },
    })
    saves[1]?.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  } finally {
    globalThis.fetch = originalFetch
  }
}))

void test('cloud theme switcher survives React hydration replacing the select node', () => withThemeDom((dom) => {
  installCloudThemePresetControls(bootstrap(false))
  const options = cloudThemePresetOptions()
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('')
  const accents = cloudAccentPresetOptions()
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('')
  const densities = cloudDensityOptions()
    .map((density) => `<option value="${density.id}">${density.label}</option>`)
    .join('')
  document.body.innerHTML = `<select id="cloud-theme-preset">${options}</select><select id="cloud-theme-scheme"><option value="dark">Mercury</option><option value="light">Day</option></select><select id="cloud-theme-accent">${accents}</select><select id="cloud-theme-density">${densities}</select>`

  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement
  const scheme = document.getElementById('cloud-theme-scheme') as HTMLSelectElement
  const accent = document.getElementById('cloud-theme-accent') as HTMLSelectElement
  const density = document.getElementById('cloud-theme-density') as HTMLSelectElement
  select.value = 'frappe'
  scheme.value = 'light'
  accent.value = 'amber'
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  density.value = 'compact'
  density.dispatchEvent(new dom.window.Event('change', { bubbles: true }))

  assert.equal(localStorage.getItem(CLOUD_THEME_STORAGE_KEY), 'frappe')
  assert.equal(localStorage.getItem(CLOUD_THEME_SCHEME_STORAGE_KEY), 'light')
  assert.equal(localStorage.getItem(CLOUD_THEME_ACCENT_STORAGE_KEY), 'amber')
  assert.equal(localStorage.getItem(CLOUD_THEME_DENSITY_STORAGE_KEY), 'compact')
  assert.equal(document.documentElement.dataset.uiTheme, 'frappe')
  assert.equal(document.documentElement.dataset.colorScheme, 'light')
  assert.equal(document.documentElement.dataset.density, 'compact')
  assert.equal(document.documentElement.style.getPropertyValue('--color-base'), UI_THEME_PRESETS.frappe.light.base)
  assert.equal(document.documentElement.style.getPropertyValue('--color-accent'), '#e0913a')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-text'), '#966127')
}))

void test('cloud theme switcher preserves tenant branding when locked', () => withThemeDom(() => {
  localStorage.setItem(CLOUD_THEME_STORAGE_KEY, 'frappe')
  installCloudThemePresetControls(bootstrap(true))
  const select = document.getElementById('cloud-theme-preset') as HTMLSelectElement
  const scheme = document.getElementById('cloud-theme-scheme') as HTMLSelectElement
  const accent = document.getElementById('cloud-theme-accent') as HTMLSelectElement
  const density = document.getElementById('cloud-theme-density') as HTMLSelectElement
  assert.equal(select.disabled, true)
  assert.equal(scheme.disabled, true)
  assert.equal(accent.disabled, true)
  assert.equal(density.disabled, false)
  assert.equal(select.dataset.tenantBrandingLocked, 'true')
  assert.equal(document.documentElement.style.getPropertyValue('--color-base'), '')
  assert.equal(document.documentElement.dataset.density, 'regular')
}))

void test('cloud theme applies preset tokens directly', () => withThemeDom(() => {
  applyCloudThemePreset('gruvbox', 'light', 'plum')
  assert.equal(document.documentElement.dataset.uiTheme, 'gruvbox')
  assert.equal(document.documentElement.dataset.colorScheme, 'light')
  assert.equal(document.documentElement.dataset.uiAccent, 'plum')
  assert.equal(document.documentElement.style.getPropertyValue('--color-base'), UI_THEME_PRESETS.gruvbox.light.base)
  assert.equal(document.documentElement.style.getPropertyValue('--accent'), '#8b7cf0')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-2'), '#a594f5')
  assert.equal(document.documentElement.style.getPropertyValue('--accent-text'), '#6c61bb')
  assert.equal(document.documentElement.style.getPropertyValue('--focus'), focusTokenForAccent('#8b7cf0'))
}))

void test('cloud density applies directly with a regular fallback', () => withThemeDom(() => {
  applyCloudDensity('compact')
  assert.equal(document.documentElement.dataset.density, 'compact')
  applyCloudDensity('wide')
  assert.equal(document.documentElement.dataset.density, 'regular')
}))
