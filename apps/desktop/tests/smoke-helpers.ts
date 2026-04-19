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

export interface SmokePaths {
  tempRoot: string
  tempHome: string
  dataRoot: string
  xdgConfigHome: string
  xdgDataHome: string
  xdgCacheHome: string
  sandboxDir: string
  configPath: string
}

export interface SmokeSession {
  app: ElectronApplication
  page: Page
  close: () => Promise<void>
}

export interface LaunchSmokeAppOptions {
  // Called with the isolated data root *before* Electron launches.
  // Use this to seed files like `sessions.json` under the path the
  // branded `dataDirName` would resolve to, so the loader picks them
  // up during app bootstrap.
  seedBeforeLaunch?: (paths: { tempRoot: string; dataRoot: string }) => void
}

export interface LaunchSmokeSessionOptions {
  executablePath?: string
}

const SMOKE_BRAND_NAME = 'Open Cowork Smoke'

export async function waitForAppShell(page: Page, timeout = 15_000) {
  await page.waitForFunction(() => Boolean(
    document.querySelector('#root')
    && typeof window.coworkApi?.app?.config === 'function'
    && typeof window.coworkApi?.settings?.set === 'function'
    && typeof window.coworkApi?.custom?.listMcps === 'function',
  ), { timeout })
  await page.getByRole('button', { name: 'Home', exact: true }).first().waitFor({ timeout })
}

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
  const openRouterCredentials = config.providers?.descriptors?.openrouter?.credentials
  if (Array.isArray(openRouterCredentials)) {
    // Smoke runs are about shell/session health, not validating provider
    // credential persistence on first boot. Make the default provider
    // credential optional in the isolated smoke config so packaged tests
    // can boot without mutating persisted secrets at runtime.
    config.providers.descriptors.openrouter.credentials = openRouterCredentials.map((credential: Record<string, unknown>) => ({
      ...credential,
      required: false,
    }))
  }
  const targetPath = join(tempRoot, 'open-cowork.smoke.config.json')
  writeFileSync(targetPath, JSON.stringify(config, null, 2))
  return targetPath
}

export function createSmokePaths(options?: LaunchSmokeAppOptions): SmokePaths {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-smoke-'))
  const tempHome = join(tempRoot, 'home')
  const dataRoot = join(tempRoot, 'user-data')
  const xdgConfigHome = join(tempRoot, 'xdg-config')
  const xdgDataHome = join(tempRoot, 'xdg-data')
  const xdgCacheHome = join(tempRoot, 'xdg-cache')
  const sandboxDir = join(tempRoot, 'sandbox')

  for (const dir of [tempHome, dataRoot, xdgConfigHome, xdgDataHome, xdgCacheHome, sandboxDir]) {
    mkdirSync(dir, { recursive: true })
  }

  const configPath = writeIsolatedConfig(tempRoot)

  if (options?.seedBeforeLaunch) {
    options.seedBeforeLaunch({ tempRoot, dataRoot })
  }

  return {
    tempRoot,
    tempHome,
    dataRoot,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    sandboxDir,
    configPath,
  }
}

export function cleanupSmokePaths(paths: SmokePaths) {
  rmSync(paths.tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function getSmokeEnvironment(paths: SmokePaths) {
  return {
    ...process.env,
    HOME: paths.tempHome,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_DATA_HOME: paths.xdgDataHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    OPEN_COWORK_CONFIG_PATH: paths.configPath,
    OPEN_COWORK_USER_DATA_DIR: paths.dataRoot,
    OPEN_COWORK_SANDBOX_DIR: paths.sandboxDir,
    OPEN_COWORK_CHART_TIMEOUT_MS: '1500',
    OPEN_COWORK_E2E: '1',
  }
}

async function closeSmokeApp(app: ElectronApplication) {
  await app.close()
  // Runtime reboot tests can leave the bundled opencode child exiting
  // slightly after Electron closes. Give the OS a moment to release
  // the temp tree before cleanup or relaunch.
  await new Promise((done) => setTimeout(done, 250))
}

async function bootstrapSmokeSettings(page: Page) {
  const setupComplete = await page.evaluate(async () => {
    const [config, settings] = await Promise.all([
      window.coworkApi.app.config(),
      window.coworkApi.settings.getWithCredentials(),
    ])
    if (!settings.effectiveProviderId || !settings.effectiveModel) return false
    const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId)
    if (!provider) return false
    return provider.credentials.every((credential) => {
      if (credential.required === false) return true
      const value = settings.providerCredentials?.[provider.id]?.[credential.key]
      return typeof value === 'string' && value.trim().length > 0
    })
  })

  if (setupComplete) {
    await waitForAppShell(page, 30_000)
    return
  }

  // Seed a provider selection + fake credential so `isSetupComplete`
  // returns true and the app enters the main UI instead of parking on
  // the first-run SetupScreen. The fake key never hits a real provider
  // in smoke — no test depends on successful external LLM calls.
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
    && typeof window.coworkApi?.app?.config === 'function'
    && typeof window.coworkApi?.settings?.get === 'function',
  ))
  await waitForAppShell(page, 30_000)
}

export async function launchSmokeSession(
  paths: SmokePaths,
  options?: LaunchSmokeSessionOptions,
): Promise<SmokeSession> {
  const app = await electron.launch({
    cwd: desktopAppDir,
    executablePath: options?.executablePath,
    args: options?.executablePath ? [] : ['.'],
    env: getSmokeEnvironment(paths),
  })

  const page = await app.firstWindow()
  // Wait for the preload to attach `coworkApi` — until that happens any
  // renderer-side test is racing app bootstrap. We also wait for the
  // settings bridge because the bootstrap path below depends on it.
  await page.waitForFunction(() => Boolean(
    document.querySelector('#root')
    && typeof window.coworkApi?.app?.config === 'function'
    && typeof window.coworkApi?.settings?.get === 'function',
  ))

  await bootstrapSmokeSettings(page)

  return {
    app,
    page,
    async close() {
      await closeSmokeApp(app)
    },
  }
}

export async function launchSmokeApp(options?: LaunchSmokeAppOptions): Promise<SmokeHarness> {
  const paths = createSmokePaths(options)
  const session = await launchSmokeSession(paths)

  return {
    app: session.app,
    page: session.page,
    async cleanup() {
      await session.close()
      cleanupSmokePaths(paths)
    },
  }
}
