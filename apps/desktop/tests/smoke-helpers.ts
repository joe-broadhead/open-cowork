import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  _electron as electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page,
} from 'playwright-core'
import {
  E2E_ARG_ENV_ENABLE_KEY,
  buildE2EArgEnvironment,
} from '@open-cowork/runtime-host/e2e-remote-debugging'

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
  paths: SmokePaths
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

type PackagedMacProbeFile = {
  ok: boolean
  result?: PackagedMacProbe
  error?: string
  writtenAt: string
}

export interface LaunchSmokeAppOptions {
  // Called with the isolated data root *before* Electron launches.
  // Use this to seed files like `sessions.json` under the path the
  // branded `dataDirName` would resolve to, so the loader picks them
  // up during app bootstrap.
  seedBeforeLaunch?: (paths: { tempRoot: string; dataRoot: string }) => void
  /** Preserve the public Open Cowork name while keeping ids and data isolated. */
  productBranding?: boolean
  /** Smoke defaults to Approvals-on for coverage; docs screenshots opt out. */
  enableApprovals?: boolean
  /** Secondary Knowledge is enabled only for smoke/eval journeys that cover it. */
  enableKnowledge?: boolean
  /** Keep production provider credential requirements for onboarding journeys. */
  preserveProviderCredentialRequirements?: boolean
}

export interface LaunchSmokeSessionOptions {
  executablePath?: string
  appShellTimeoutMs?: number
  /** Leave first-run settings untouched so onboarding/relaunch can be tested. */
  bootstrapSettings?: boolean
}

const SMOKE_BRAND_NAME = 'Open Cowork Smoke'
export const E2E_SETUP_VALIDATION_KEY = 'open-cowork-e2e-authoritative-key'
const DEFAULT_APP_SHELL_TIMEOUT_MS = 90_000
const SMOKE_RUNTIME_COMPONENT_DEV_OVERRIDE_REASON = 'desktop smoke test uses source checkout runtime components'

function smokeAppShellTimeoutMs() {
  const raw = process.env.OPEN_COWORK_DESKTOP_SMOKE_APP_SHELL_TIMEOUT_MS
  if (!raw) return DEFAULT_APP_SHELL_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_APP_SHELL_TIMEOUT_MS
}

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

export async function assertRuntimeComponentProvenance(page: Page) {
  const status = await page.evaluate(async () => window.coworkApi.runtime.status())
  const report = status.components
  if (!report) {
    throw new Error(`Runtime status did not include component verification: ${JSON.stringify(status)}`)
  }
  if (report.format !== 'open-cowork-runtime-component-manifest-v1') {
    throw new Error(`Runtime component verification used an unexpected format: ${JSON.stringify(report)}`)
  }
  if (!report.ok || report.issues.some((issue) => issue.severity === 'error')) {
    throw new Error(`Runtime component verification failed in smoke: ${JSON.stringify(report)}`)
  }
  if (!report.developmentOverride) {
    throw new Error(`Runtime smoke must use an explicit development component override: ${JSON.stringify(report)}`)
  }

  const ids = new Set(report.components.map((component) => component.id))
  for (const requiredId of ['opencode-cli', 'opencode-sdk', 'semantic-ui-mcp', 'workflow-mcp', 'agent-tool-mcp']) {
    if (!ids.has(requiredId)) {
      throw new Error(`Runtime component verification did not include ${requiredId}: ${JSON.stringify(report)}`)
    }
  }
}

