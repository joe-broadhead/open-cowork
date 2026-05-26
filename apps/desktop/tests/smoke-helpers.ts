import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  _electron as electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page,
} from 'playwright-core'
import {
  buildE2EArgEnvironment,
  E2E_ARG_ENV_ENABLE_KEY,
} from '../src/main/e2e-remote-debugging.ts'

// Shared bootstrap for every Electron smoke test: launches the packaged
// renderer bundle against an isolated HOME + XDG dirs so tests never
// mutate the developer's real sandbox / credentials / sessions. Each
// test gets a fresh temp root that's cleaned up on close.

const thisDir = fileURLToPath(new URL('.', import.meta.url))
export const desktopAppDir = resolve(thisDir, '..')
export const repoRoot = resolve(desktopAppDir, '../..')

export async function acceptNextNativeConfirmation(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    const originalShowMessageBox = dialog.showMessageBox.bind(dialog)
    dialog.showMessageBox = (async (..._args: Parameters<typeof dialog.showMessageBox>) => {
      dialog.showMessageBox = originalShowMessageBox as typeof dialog.showMessageBox
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
}

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
  app?: ElectronApplication
  page: Page
  close: () => Promise<void>
}

export type PackagedMacProbe = {
  surface: {
    sessionCreate: string
    settingsSet: string
    workflowsStartDraft: string
    updatesInstallCapability: string
    onSessionPatch: string
  }
  settings: {
    effectiveProviderId: unknown
    effectiveModel: unknown
  }
  installCapability: {
    supported: unknown
    reason?: unknown
    currentVersion?: unknown
  }
  sessions: Array<{ id: string }>
  createdSessionId: string | null
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
  appShellTimeoutMs?: number
}

const SMOKE_BRAND_NAME = 'Open Cowork Smoke'

async function getAppShellDiagnostics(page: Page) {
  try {
    return await page.evaluate(async () => {
      const runtimeStatus = await window.coworkApi?.runtime?.status?.().catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
      return {
        url: window.location.href,
        title: document.title,
        hasRoot: Boolean(document.querySelector('#root')),
        hasHomeView: Boolean(document.querySelector('[data-testid="home-view"]')),
        hasCoworkApi: Boolean(window.coworkApi),
        runtimeStatus,
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1_500),
      }
    })
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function waitForAppShell(page: Page, timeout = 15_000) {
  try {
    await page.waitForFunction(() => Boolean(
      document.querySelector('#root')
      && typeof window.coworkApi?.app?.config === 'function'
      && typeof window.coworkApi?.settings?.set === 'function'
      && typeof window.coworkApi?.custom?.listMcps === 'function',
    ), { timeout })
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="home-view"]')), { timeout })
  } catch (error) {
    const diagnostics = await getAppShellDiagnostics(page)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Timed out waiting for app shell: ${message}\nDiagnostics: ${JSON.stringify(diagnostics)}`, { cause: error })
  }
}

export async function waitForRuntimeReady(page: Page, timeout = 20_000) {
  try {
    await page.evaluate(() => {
      const state = window as unknown as {
        __openCoworkRuntimeReady?: boolean
        __openCoworkRuntimeReadyProbeInFlight?: boolean
      }
      state.__openCoworkRuntimeReady = false
      state.__openCoworkRuntimeReadyProbeInFlight = false
    })
    await page.waitForFunction(() => {
      const state = window as unknown as {
        __openCoworkRuntimeReady?: boolean
        __openCoworkRuntimeReadyProbeInFlight?: boolean
      }
      if (state.__openCoworkRuntimeReadyProbeInFlight) return state.__openCoworkRuntimeReady === true
      state.__openCoworkRuntimeReadyProbeInFlight = true
      void window.coworkApi?.runtime?.status?.()
        .then((status) => {
          state.__openCoworkRuntimeReady = Boolean(status?.ready)
        })
        .catch(() => {
          state.__openCoworkRuntimeReady = false
        })
        .finally(() => {
          state.__openCoworkRuntimeReadyProbeInFlight = false
        })
      return state.__openCoworkRuntimeReady === true
    }, undefined, { timeout })
  } catch (error) {
    const diagnostics = await getAppShellDiagnostics(page)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Timed out waiting for runtime readiness: ${message}\nDiagnostics: ${JSON.stringify(diagnostics)}`, { cause: error })
  }
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
  try {
    rmSync(paths.tempRoot, { recursive: true, force: true, maxRetries: 80, retryDelay: 125 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') {
      console.warn(`Smoke temp cleanup skipped for ${paths.tempRoot}: ${code}`)
      return
    }
    throw error
  }
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

function getMacAppBundlePath(executablePath: string) {
  const bundleMarker = '.app/Contents/MacOS/'
  const markerIndex = executablePath.indexOf(bundleMarker)
  if (markerIndex < 0) return null
  return executablePath.slice(0, markerIndex + '.app'.length)
}

function getLaunchServicesEnvironment(paths: SmokePaths, port: number) {
  const env = {
    ...getSmokeEnvironment(paths),
    [E2E_ARG_ENV_ENABLE_KEY]: '1',
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: String(port),
  }
  const keys = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'OPEN_COWORK_CONFIG_PATH',
    'OPEN_COWORK_USER_DATA_DIR',
    'OPEN_COWORK_SANDBOX_DIR',
    'OPEN_COWORK_CHART_TIMEOUT_MS',
    'OPEN_COWORK_E2E',
    'OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT',
    E2E_ARG_ENV_ENABLE_KEY,
    'CI',
  ])

  return Object.fromEntries(
    Array.from(keys)
      .map((key) => [key, env[key]] as const)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

async function delay(ms: number) {
  await new Promise((done) => setTimeout(done, ms))
}

async function withSmokeTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function getAvailablePort() {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
  return address.port
}

async function isCdpAvailable(port: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForCdp(port: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isCdpAvailable(port)) return
    await delay(250)
  }
  throw new Error(`Timed out waiting for packaged app CDP endpoint on 127.0.0.1:${port}`)
}

async function waitForCdpPage(browser: Browser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://'))
      if (page) return page
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for packaged app renderer page')
}

async function appBridgeIsReady(page: Page) {
  try {
    return await page.evaluate(() => Boolean(
      document.querySelector('#root')
      && typeof window.coworkApi?.app?.config === 'function'
      && typeof window.coworkApi?.settings?.get === 'function',
    ))
  } catch {
    return false
  }
}

async function waitForCdpAppPage(browser: Browser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('devtools://')) continue
        if (await appBridgeIsReady(page)) return page
      }
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for packaged app shell page')
}

