import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createDesktopSmokeEnvironment,
  desktopRendererProbeUrl,
} from './desktop-dev-smoke-core.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = join(repoRoot, 'apps', 'desktop')
const rendererSourceRoot = join(repoRoot, 'packages', 'app', 'src')
const electronMainEntry = join(desktopRoot, 'src', 'main', 'index.ts')
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'))
const vitePackageRoot = dirname(requireFromDesktop.resolve('vite/package.json'))
const viteCli = join(vitePackageRoot, 'bin', 'vite.js')
const playwrightEntry = requireFromDesktop.resolve('playwright-core')
const playwright = await import(pathToFileURL(playwrightEntry).href)
const chromium = playwright.chromium || playwright.default?.chromium
if (!chromium) throw new Error('playwright-core did not expose Chromium CDP support')

const SMOKE_TIMEOUT_MS = 45_000
const MAX_MODULES = 100
const MODULE_FETCH_CONCURRENCY = 12
const POLL_MS = 100
const fatalViteMessages = []
const electronStarts = []
const devtoolsPorts = []
let output = ''
let viteProcess
let activeBrowser
let tempRoot
let rendererProbeRoot
let originalMainTimes
let finalError
let cleanupPromise
let hardTimer

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function availablePorts(count) {
  const reservations = []
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer()
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', resolveListen)
      })
      reservations.push(server)
    }
    return reservations.map((server) => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Could not allocate a TCP port for the desktop development smoke')
      }
      return address.port
    })
  } finally {
    await Promise.all(reservations.map((server) => (
      new Promise((resolveClose) => server.close(() => resolveClose()))
    )))
  }
}

async function waitFor(label, read, deadline) {
  let lastError
  while (Date.now() < deadline) {
    if (viteProcess?.exitCode !== null || viteProcess?.signalCode !== null) {
      throw new Error(
        `desktop development process exited before ${label}: `
        + `${viteProcess?.signalCode || viteProcess?.exitCode}\n${output.slice(-4_000)}`,
      )
    }
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(POLL_MS)
  }
  throw new Error(
    `timed out waiting for ${label}`
    + `${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`,
  )
}

async function requireOk(baseUrl, pathname, expectedContentType) {
  const response = await fetch(new URL(pathname, baseUrl), {
    signal: AbortSignal.timeout(2_000),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}: ${body.slice(0, 500)}`)
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes(expectedContentType)) {
    throw new Error(`${pathname} returned ${contentType || 'no content type'} instead of ${expectedContentType}`)
  }
  return body
}

function staticModuleSpecifiers(source) {
  const specifiers = []
  const pattern = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g
  for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  return specifiers
}

async function loadModuleGraph(baseUrl, entryModules) {
  const pending = [...entryModules]
  const visited = new Set()
  while (pending.length > 0) {
    const batch = []
    while (pending.length > 0 && batch.length < MODULE_FETCH_CONCURRENCY) {
      const modulePath = pending.shift()
      if (visited.has(modulePath)) continue
      if (visited.size >= MAX_MODULES) break
      visited.add(modulePath)
      batch.push(modulePath)
    }
    if (batch.length === 0) break
    const sources = await Promise.all(
      batch.map(async (modulePath) => [modulePath, await requireOk(baseUrl, modulePath, 'javascript')]),
    )
    for (const [, source] of sources) {
      for (const specifier of staticModuleSpecifiers(source)) {
        if (specifier.startsWith('/')) pending.push(specifier)
      }
    }
  }
  for (const dependency of ['react', 'react-dom']) {
    if (![...visited].some((path) => path.includes(dependency))) {
      throw new Error(`renderer graph never resolved its ${dependency} runtime`)
    }
  }
  return visited
}

function recordOutput(chunk) {
  const message = chunk.toString()
  output = `${output}${message}`.slice(-40_000)
  for (const match of output.matchAll(/\[desktop-dev\] electron generation=(\d+) pid=(\d+)/g)) {
    const start = {
      generation: Number.parseInt(match[1], 10),
      pid: Number.parseInt(match[2], 10),
    }
    if (!electronStarts.some((entry) => entry.generation === start.generation)) {
      electronStarts.push(start)
    }
  }
  for (const match of output.matchAll(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//g)) {
    const port = Number.parseInt(match[1], 10)
    if (!devtoolsPorts.includes(port)) devtoolsPorts.push(port)
  }
  if (/failed to resolve dependency|failed to resolve import|pre-transform error|internal server error/i.test(message)) {
    fatalViteMessages.push(message.trim())
  }
}

async function connectToElectron(remoteDebuggingPort, deadline) {
  await waitFor('Electron CDP endpoint', async () => {
    const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    })
    return response.ok
  }, deadline)
  return chromium.connectOverCDP(`http://127.0.0.1:${remoteDebuggingPort}`)
}

async function waitForProductSurface(browser, deadline) {
  return waitFor('executed Home or setup renderer surface', async () => {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('devtools://')) continue
        const state = await page.evaluate(() => {
          const root = globalThis.document.querySelector('#root')
          const home = globalThis.document.querySelector('[data-testid="home-view"]')
          const setup = globalThis.document.querySelector('section[aria-label="Setup progress"]')
          return {
            bridgeReady: typeof globalThis.coworkApi?.app?.config === 'function',
            rendered: Boolean(root?.childElementCount),
            surface: home ? 'home' : setup ? 'setup' : null,
          }
        }).catch(() => null)
        if (state?.bridgeReady && state.rendered && state.surface) {
          return { page, surface: state.surface }
        }
      }
    }
    return null
  }, deadline)
}

