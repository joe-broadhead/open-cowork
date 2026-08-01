import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_DARK_BRAND_THEME,
  DEFAULT_LIGHT_BRAND_THEME,
  parseStartupSurfaceState,
  resolveStartupAppearance,
  serializeStartupSurfaceState,
  startupSurfaceQuery,
  type BrandThemeDefinition,
  type StartupSurfaceState,
} from '@open-cowork/shared'
import { prepareStartupSplashFile, writeStartupSplashFile } from '../apps/desktop/src/main/startup-splash.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const NORTHSTAR_THEME: BrandThemeDefinition = {
  id: 'northstar',
  label: 'Northstar',
  dark: {
    ...DEFAULT_DARK_BRAND_THEME,
    base: '#101820',
    surface: '#18242f',
    text: '#f5f8fa',
    textSecondary: '#b9c8d4',
    accent: '#5bc0eb',
    accent2: '#9adcf7',
  },
  light: {
    ...DEFAULT_LIGHT_BRAND_THEME,
    base: '#f2f7fa',
    surface: '#ffffff',
    text: '#16242f',
    textSecondary: '#536879',
    accent: '#087ea4',
    accent2: '#0b6f91',
  },
}

function startupState(overrides?: {
  colorScheme?: 'dark' | 'light' | 'system'
  systemColorScheme?: 'dark' | 'light'
  brandName?: string
  themeId?: string
  branded?: boolean
}): StartupSurfaceState {
  const branding = overrides?.branded
    ? { defaultTheme: NORTHSTAR_THEME.id, themes: [NORTHSTAR_THEME] }
    : { defaultTheme: 'mercury' }
  return {
    brandName: overrides?.brandName || 'Open Cowork',
    ...resolveStartupAppearance({
      branding,
      preferences: {
        colorScheme: overrides?.colorScheme || 'dark',
        themeId: overrides?.themeId,
      },
      systemColorScheme: overrides?.systemColorScheme || 'dark',
    }),
  }
}

function relativeLuminance(hex: string) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `expected a six-digit hex color, received ${hex}`)
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
}

test('writeStartupSplashFile writes escaped branded HTML privately', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-startup-splash-'))

  try {
    const templatePath = join(root, 'template.html')
    writeFileSync(templatePath, '<title>Open Cowork</title><h1>Open Cowork</h1>')

    const outputPath = writeStartupSplashFile({
      templatePath,
      outputDir: join(root, 'user-data', 'startup'),
      state: startupState({ brandName: '<Acme & Co>' }),
    })

    assert.equal(
      readFileSync(outputPath, 'utf-8'),
      '<title>&lt;Acme &amp; Co&gt;</title><h1>&lt;Acme &amp; Co&gt;</h1>',
    )
    assert.equal(statSync(outputPath).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup splash falls back to a standalone adaptive packaged surface when generation fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-startup-splash-fallback-'))

  try {
    const templatePath = join(repoRoot, 'apps/desktop/public/startup-splash.html')
    const blockedOutputDir = join(root, 'not-a-directory')
    writeFileSync(blockedOutputDir, 'block directory creation')

    const result = prepareStartupSplashFile({
      templatePath,
      outputDir: blockedOutputDir,
      state: startupState({ colorScheme: 'light' }),
    })
    const fallback = readFileSync(result.path, 'utf8')

    assert.equal(result.path, templatePath)
    assert.ok(result.error)
    assert.doesNotMatch(fallback, /%%[A-Z0-9_]+%%/)
    assert.match(fallback, /data-color-scheme="system" data-ui-theme="system"/)
    assert.match(fallback, /color-scheme:\s*light dark/)
    assert.match(fallback, /--color-base:\s*Canvas/)
    assert.match(fallback, /--color-text:\s*CanvasText/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup splash resolves readable dark and light fixtures from shared theme tokens', () => {
  for (const colorScheme of ['dark', 'light'] as const) {
    const root = mkdtempSync(join(tmpdir(), `open-cowork-startup-splash-${colorScheme}-`))
    try {
      const state = startupState({ colorScheme })
      const outputPath = writeStartupSplashFile({
        templatePath: join(repoRoot, 'apps/desktop/public/startup-splash.html'),
        outputDir: join(root, 'user-data', 'startup'),
        state,
      })
      const html = readFileSync(outputPath, 'utf8')

      assert.doesNotMatch(html, /%%[A-Z0-9_]+%%/)
      assert.match(html, new RegExp(`data-color-scheme="${colorScheme}"`))
      assert.match(html, new RegExp(`color-scheme:\\s*${colorScheme}`))
      assert.ok(html.includes(`--color-base: ${state.tokens.base}`))
      assert.ok(html.includes(`--color-text: ${state.tokens.text}`))
      assert.ok(contrastRatio(state.tokens.text, state.tokens.base) >= 4.5)
      assert.ok(contrastRatio(state.tokens.textSecondary, state.tokens.base) >= 4.5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('startup splash honors a downstream default brand in both schemes', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-startup-splash-brand-'))

  try {
    for (const colorScheme of ['dark', 'light'] as const) {
      const state = startupState({
        brandName: '<Northstar & Co>',
        branded: true,
        colorScheme,
      })
      const outputPath = writeStartupSplashFile({
        templatePath: join(repoRoot, 'apps/desktop/public/startup-splash.html'),
        outputDir: join(root, colorScheme),
        state,
      })
      const html = readFileSync(outputPath, 'utf8')

      assert.equal(state.themeId, 'northstar')
      assert.match(html, /data-ui-theme="northstar"/)
      assert.match(html, /&lt;Northstar &amp; Co&gt; is starting/)
      assert.ok(html.includes(`--color-base: ${state.tokens.base}`))
      assert.ok(html.includes(`--color-accent: ${state.tokens.accent}`))
      assert.ok(contrastRatio(state.tokens.text, state.tokens.base) >= 4.5)
      assert.ok(contrastRatio(state.tokens.textSecondary, state.tokens.base) >= 4.5)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup appearance resolves system preference and rejects malformed renderer payloads', () => {
  const light = startupState({ colorScheme: 'system', systemColorScheme: 'light' })
  const search = new URLSearchParams(startupSurfaceQuery(light)).toString()

  assert.equal(light.colorScheme, 'light')
  assert.deepEqual(parseStartupSurfaceState(`?${search}`), light)
  assert.equal(parseStartupSurfaceState('?startup-state=%7Bbroken'), null)

  const tampered = JSON.parse(serializeStartupSurfaceState(light)) as Record<string, unknown>
  tampered.tokens = { base: '#ffffff' }
  assert.equal(
    parseStartupSurfaceState(`?startup-state=${encodeURIComponent(JSON.stringify(tampered))}`),
    null,
  )
})