function runCommand(command: string, args: string[], timeoutMs = 10_000) {
  return new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      rejectCommand(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolveCommand()
        return
      }
      rejectCommand(new Error(`${command} exited with ${signal || code}`))
    })
  })
}

async function waitForElectronAppPage(app: ElectronApplication, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (await appBridgeIsReady(page)) return page
    }
    await Promise.race([
      app.waitForEvent('window', { timeout: Math.min(250, Math.max(1, deadline - Date.now())) }).catch(() => null),
      delay(100),
    ])
  }
  const diagnostics = await Promise.all(app.windows().map((page) => getAppShellDiagnostics(page)))
  throw new Error(`Timed out waiting for Electron app shell page\nDiagnostics: ${JSON.stringify(diagnostics)}`)
}

export async function launchPackagedMacProbe(
  paths: SmokePaths,
  executablePath: string,
  options?: { action?: 'surface' | 'create-session' | 'list-sessions'; timeoutMs?: number },
): Promise<PackagedMacProbe> {
  if (process.platform !== 'darwin') {
    throw new Error('launchPackagedMacProbe is only supported on macOS')
  }
  let session: SmokeSession | null = null
  try {
    session = await launchSmokeSession(paths, {
      executablePath,
      appShellTimeoutMs: options?.timeoutMs ?? 90_000,
    })
    const action = options?.action || 'surface'
    return await withSmokeTimeout(
      'running packaged macOS probe',
      session.page.evaluate(async (probeAction): Promise<PackagedMacProbe> => {
        const surface = {
          sessionCreate: typeof window.coworkApi.session?.create,
          settingsSet: typeof window.coworkApi.settings?.set,
          workflowsStartDraft: typeof window.coworkApi.workflows?.startDraft,
          updatesInstallCapability: typeof window.coworkApi.updates?.installCapability,
          onSessionPatch: typeof window.coworkApi.on?.sessionPatch,
        }
        const [settings, installCapability] = await Promise.all([
          window.coworkApi.settings.get(),
          window.coworkApi.updates.installCapability(),
        ])
        const initialSessions = await window.coworkApi.session.list()
        const initialIds = initialSessions.map((candidate) => candidate.id)
        let sessions = initialSessions
        let createdSessionId: string | null = null
        if (probeAction === 'create-session') {
          const runtimeDeadline = Date.now() + 60_000
          while (Date.now() < runtimeDeadline) {
            const status = await window.coworkApi.runtime.status().catch(() => null)
            if (status?.ready) break
            await new Promise((done) => setTimeout(done, 250))
          }
          await window.coworkApi.session.create(null)
          const sessionDeadline = Date.now() + 15_000
          while (Date.now() < sessionDeadline) {
            sessions = await window.coworkApi.session.list()
            createdSessionId = sessions.find((candidate) => !initialIds.includes(candidate.id))?.id || null
            if (createdSessionId) break
            await new Promise((done) => setTimeout(done, 250))
          }
        } else if (probeAction === 'list-sessions') {
          sessions = await window.coworkApi.session.list()
        }
        return {
          surface,
          settings: {
            effectiveProviderId: settings.effectiveProviderId,
            effectiveModel: settings.effectiveModel,
          },
          installCapability: {
            supported: installCapability.supported,
            reason: installCapability.reason,
            currentVersion: installCapability.currentVersion,
          },
          sessions: sessions.map((candidate) => ({ id: candidate.id })),
          createdSessionId,
        }
      }, action),
      options?.timeoutMs ?? 90_000,
    )
  } finally {
    if (session) await session.close()
  }
}