function writeIsolatedConfig(tempRoot: string, options?: LaunchSmokeAppOptions) {
  // Borrow upstream's config but rebrand dataDirName so the test install
  // can't collide with a developer's real Open Cowork state on disk.
  const sourcePath = join(repoRoot, 'open-cowork.config.json')
  const config = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, any>
  config.branding = {
    ...(config.branding || {}),
    name: options?.productBranding ? (config.branding?.name || 'Open Cowork') : SMOKE_BRAND_NAME,
    appId: 'com.opencowork.desktop.smoke',
    dataDirName: 'open-cowork-smoke',
  }
  const openRouterCredentials = config.providers?.descriptors?.openrouter?.credentials
  if (Array.isArray(openRouterCredentials) && !options?.preserveProviderCredentialRequirements) {
    // Smoke runs are about shell/session health, not validating provider
    // credential persistence on first boot. Make the default provider
    // credential optional in the isolated smoke config so packaged tests
    // can boot without mutating persisted secrets at runtime.
    config.providers.descriptors.openrouter.credentials = openRouterCredentials.map((credential: Record<string, unknown>) => ({
      ...credential,
      required: false,
    }))
  }
  // Secondary Studio surfaces are default-off in product config. Smoke/eval
  // journeys exercise Approvals offline (synthetic permission requests), so
  // enable that feature in the isolated harness config only.
  config.features = {
    ...(config.features && typeof config.features === 'object' ? config.features : {}),
  }
  if (options?.enableApprovals === false) delete config.features.approvals
  else config.features.approvals = true
  if (options?.enableKnowledge) config.features.knowledge = true
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

  const configPath = writeIsolatedConfig(tempRoot, options)

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
    TMPDIR: process.env.TMPDIR || tmpdir(),
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_DATA_HOME: paths.xdgDataHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    OPEN_COWORK_CONFIG_PATH: paths.configPath,
    OPEN_COWORK_USER_DATA_DIR: paths.dataRoot,
    OPEN_COWORK_SANDBOX_DIR: paths.sandboxDir,
    OPEN_COWORK_CHART_TIMEOUT_MS: '1500',
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_SETUP_VALIDATION_KEY: E2E_SETUP_VALIDATION_KEY,
    OPEN_COWORK_RUNTIME_COMPONENT_DEV_OVERRIDE_REASON: SMOKE_RUNTIME_COMPONENT_DEV_OVERRIDE_REASON,
  }
}

function getMacAppBundlePath(executablePath: string) {
  const bundleMarker = '.app/Contents/MacOS/'
  const markerIndex = executablePath.indexOf(bundleMarker)
  if (markerIndex < 0) return null
  return executablePath.slice(0, markerIndex + '.app'.length)
}

function getLaunchServicesEnvironment(paths: SmokePaths, overrides?: Record<string, string>) {
  const env = {
    ...getSmokeEnvironment(paths),
    ...overrides,
    [E2E_ARG_ENV_ENABLE_KEY]: '1',
  }
  const keys = new Set([
    E2E_ARG_ENV_ENABLE_KEY,
    'HOME',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'OPEN_COWORK_CONFIG_PATH',
    'OPEN_COWORK_USER_DATA_DIR',
    'OPEN_COWORK_SANDBOX_DIR',
    'OPEN_COWORK_CHART_TIMEOUT_MS',
    'OPEN_COWORK_E2E_ALLOW_SETTINGS_MUTATION',
    'OPEN_COWORK_E2E',
    'OPEN_COWORK_E2E_PROBE_ACTION',
    'OPEN_COWORK_E2E_READY_FILE',
    'OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT',
  ])

  return Object.fromEntries(
    Array.from(keys)
      .map((key) => [key, env[key]] as const)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function getMacE2EArgEnvironment(paths: SmokePaths, overrides?: Record<string, string>) {
  return buildE2EArgEnvironment(getLaunchServicesEnvironment(paths, overrides))
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

async function getCdpAppPageDiagnostics(browser: Browser) {
  const diagnostics = []
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.url().startsWith('devtools://')) continue
      diagnostics.push(await getAppShellDiagnostics(page))
    }
  }
  return diagnostics
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
  const diagnostics = await getCdpAppPageDiagnostics(browser)
  throw new Error(`Timed out waiting for packaged app renderer page\nDiagnostics: ${JSON.stringify(diagnostics)}`)
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
  const diagnostics = await getCdpAppPageDiagnostics(browser)
  throw new Error(`Timed out waiting for packaged app shell page\nDiagnostics: ${JSON.stringify(diagnostics)}`)
}