function hmrProbeSource(revision) {
  return [
    'const target = globalThis',
    'target.__openCoworkDevSmokeHmrGeneration = (target.__openCoworkDevSmokeHmrGeneration || 0) + 1',
    `target.__openCoworkDevSmokeHmrRevision = ${JSON.stringify(revision)}`,
    'if (import.meta.hot) import.meta.hot.accept()',
    '',
  ].join('\n')
}

function signalPidTree(pid, signal, processGroup = false) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T']
    if (signal === 'SIGKILL') args.push('/F')
    spawnSync('taskkill', args, {
      stdio: 'ignore',
      timeout: 2_000,
    })
    return
  }
  try {
    process.kill(processGroup ? -pid : pid, signal)
  } catch {
    // The process tree may already have exited.
  }
}

async function stopProcess(child) {
  if (!child?.pid) return
  const running = child.exitCode === null && child.signalCode === null
  const exitPromise = running
    ? new Promise((resolveExit) => child.once('exit', () => resolveExit(true)))
    : Promise.resolve(true)
  signalPidTree(child.pid, 'SIGTERM', true)
  const stopped = await Promise.race([
    exitPromise,
    delay(3_000).then(() => false),
  ])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    signalPidTree(child.pid, 'SIGKILL', true)
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(2_000),
    ])
  }
}

async function closeElectron(browser) {
  if (!browser?.isConnected()) return
  try {
    const session = await browser.newBrowserCDPSession()
    await Promise.race([
      session.send('Browser.close'),
      delay(2_000),
    ])
  } catch {
    // Direct PID cleanup below remains authoritative.
  }
}

function cleanupSmokeResources() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    if (hardTimer) clearTimeout(hardTimer)
    await closeElectron(activeBrowser)
    await stopProcess(viteProcess)

    for (const { pid } of electronStarts) {
      if (processIsAlive(pid)) signalPidTree(pid, 'SIGTERM')
    }
    await delay(250)
    for (const { pid } of electronStarts) {
      if (processIsAlive(pid)) signalPidTree(pid, 'SIGKILL')
    }

    if (originalMainTimes) {
      utimesSync(electronMainEntry, originalMainTimes.atime, originalMainTimes.mtime)
      originalMainTimes = undefined
    }
    if (rendererProbeRoot) {
      rmSync(rendererProbeRoot, { recursive: true, force: true })
      rendererProbeRoot = undefined
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
      tempRoot = undefined
    }
  })()
  return cleanupPromise
}