async function closeCdpSmokeApp(browser: Browser, port: number) {
  try {
    const cdpSession = await browser.newBrowserCDPSession()
    await withSmokeTimeout('closing packaged app over CDP', cdpSession.send('Browser.close'), 2_000)
  } catch {
    // Fall through to the normal Playwright close/disconnect path.
  }

  try {
    await withSmokeTimeout('closing packaged browser connection', browser.close(), 5_000)
  } catch {
    // The process may already be gone after Browser.close reaches CDP.
  }

  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (!(await isCdpAvailable(port))) {
      await delay(1_000)
      return
    }
    await delay(250)
  }

  await runCommand('osascript', ['-e', 'tell application id "com.opencowork.desktop" to quit']).catch(() => {})
  await delay(1_000)
}

async function stopSpawnedSmokeProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exitedAfterTerm = await Promise.race([
    new Promise<boolean>((resolveExit) => child.once('exit', () => resolveExit(true))),
    delay(5_000).then(() => false),
  ])
  if (!exitedAfterTerm && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
      delay(5_000),
    ])
  }
}

async function closeSpawnedCdpSmokeApp(browser: Browser, child: ChildProcess, port: number) {
  try {
    const cdpSession = await browser.newBrowserCDPSession()
    await withSmokeTimeout('closing spawned packaged app over CDP', cdpSession.send('Browser.close'), 2_000)
  } catch {
    // Fall through to direct process cleanup below.
  }

  try {
    await withSmokeTimeout('closing spawned packaged browser connection', browser.close(), 5_000)
  } catch {
    // The browser may already be gone after Browser.close reaches CDP.
  }

  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (!(await isCdpAvailable(port))) {
      await delay(1_000)
      return
    }
    await delay(250)
  }

  await stopSpawnedSmokeProcess(child)
  await delay(1_000)
}

async function closeSmokeApp(app: ElectronApplication) {
  const processHandle = app.process()
  let closed = false

  const closePromise = app.close().then(() => {
    closed = true
  }).catch(() => {
    // If Electron is already gone or wedged during shutdown, the
    // process fallback below gives the smoke harness a bounded exit.
  })

  await Promise.race([closePromise, delay(10_000)])

  if (!closed && processHandle && !processHandle.killed) {
    processHandle.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolveExit) => processHandle.once('exit', () => resolveExit())),
      delay(5_000),
    ])
  }

  if (!closed && processHandle && !processHandle.killed) {
    processHandle.kill('SIGKILL')
  }

  // Runtime reboot tests can leave the bundled opencode child exiting
  // slightly after Electron closes. Give the OS a moment to release
  // the temp tree before cleanup or relaunch.
  await delay(1_000)
}

async function bootstrapSmokeSettings(page: Page, appShellTimeoutMs = 30_000) {
  const setupComplete = await page.evaluate(async () => {
    const [config, settings] = await Promise.all([
      window.coworkApi.app.config(),
      window.coworkApi.settings.get(),
    ])
    if (!settings.effectiveProviderId || !settings.effectiveModel) return false
    const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId)
    if (!provider) return false
    const providerCredentials = await window.coworkApi.settings.getProviderCredentials(provider.id)
    return provider.credentials.every((credential) => {
      if (credential.required === false) return true
      const value = providerCredentials[credential.key]
      return typeof value === 'string' && value.trim().length > 0
    })
  })

  if (setupComplete) {
    await waitForAppShell(page, appShellTimeoutMs)
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
        openrouter: { apiKey: 'placeholder-key' },
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
  await waitForAppShell(page, appShellTimeoutMs)
}