async function waitForPackagedProbeFile(
  targetPath: string,
  timeoutMs = 90_000,
  signal?: AbortSignal,
): Promise<PackagedMacProbe> {
  const deadline = Date.now() + timeoutMs
  let lastReadError: string | null = null
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as PackagedMacProbeFile
      if (!parsed.ok) {
        throw new Error(parsed.error || 'packaged macOS probe failed')
      }
      if (parsed.result) return parsed.result
      lastReadError = 'probe file did not include a result payload'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        lastReadError = error instanceof Error ? error.message : String(error)
      }
    }
    await delay(250)
  }
  if (signal?.aborted) return new Promise<never>(() => {})
  throw new Error(`Timed out waiting for packaged probe file ${targetPath}${lastReadError ? `; last error: ${lastReadError}` : ''}`)
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

function restoreLaunchServicesEnvironmentSync(previousValues: Map<string, string | null>) {
  for (const [key, previousValue] of Array.from(previousValues.entries()).reverse()) {
    const restore = previousValue === null
      ? ['unsetenv', key]
      : ['setenv', key, previousValue]
    spawnSync('launchctl', restore, {
      stdio: 'ignore',
      timeout: 2_000,
    })
  }
}

export async function withLaunchServicesEnvironment<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previousValues = new Map<string, string | null>()
  let restored = false
  const restoreOnExit = () => {
    if (restored) return
    restored = true
    restoreLaunchServicesEnvironmentSync(previousValues)
  }
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      restoreOnExit()
      process.removeListener(signal, handler)
      process.kill(process.pid, signal)
    }
    signalHandlers.set(signal, handler)
    process.once(signal, handler)
  }
  process.once('exit', restoreOnExit)

  try {
    for (const [key, value] of Object.entries(env)) {
      previousValues.set(key, readLaunchServicesEnvironment(key))
      await runCommand('launchctl', ['setenv', key, value])
    }
    return await fn()
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler)
    }
    process.removeListener('exit', restoreOnExit)
    if (!restored) {
      restored = true
      for (const [key, previousValue] of Array.from(previousValues.entries()).reverse()) {
        const restore = previousValue === null
          ? ['unsetenv', key]
          : ['setenv', key, previousValue]
        await runCommand('launchctl', restore)
      }
    }
  }
}

