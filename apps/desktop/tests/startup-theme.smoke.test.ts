import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import {
  DEFAULT_DARK_BRAND_THEME,
  DEFAULT_LIGHT_BRAND_THEME,
  resolveStartupAppearance,
  type BrandThemeDefinition,
  type StartupSurfaceState,
} from '@open-cowork/shared'
import { writeStartupSplashFile } from '../src/main/startup-splash.ts'
import { desktopAppDir } from './smoke-helpers.ts'

const PROBE_THEME: BrandThemeDefinition = {
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

function state(
  brandName: string,
  colorScheme: 'light' | 'dark',
  branding: { defaultTheme?: string; themes?: BrandThemeDefinition[] } = { defaultTheme: 'mercury' },
): StartupSurfaceState {
  return {
    brandName,
    ...resolveStartupAppearance({
      branding,
      preferences: { colorScheme },
      systemColorScheme: colorScheme,
    }),
  }
}

function rgbChannels(value: string) {
  const match = value.match(/^rgba?\((\d+),?\s+(\d+),?\s+(\d+)/)
    || value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  assert.ok(match, `expected an rgb color, received ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const
}

function relativeLuminance(value: string) {
  const channels = rgbChannels(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
}

async function renderedState(page: Page) {
  await page.waitForSelector('[data-startup-surface]')
  return page.evaluate(() => {
    const root = document.documentElement
    const rootStyle = getComputedStyle(root)
    const surface = document.body.dataset.startupSurface || ''
    const bodyStyle = getComputedStyle(document.body)
    const heading = surface === 'loading'
      ? document.querySelector('h1')
      : document.querySelector('.title')
    return {
      surface,
      brandName: (surface === 'loading'
        ? document.querySelector('#runtime-brand')
        : document.querySelector('.title'))?.textContent || '',
      colorScheme: root.dataset.colorScheme || '',
      themeId: root.dataset.uiTheme || '',
      background: surface === 'loading' ? rootStyle.backgroundColor : bodyStyle.backgroundColor,
      text: heading ? getComputedStyle(heading).color : '',
      accent: rootStyle.getPropertyValue('--color-accent').trim(),
      width: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      height: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
    }
  })
}

test('desktop startup surfaces paint readable light, dark, and downstream brand states before reveal', async () => {
  const expectedStates = [
    state('Open Cowork Dark', 'dark'),
    state('Open Cowork Light', 'light'),
    state('Northstar Cowork', 'dark', { defaultTheme: PROBE_THEME.id, themes: [PROBE_THEME] }),
  ]
  const splashRoot = mkdtempSync(join(tmpdir(), 'open-cowork-startup-theme-probe-'))
  const splashPaths = expectedStates.map((startupState, index) => writeStartupSplashFile({
    templatePath: join(desktopAppDir, 'public/startup-splash.html'),
    outputDir: join(splashRoot, String(index)),
    state: startupState,
  }))
  const app = await electron.launch({
    cwd: desktopAppDir,
    args: ['tests/fixtures/startup-theme-probe-main.mjs'],
    env: {
      ...process.env,
      OPEN_COWORK_STARTUP_PROBE_SPLASH_PATHS: JSON.stringify(splashPaths),
      OPEN_COWORK_STARTUP_PROBE_STATES: JSON.stringify(expectedStates),
    },
  })

  try {
    while (app.windows().length < expectedStates.length * 2) {
      await app.waitForEvent('window', { timeout: 10_000 })
    }

    const pages = app.windows()
    const actualByBrand = new Map<string, Awaited<ReturnType<typeof renderedState>>>()
    const screenshotDir = process.env.OPEN_COWORK_STARTUP_PROBE_SCREENSHOT_DIR
    if (screenshotDir) mkdirSync(screenshotDir, { recursive: true })

    for (const page of pages) {
      const actual = await renderedState(page)
      actualByBrand.set(`${actual.surface}:${actual.brandName}`, actual)
      const screenshot = await page.screenshot(screenshotDir
        ? { path: join(screenshotDir, `${actual.surface}-${actual.themeId}-${actual.colorScheme}.png`) }
        : undefined)
      assert.ok(screenshot.byteLength > 8_000)
    }

    for (const surface of ['loading', 'splash']) {
      for (const expected of expectedStates) {
        const actual = actualByBrand.get(`${surface}:${expected.brandName}`)
        assert.ok(actual, `missing ${surface} startup state for ${expected.brandName}`)
        assert.equal(actual.colorScheme, expected.colorScheme)
        assert.equal(actual.themeId, expected.themeId)
        assert.equal(actual.accent, expected.tokens.accent)
        assert.ok(contrastRatio(actual.text, actual.background) >= 4.5)
        assert.ok(actual.width <= actual.viewportWidth)
        assert.ok(actual.height <= actual.viewportHeight)
      }
    }
  } finally {
    await app.close()
    rmSync(splashRoot, { recursive: true, force: true })
  }
})