const hardDeadline = Date.now() + SMOKE_TIMEOUT_MS
hardTimer = setTimeout(() => {
  finalError = new Error(`desktop development smoke exceeded ${SMOKE_TIMEOUT_MS}ms`)
  void cleanupSmokeResources()
}, SMOKE_TIMEOUT_MS)

const signalExitCodes = new Map([
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
const signalHandlers = new Map()
for (const [signal, exitCode] of signalExitCodes) {
  const handler = () => {
    finalError ||= new Error(`desktop development smoke interrupted by ${signal}`)
    void cleanupSmokeResources().finally(() => process.exit(exitCode))
  }
  signalHandlers.set(signal, handler)
  process.once(signal, handler)
}

try {
  tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-desktop-dev-smoke-'))
  rendererProbeRoot = mkdtempSync(join(rendererSourceRoot, 'dev-smoke-'))
  const probePath = join(rendererProbeRoot, 'hmr-probe.ts')
  const isolatedHome = join(tempRoot, 'home')
  const isolatedData = join(tempRoot, 'user-data')
  const isolatedConfig = join(tempRoot, 'xdg-config')
  const isolatedCache = join(tempRoot, 'xdg-cache')
  const isolatedSandbox = join(tempRoot, 'sandbox')
  for (const directory of [
    isolatedHome,
    isolatedData,
    isolatedConfig,
    isolatedCache,
    isolatedSandbox,
  ]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(probePath, hmrProbeSource('initial'))

  const [rendererPort, remoteDebuggingPort] = await availablePorts(2)
  const baseUrl = new URL(`http://127.0.0.1:${rendererPort}/`)
  viteProcess = spawn(process.execPath, [
    viteCli,
    '--host',
    '127.0.0.1',
    '--port',
    String(rendererPort),
    '--strictPort',
    '--clearScreen',
    'false',
  ], {
    cwd: desktopRoot,
    env: createDesktopSmokeEnvironment(process.env, {
      // macOS Keychain discovery is tied to the real login home. Pointing HOME
      // at an empty smoke directory can block Electron's safeStorage bootstrap
      // behind an OS authorization dialog. Product state remains isolated by
      // the explicit user-data/config/cache/sandbox roots below.
      XDG_CONFIG_HOME: isolatedConfig,
      XDG_CACHE_HOME: isolatedCache,
      OPEN_COWORK_CONFIG_PATH: join(repoRoot, 'open-cowork.config.json'),
      OPEN_COWORK_USER_DATA_DIR: isolatedData,
      OPEN_COWORK_SANDBOX_DIR: isolatedSandbox,
      OPEN_COWORK_E2E: '1',
      OPEN_COWORK_RUNTIME_COMPONENT_DEV_OVERRIDE_REASON: 'bounded desktop development smoke',
      OPEN_COWORK_DEV_SMOKE: '1',
      REMOTE_DEBUGGING_PORT: String(remoteDebuggingPort),
    }, {
      isolatedHome,
      platform: process.platform,
    }),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  viteProcess.stdout.on('data', recordOutput)
  viteProcess.stderr.on('data', recordOutput)

  await waitFor('Vite HTTP readiness', async () => {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  }, hardDeadline)
  const firstElectron = await waitFor(
    'initial Electron process generation',
    () => electronStarts.find((entry) => entry.generation === 1),
    hardDeadline,
  )
  const observedRemoteDebuggingPort = await waitFor(
    'Electron DevTools listening address',
    () => devtoolsPorts[0],
    hardDeadline,
  )
  if (observedRemoteDebuggingPort !== remoteDebuggingPort) {
    throw new Error(
      `Electron DevTools listened on ${observedRemoteDebuggingPort}; requested ${remoteDebuggingPort}`,
    )
  }

  const entries = [
    ['index.html', '/packages/app/src/index.tsx'],
    ['loading.html', '/packages/app/src/loading.ts'],
    ['chart-frame.html', '/packages/app/src/chart-frame.ts'],
  ]
  for (const [htmlPath, modulePath] of entries) {
    const html = await requireOk(baseUrl, htmlPath, 'text/html')
    if (!html.includes(modulePath)) {
      throw new Error(`${htmlPath} does not reference ${modulePath}`)
    }
  }
  activeBrowser = await connectToElectron(observedRemoteDebuggingPort, hardDeadline)
  let { page, surface } = await waitForProductSurface(activeBrowser, hardDeadline)

  const probeUrl = desktopRendererProbeUrl(repoRoot, probePath)
  await page.evaluate(async (url) => import(url), probeUrl)
  const initialHmrGeneration = await page.evaluate(
    () => globalThis.__openCoworkDevSmokeHmrGeneration,
  )
  if (initialHmrGeneration !== 1) {
    throw new Error(`renderer HMR probe initialized at unexpected generation ${String(initialHmrGeneration)}`)
  }
  writeFileSync(probePath, hmrProbeSource('updated'))
  await page.waitForFunction(() => (
    globalThis.__openCoworkDevSmokeHmrGeneration >= 2
    && globalThis.__openCoworkDevSmokeHmrRevision === 'updated'
  ), undefined, { timeout: Math.max(1, hardDeadline - Date.now()) })
  const updatedHmrGeneration = await page.evaluate(
    () => globalThis.__openCoworkDevSmokeHmrGeneration,
  )

  originalMainTimes = statSync(electronMainEntry)
  const changedAt = new Date()
  utimesSync(electronMainEntry, changedAt, changedAt)
  const restartedElectron = await waitFor(
    'restarted Electron process generation',
    () => electronStarts.find((entry) => entry.generation >= 2 && entry.pid !== firstElectron.pid),
    hardDeadline,
  )

  activeBrowser = await connectToElectron(observedRemoteDebuggingPort, hardDeadline)
  ;({ page, surface } = await waitForProductSurface(activeBrowser, hardDeadline))
  const restartedRendererUrl = await page.evaluate(() => globalThis.location.href)
  const restartedRenderer = new URL(restartedRendererUrl)
  if (
    restartedRenderer.protocol !== 'http:'
    || restartedRenderer.port !== String(rendererPort)
    || !['127.0.0.1', 'localhost'].includes(restartedRenderer.hostname)
  ) {
    throw new Error(`restarted renderer loaded unexpected URL ${restartedRendererUrl}`)
  }
  if (fatalViteMessages.length > 0) {
    throw new Error(`Vite reported renderer resolution failures:\n${fatalViteMessages.join('\n')}`)
  }
  const visited = await loadModuleGraph(baseUrl, entries.map((entry) => entry[1]))

  process.stdout.write(
    `[desktop-dev-smoke] renderer executed (${surface}) at ${baseUrl.origin}; `
    + `HMR generation ${initialHmrGeneration}->${updatedHmrGeneration}; `
    + `Electron generation ${firstElectron.generation} pid=${firstElectron.pid}`
    + ` -> ${restartedElectron.generation} pid=${restartedElectron.pid}; `
    + `${visited.size} transformed modules\n`,
  )
} catch (error) {
  finalError = error
} finally {
  try {
    await cleanupSmokeResources()
  } catch (error) {
    finalError ||= error
  }
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler)
  }
}

const observedPids = [
  viteProcess?.pid,
  ...electronStarts.map((entry) => entry.pid),
].filter((pid) => Number.isSafeInteger(pid))
const leakedPids = [...new Set(observedPids)].filter(processIsAlive)
if (leakedPids.length > 0) {
  finalError = new Error(`desktop development smoke leaked process PIDs: ${leakedPids.join(', ')}`)
}
if (finalError) {
  process.stderr.write(
    `[desktop-dev-smoke] ${finalError instanceof Error ? finalError.message : String(finalError)}\n`
    + `${output.slice(-4_000)}\n`,
  )
  process.exitCode = 1
} else {
  process.stdout.write('[desktop-dev-smoke] teardown complete; no Electron process remains\n')
}