function readLaunchServicesEnvironment(key: string) {
  const result = spawnSync('launchctl', ['getenv', key], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  if (result.status !== 0) return null
  const value = result.stdout.replace(/[\r\n]+$/, '')
  return value || null
}

async function openMacCandidate(
  macAppBundlePath: string,
  executablePath: string,
  argEnvironment: string[],
  port: number,
) {
  return withLaunchServicesEnvironment({ [E2E_ARG_ENV_ENABLE_KEY]: '1' }, async () => {
    await runCommand('open', [
      '-n',
      '-g',
      '-j',
      macAppBundlePath,
      '--args',
      // Prevent an unsigned, isolated first launch from blocking Electron's
      // main thread on a macOS Keychain authorization dialog that the hidden
      // smoke candidate cannot answer. This is Chromium's test-only keychain;
      // production launches never receive the switch.
      '--use-mock-keychain',
      ...argEnvironment,
      `--remote-debugging-port=${port}`,
    ])
    return waitForMacCandidateProcess(executablePath, port)
  })
}

async function waitForElectronAppPage(app: ElectronApplication, timeoutMs = DEFAULT_APP_SHELL_TIMEOUT_MS) {
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
  const macAppBundlePath = getMacAppBundlePath(executablePath)
  if (!macAppBundlePath) {
    throw new Error(`Packaged macOS executable is not inside an app bundle: ${executablePath}`)
  }
  const port = await getAvailablePort()
  const action = options?.action || 'surface'
  const readyFile = join(paths.tempRoot, `packaged-mac-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  const probeEnvironment = getLaunchServicesEnvironment(paths, {
    OPEN_COWORK_E2E_ALLOW_SETTINGS_MUTATION: '1',
    OPEN_COWORK_E2E_PROBE_ACTION: action,
    OPEN_COWORK_E2E_READY_FILE: readyFile,
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: String(port),
  })
  const argEnvironment = buildE2EArgEnvironment(probeEnvironment)
  let processId: number | null = null

  try {
    await quiesceMacCandidateBundle(executablePath)
    processId = await openMacCandidate(macAppBundlePath, executablePath, argEnvironment, port)
    return await waitForProbeOrProcessExit(readyFile, options?.timeoutMs ?? 90_000, processId)
  } catch (error) {
    const candidateAlive = processId === null ? false : processIsAlive(processId)
    const listenerProcessId = findProcessListeningOnPort(port)
    const renderer = processId !== null && listenerProcessId === processId
      ? await getOwnedCdpDiagnostics(port)
      : null
    const diagnostics = {
      action,
      arch: process.arch,
      candidateAlive,
      candidateObserved: processId !== null,
      cdpOwnedByCandidate: processId !== null && listenerProcessId === processId,
      bundle: relative(repoRoot, macAppBundlePath),
      candidateArchitecture: readMacExecutableArchitectures(executablePath),
      candidateVersion: readMacBundleVersion(macAppBundlePath),
      executable: relative(repoRoot, executablePath),
      label: 'mac',
      platform: process.platform,
      readyFileCreated: existsSync(readyFile),
      renderer,
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Packaged mac probe failed: ${message}\nDiagnostics: ${JSON.stringify(diagnostics)}`, { cause: error })
  } finally {
    processId ??= findMacCandidateProcess(executablePath, port)
    if (processId !== null && findProcessListeningOnPort(port) === processId) {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null)
      if (browser) {
        await closeCdpSmokeApp(browser, port, processId, executablePath)
      } else {
        await stopExactProcess(processId, () => findMacCandidateProcess(executablePath, port) === processId)
      }
    } else if (processId !== null) {
      await stopExactProcess(processId, () => findMacCandidateProcess(executablePath, port) === processId)
    }
  }
}

async function quiesceMacCandidateBundle(executablePath: string) {
  for (const processId of findMacCandidateProcesses(executablePath)) {
    await stopExactProcess(
      processId,
      () => findMacCandidateProcesses(executablePath).includes(processId),
    )
  }
  if (findMacCandidateProcesses(executablePath).length > 0) {
    throw new Error('The exact packaged macOS candidate did not quiesce before launch')
  }
}

function readMacExecutableArchitectures(executablePath: string) {
  const result = spawnSync('/usr/bin/lipo', ['-archs', executablePath], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  if (result.status !== 0) return 'unknown'
  const architectures = result.stdout.trim().split(/\s+/).filter(Boolean)
  return architectures.length > 0 ? architectures.join(',') : 'unknown'
}

function readMacBundleVersion(macAppBundlePath: string) {
  const result = spawnSync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleShortVersionString',
    join(macAppBundlePath, 'Contents', 'Info.plist'),
  ], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'unknown'
}

async function getOwnedCdpDiagnostics(port: number) {
  const http = await readCdpHttpDiagnostics(port)
  const browser = await withSmokeTimeout(
    'connecting to packaged app for diagnostics',
    chromium.connectOverCDP(`http://127.0.0.1:${port}`),
    5_000,
  ).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  } as const))
  if (!('contexts' in browser)) return { http, playwright: browser }
  try {
    const playwright = await withSmokeTimeout(
      'reading packaged app diagnostics',
      getCdpAppPageDiagnostics(browser),
      5_000,
    )
    return { http, playwright }
  } catch (error) {
    return {
      http,
      playwright: { error: error instanceof Error ? error.message : String(error) },
    }
  } finally {
    await withSmokeTimeout('closing packaged diagnostic connection', browser.close(), 2_000).catch(() => undefined)
  }
}