export async function launchSmokeSession(
  paths: SmokePaths,
  options?: LaunchSmokeSessionOptions,
): Promise<SmokeSession> {
  const appShellTimeoutMs = options?.appShellTimeoutMs ?? 30_000
  const macAppBundlePath = options?.executablePath && process.platform === 'darwin'
    ? getMacAppBundlePath(options.executablePath)
    : null

  if (macAppBundlePath) {
    const port = await getAvailablePort()
    const launchEnvironment = getLaunchServicesEnvironment(paths, port)
    const envArgs = Object.entries(launchEnvironment).flatMap(([key, value]) => ['--env', `${key}=${value}`])
    const argvEnvArgs = buildE2EArgEnvironment(launchEnvironment)
    await runCommand('open', [
      '-n',
      '-g',
      '-j',
      ...envArgs,
      macAppBundlePath,
      '--args',
      ...argvEnvArgs,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
    ])

    let browser: Browser | null = null
    try {
      await waitForCdp(port)
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      await waitForCdpPage(browser)
      const page = await waitForCdpAppPage(browser)
      await bootstrapSmokeSettings(page, appShellTimeoutMs)

      return {
        page,
        async close() {
          if (browser) await closeCdpSmokeApp(browser, port)
        },
      }
    } catch (error) {
      if (browser) await closeCdpSmokeApp(browser, port)
      throw error
    }
  }

  if (options?.executablePath && process.platform === 'linux') {
    const port = await getAvailablePort()
    const childArgs = [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]
    const child = spawn(options.executablePath, childArgs, {
      cwd: desktopAppDir,
      env: {
        ...getSmokeEnvironment(paths),
        OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: String(port),
      },
      stdio: 'ignore',
    })
    let clearEarlyExit: () => void = () => undefined
    const earlyExit = new Promise<never>((_resolve, reject) => {
      const onError = (error: Error) => reject(error)
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`Packaged app exited before CDP was available: ${signal || code}`))
      }
      child.once('error', onError)
      child.once('exit', onExit)
      clearEarlyExit = () => {
        child.off('error', onError)
        child.off('exit', onExit)
      }
    })

    let browser: Browser | null = null
    try {
      await Promise.race([waitForCdp(port), earlyExit])
      clearEarlyExit()
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      await waitForCdpPage(browser)
      const page = await waitForCdpAppPage(browser)
      await bootstrapSmokeSettings(page, appShellTimeoutMs)

      return {
        page,
        async close() {
          if (browser) await closeSpawnedCdpSmokeApp(browser, child, port)
          else await stopSpawnedSmokeProcess(child)
        },
      }
    } catch (error) {
      clearEarlyExit()
      if (browser) await closeSpawnedCdpSmokeApp(browser, child, port)
      else await stopSpawnedSmokeProcess(child)
      throw error
    }
  }

  const launchArgs: string[] = []
  if (process.platform === 'linux') {
    // CI/sandboxed Linux environments (including some containerized dev
    // runners) can block Chromium's namespace sandbox setup, which causes
    // Electron to abort before smoke tests even boot the app shell.
    launchArgs.push('--no-sandbox', '--disable-setuid-sandbox')
  }
  if (!options?.executablePath) {
    launchArgs.push('.')
  }

  const app = await electron.launch({
    cwd: desktopAppDir,
    executablePath: options?.executablePath,
    args: launchArgs,
    env: getSmokeEnvironment(paths),
  })

  await app.firstWindow()
  // Wait for the preload to attach `coworkApi` — until that happens any
  // renderer-side test is racing app bootstrap. We also wait for the
  // settings bridge because the bootstrap path below depends on it.
  const page = await waitForElectronAppPage(app)

  await bootstrapSmokeSettings(page, appShellTimeoutMs)

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
  if (!session.app) {
    throw new Error('launchSmokeApp requires a direct Electron smoke session')
  }

  return {
    app: session.app,
    page: session.page,
    async cleanup() {
      await session.close()
      cleanupSmokePaths(paths)
    },
  }
}
