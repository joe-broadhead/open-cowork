import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

// Shared bootstrap for every Electron smoke test: launches the packaged
// renderer bundle against an isolated HOME + XDG dirs so tests never
// mutate the developer's real sandbox / credentials / sessions. Each
// test gets a fresh temp root that's cleaned up on close.

const thisDir = fileURLToPath(new URL('.', import.meta.url))
export const desktopAppDir = resolve(thisDir, '..')
export const repoRoot = resolve(desktopAppDir, '../..')

export interface SmokeHarness {
  app: ElectronApplication
  page: Page
  cleanup: () => Promise<void>
}

const SMOKE_BRAND_NAME = 'Open Cowork Smoke'

function writeIsolatedConfig(tempRoot: string) {
  // Borrow upstream's config but rebrand dataDirName so the test install
  // can't collide with a developer's real Open Cowork state on disk.
  const sourcePath = join(repoRoot, 'open-cowork.config.json')
  const config = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, any>
  config.branding = {
    ...(config.branding || {}),
    name: SMOKE_BRAND_NAME,
    appId: 'com.opencowork.desktop.smoke',
    dataDirName: 'open-cowork-smoke',
  }
  const targetPath = join(tempRoot, 'open-cowork.smoke.config.json')
  writeFileSync(targetPath, JSON.stringify(config, null, 2))
  return targetPath
}


export async function launchSmokeApp(): Promise<SmokeHarness> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-smoke-'))
  const tempHome = join(tempRoot, 'home')
  const xdgConfigHome = join(tempRoot, 'xdg-config')
  const xdgDataHome = join(tempRoot, 'xdg-data')
  const xdgCacheHome = join(tempRoot, 'xdg-cache')
  const sandboxDir = join(tempRoot, 'sandbox')

  for (const dir of [tempHome, xdgConfigHome, xdgDataHome, xdgCacheHome, sandboxDir]) {
    mkdirSync(dir, { recursive: true })
  }

  const configPath = writeIsolatedConfig(tempRoot)

  const app = await electron.launch({
    cwd: desktopAppDir,
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      OPEN_COWORK_CONFIG_PATH: configPath,
      OPEN_COWORK_SANDBOX_DIR: sandboxDir,
      OPEN_COWORK_CHART_TIMEOUT_MS: '1500',
      OPEN_COWORK_E2E: '1',
    },
  })

  const page = await app.firstWindow()
  // Wait for the preload to attach `coworkApi` — until that happens any
  // renderer-side test is racing app bootstrap. We also wait for the
  // React root to exist so the test can `click` / `fill` against real
  // DOM rather than the loading shell.
  await page.waitForFunction(() => Boolean(
    document.querySelector('#root')
    && typeof window.coworkApi?.app?.config === 'function',
  ))

  // Seed a provider selection + fake credential so `isSetupComplete`
  // returns true and the app enters the main UI instead of parking on
  // the first-run SetupScreen. The fake key never hits a real provider
  // — no smoke test sends prompts — so it's fine to embed here.
  await page.evaluate(async () => {
    await window.coworkApi.settings.set({
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      providerCredentials: {
        openrouter: { apiKey: 'sk-or-smoke-test-fake-key-for-e2e-bootstrap' },
      },
    })
  })
  // Reload so App.tsx re-reads settings + config on next mount. After
  // the reload the main UI replaces the SetupScreen.
  await page.reload()
  await page.waitForFunction(() => Boolean(
    document.querySelector('#root')
    && typeof window.coworkApi?.app?.config === 'function',
  ))

  return {
    app,
    page,
    async cleanup() {
      await app.close()
      rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}