async function readCdpHttpDiagnostics(port: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal,
    })
    const targets = await response.json() as Array<Record<string, unknown>>
    return targets.map((target) => ({
      description: typeof target.description === 'string' ? target.description : null,
      title: typeof target.title === 'string' ? target.title : null,
      type: typeof target.type === 'string' ? target.type : null,
      url: typeof target.url === 'string' ? target.url : null,
    }))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

// Shared spawn-based packaged probe used on Linux and Windows. Launching the
// exact candidate executable gives the harness a process handle for bounded
// cleanup and actionable early-exit diagnostics.
async function launchPackagedSpawnProbe(
  paths: SmokePaths,
  executablePath: string,
  options: {
    label: string
    sandbox: boolean
    action?: 'surface' | 'create-session' | 'list-sessions'
    timeoutMs?: number
  },
): Promise<PackagedMacProbe> {
  const port = await getAvailablePort()
  const action = options.action || 'surface'
  const readyFile = join(paths.tempRoot, `packaged-${options.label}-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  const probeEnvironment = getLaunchServicesEnvironment(paths, {
    OPEN_COWORK_E2E_ALLOW_SETTINGS_MUTATION: '1',
    OPEN_COWORK_E2E_PROBE_ACTION: action,
    OPEN_COWORK_E2E_READY_FILE: readyFile,
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: String(port),
  })
  const childArgs = [
    // Chromium sandbox flags are a Linux-CI concern only.
    ...(options.sandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    ...buildE2EArgEnvironment(probeEnvironment),
  ]
  const child = spawn(executablePath, childArgs, {
    cwd: desktopAppDir,
    env: {
      ...getSmokeEnvironment(paths),
      ...probeEnvironment,
    },
    stdio: 'ignore',
  })
  let clearEarlyExit: () => void = () => undefined
  const earlyExit = new Promise<never>((_resolve, reject) => {
    const onError = (error: Error) => reject(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new Error(`Packaged ${options.label} probe app exited before writing ready file: ${signal || code}`))
    }
    child.once('error', onError)
    child.once('exit', onExit)
    clearEarlyExit = () => {
      child.off('error', onError)
      child.off('exit', onExit)
    }
  })

  try {
    return await Promise.race([
      waitForPackagedProbeFile(readyFile, options.timeoutMs ?? 90_000),
      earlyExit,
    ])
  } catch (error) {
    const diagnostics = {
      action,
      arch: process.arch,
      executable: relative(repoRoot, executablePath),
      exitCode: child.exitCode,
      label: options.label,
      pid: child.pid ?? null,
      platform: process.platform,
      readyFileCreated: existsSync(readyFile),
      signalCode: child.signalCode,
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Packaged ${options.label} probe failed: ${message}\nDiagnostics: ${JSON.stringify(diagnostics)}`, { cause: error })
  } finally {
    clearEarlyExit()
    await stopSpawnedSmokeProcess(child)
    await delay(1_000)
  }
}

export async function launchPackagedLinuxProbe(
  paths: SmokePaths,
  executablePath: string,
  options?: { action?: 'surface' | 'create-session' | 'list-sessions'; timeoutMs?: number },
): Promise<PackagedMacProbe> {
  if (process.platform !== 'linux') {
    throw new Error('launchPackagedLinuxProbe is only supported on Linux')
  }
  return launchPackagedSpawnProbe(paths, executablePath, { ...options, label: 'linux', sandbox: true })
}

export async function launchPackagedWindowsProbe(
  paths: SmokePaths,
  executablePath: string,
  options?: { action?: 'surface' | 'create-session' | 'list-sessions'; timeoutMs?: number },
): Promise<PackagedMacProbe> {
  if (process.platform !== 'win32') {
    throw new Error('launchPackagedWindowsProbe is only supported on Windows')
  }
  return launchPackagedSpawnProbe(paths, executablePath, { ...options, label: 'windows', sandbox: false })
}

async function closeCdpSmokeApp(
  browser: Browser,
  port: number,
  processId: number,
  executablePath: string,
) {
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

  const identityIsCurrent = () => findMacCandidateProcess(executablePath, port) === processId
  if (await waitForExactProcessExit(processId, identityIsCurrent, 2_000)) return
  await stopExactProcess(processId, identityIsCurrent)
}

function findProcessListeningOnPort(port: number) {
  if (process.platform !== 'darwin') return null
  const result = spawnSync('/usr/sbin/lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-t',
  ], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  if (result.status !== 0) return null
  const processId = Number.parseInt(result.stdout.trim().split(/\s+/)[0] || '', 10)
  return Number.isSafeInteger(processId) && processId > 1 ? processId : null
}

function findMacCandidateProcess(executablePath: string, port: number) {
  const portArgument = `--remote-debugging-port=${port}`
  return findMacCandidateProcesses(executablePath).find((processId) => {
    const command = readMacProcessCommand(processId)
    return command?.includes(portArgument)
  }) ?? null
}

function findMacCandidateProcesses(executablePath: string) {
  if (process.platform !== 'darwin') return []
  const executablePaths = new Set([executablePath])
  try {
    executablePaths.add(realpathSync(executablePath))
  } catch {
    // The caller reports the missing/unreadable executable separately.
  }
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 2_000,
  })
  if (result.status !== 0) return []
  const processIds: number[] = []
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    if (![...executablePaths].some((candidatePath) => (
      match[2] === candidatePath || match[2].startsWith(`${candidatePath} `)
    ))) continue
    const processId = Number.parseInt(match[1], 10)
    if (Number.isSafeInteger(processId) && processId > 1) processIds.push(processId)
  }
  return processIds
}

function readMacProcessCommand(processId: number) {
  const result = spawnSync('/bin/ps', ['-p', String(processId), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function processIsAlive(processId: number) {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForExactProcessExit(
  processId: number,
  identityIsCurrent: () => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(processId) || !identityIsCurrent()) return true
    await delay(100)
  }
  return !processIsAlive(processId) || !identityIsCurrent()
}

async function stopExactProcess(processId: number, identityIsCurrent: () => boolean) {
  if (!processIsAlive(processId)) return
  if (!identityIsCurrent()) {
    throw new Error(`Packaged macOS smoke process ${processId} no longer matches the launched candidate`)
  }
  process.kill(processId, 'SIGTERM')
  for (let attempts = 0; attempts < 8; attempts += 1) {
    if (!processIsAlive(processId)) return
    if (!identityIsCurrent()) return
    await delay(250)
  }
  if (!identityIsCurrent()) return
  process.kill(processId, 'SIGKILL')
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (!processIsAlive(processId)) return
    if (!identityIsCurrent()) return
    await delay(250)
  }
  throw new Error(`Packaged macOS smoke process ${processId} did not exit after SIGKILL`)
}

async function waitForMacCandidateProcess(executablePath: string, port: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const processId = findMacCandidateProcess(executablePath, port)
    if (processId !== null) return processId
    await delay(100)
  }
  throw new Error('The exact packaged macOS candidate process was not observed after launch')
}

async function waitForOwnedCdp(port: number, processId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(processId)) {
      throw new Error('The exact packaged macOS candidate exited before CDP became available')
    }
    const listenerProcessId = findProcessListeningOnPort(port)
    if (listenerProcessId !== null && listenerProcessId !== processId) {
      throw new Error('The packaged macOS CDP port is owned by an unexpected process')
    }
    if (listenerProcessId === processId && await isCdpAvailable(port)) return
    await delay(100)
  }
  throw new Error(`Timed out waiting for the exact packaged macOS candidate CDP endpoint on 127.0.0.1:${port}`)
}

async function waitForProbeOrProcessExit(targetPath: string, timeoutMs: number, processId: number) {
  const controller = new AbortController()
  const monitor = async (): Promise<never> => {
    while (!controller.signal.aborted && processIsAlive(processId)) await delay(100)
    if (controller.signal.aborted) return new Promise<never>(() => {})
    throw new Error('The exact packaged macOS candidate exited before writing the ready file')
  }
  try {
    return await Promise.race([
      waitForPackagedProbeFile(targetPath, timeoutMs, controller.signal),
      monitor(),
    ])
  } finally {
    controller.abort()
  }
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

async function bootstrapSmokeSettings(page: Page, appShellTimeoutMs = DEFAULT_APP_SHELL_TIMEOUT_MS) {
  const setupComplete = await page.evaluate(async () => (
    await window.coworkApi.settings.get()
  ).setupComplete)

  if (setupComplete) {
    await waitForAppShell(page, appShellTimeoutMs)
    return
  }

  // The main process owns this E2E fixture secret and accepts only an exact
  // match. That proves the full save → runtime → validation → durable-proof
  // path without contacting an external model provider.
  await page.evaluate(async (fixtureKey) => {
    await window.coworkApi.settings.set({
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      providerCredentials: {
        openrouter: { apiKey: fixtureKey },
      },
    })
    const runtime = await window.coworkApi.runtime.restart({ purpose: 'setup_connection_validation' })
    if (!runtime.ready) throw new Error(runtime.error || 'Smoke runtime failed to start for setup validation.')
    await window.coworkApi.provider.testConnection('openrouter', 'anthropic/claude-sonnet-4')
  }, E2E_SETUP_VALIDATION_KEY)

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
  const appShellTimeoutMs = options?.appShellTimeoutMs ?? smokeAppShellTimeoutMs()
  const packagedExecutablePath = options?.executablePath
  const macAppBundlePath = packagedExecutablePath && process.platform === 'darwin'
    ? getMacAppBundlePath(packagedExecutablePath)
    : null

  if (macAppBundlePath && packagedExecutablePath) {
    const port = await getAvailablePort()
    const e2eArgEnvironment = getMacE2EArgEnvironment(paths, {
      OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: String(port),
    })
    const processId = await openMacCandidate(macAppBundlePath, packagedExecutablePath, e2eArgEnvironment, port)

    let browser: Browser | null = null
    try {
      await waitForOwnedCdp(port, processId, appShellTimeoutMs)
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      await waitForCdpPage(browser, appShellTimeoutMs)
      const page = await waitForCdpAppPage(browser, appShellTimeoutMs)
      if (options?.bootstrapSettings !== false) {
        await bootstrapSmokeSettings(page, appShellTimeoutMs)
      }

      return {
        page,
        async close() {
          if (browser) await closeCdpSmokeApp(browser, port, processId, packagedExecutablePath)
        },
      }
    } catch (error) {
      if (browser) {
        await closeCdpSmokeApp(browser, port, processId, packagedExecutablePath)
      } else {
        await stopExactProcess(processId, () => findMacCandidateProcess(packagedExecutablePath, port) === processId)
      }
      throw error
    }
  }

  if (options?.executablePath && (process.platform === 'linux' || process.platform === 'win32')) {
    // Packaged apps can't be driven by Playwright's electron.launch() (it drives
    // an `electron .` dev process), so on Linux and Windows we spawn the packaged
    // binary directly with an explicit remote-debugging port and attach over CDP.
    // The Chromium sandbox flags are a Linux-CI concern only.
    const port = await getAvailablePort()
    const childArgs = [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
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
      await Promise.race([waitForCdp(port, appShellTimeoutMs), earlyExit])
      clearEarlyExit()
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      await waitForCdpPage(browser, appShellTimeoutMs)
      const page = await waitForCdpAppPage(browser, appShellTimeoutMs)
      if (options?.bootstrapSettings !== false) {
        await bootstrapSmokeSettings(page, appShellTimeoutMs)
      }

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
  const page = await waitForElectronAppPage(app, appShellTimeoutMs)

  if (options?.bootstrapSettings !== false) {
    await bootstrapSmokeSettings(page, appShellTimeoutMs)
  }

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
    paths,
    async cleanup() {
      await session.close()
      cleanupSmokePaths(paths)
    },
  }
}
