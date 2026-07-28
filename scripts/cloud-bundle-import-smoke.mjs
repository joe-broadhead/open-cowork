#!/usr/bin/env node
// Production-closure smoke for the Cloud bundle.
//
// The bundle keeps explicit production packages external. This smoke proves
// those packages resolve from the selected runtime root (never an ancestor
// checkout), boots the real Cloud application, crosses the OpenCode provider
// adapter against a deterministic loopback model endpoint, and invokes a real
// bundled MCP tool over stdio JSON-RPC.
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertRuntimeExternalResolutionsContained,
  buildSmokeProviderOverride,
  invokeStdioMcpTool,
} from './cloud-bundle-smoke-core.mjs'
import { resolveEffectiveCloudRuntimeConfig } from './cloud-runtime-prune-core.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeRootIndex = process.argv.indexOf('--runtime-root')
if (runtimeRootIndex >= 0 && !process.argv[runtimeRootIndex + 1]) {
  process.stderr.write('[cloud-smoke] --runtime-root requires a directory.\n')
  process.exit(2)
}
const explicitRuntimeRoot = runtimeRootIndex >= 0
const runtimeRoot = resolve(
  explicitRuntimeRoot ? process.argv[runtimeRootIndex + 1] : repoRoot,
)
const bundle = resolve(runtimeRoot, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs')
const chartsMcp = resolve(runtimeRoot, 'mcps/charts/dist/index.js')
const closureManifestPath = resolve(runtimeRoot, 'cloud-runtime-manifest.json')
const buildMetadataPath = resolve(
  runtimeRoot,
  'apps/desktop/dist/cloud/cloud-runtime-workspaces.json',
)
const READY_PATTERN = /open-cowork-cloud role=\S+ profile=\S+ (https?:\/\/\S+)/
const BOOT_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 10_000
const SHUTDOWN_GRACE_MS = 5_000
const SMOKE_PROVIDER_KEY = ['cloud', 'smoke', 'provider', 'credential'].join(':')
const SMOKE_ENVELOPE_KEY = 'cloud-smoke-envelope-key-not-for-production'

function requireFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}`)
  }
}

function readRuntimePackageClosure() {
  const metadataPath = existsSync(closureManifestPath)
    ? closureManifestPath
    : buildMetadataPath
  if (explicitRuntimeRoot && metadataPath !== closureManifestPath) {
    throw new Error(
      `isolated runtime manifest not found at ${closureManifestPath}; prune and install the production tree first`,
    )
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  if (!Array.isArray(metadata.externalPackages)) {
    throw new Error(`${metadataPath} does not declare externalPackages`)
  }
  if (!Array.isArray(metadata.runtimePackages)) {
    throw new Error(`${metadataPath} does not declare runtimePackages`)
  }
  return {
    externalPackages: metadata.externalPackages,
    runtimePackages: metadata.runtimePackages,
  }
}

function allowlistedChildEnvironment(input) {
  const env = {}
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ]) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return {
    ...env,
    HOME: input.root,
    TMPDIR: input.root,
    TMP: input.root,
    TEMP: input.root,
    XDG_CONFIG_HOME: join(input.root, 'xdg', 'config'),
    XDG_DATA_HOME: join(input.root, 'xdg', 'data'),
    XDG_CACHE_HOME: join(input.root, 'xdg', 'cache'),
    XDG_STATE_HOME: join(input.root, 'xdg', 'state'),
    OPEN_COWORK_CLOUD_ROOT: input.root,
    OPEN_COWORK_DATA_DIR: input.data,
    OPEN_COWORK_DOWNSTREAM_ROOT: runtimeRoot,
    // Keep the explicit smoke override as the final config-directory layer.
    // OPEN_COWORK_DOWNSTREAM_ROOT still points at the pruned assets, but must
    // not cause its baseline config to overwrite the deterministic model.
    OPEN_COWORK_CONFIG_DIR: input.root,
    OPEN_COWORK_CONFIG_PATH: input.providerConfigPath,
    OPEN_COWORK_CLOUD_SECRET_KEY: SMOKE_ENVELOPE_KEY,
    OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: 'true',
    OPEN_COWORK_CLOUD_HOST: '127.0.0.1',
    OPEN_COWORK_CLOUD_PORT: '0',
    OPEN_COWORK_CLOUD_PROFILE: 'cloud-smoke',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  }
}

async function assertSmokeConfigLoaded(input) {
  const childEnvironment = allowlistedChildEnvironment(input)
  const names = Object.keys(childEnvironment)
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  const previousCwd = process.cwd()
  for (const [name, value] of Object.entries(childEnvironment)) {
    process.env[name] = value
  }
  process.chdir(runtimeRoot)
  try {
    const configModuleUrl = pathToFileURL(
      resolve(runtimeRoot, 'packages/runtime-host/dist/config.js'),
    ).href
    const configModule = await import(`${configModuleUrl}?cloud-smoke=${Date.now()}`)
    const effectiveConfig = resolveEffectiveCloudRuntimeConfig(configModule.getAppConfig())
    const error = configModule.getConfigError()
    if (error) {
      throw new Error(`Cloud smoke config was rejected: ${error}`)
    }
    if (!effectiveConfig.cloud.profiles['cloud-smoke']?.agents?.includes('build')) {
      throw new Error('Cloud smoke config did not enable the build agent')
    }
    const unsupportedBareMcp = effectiveConfig.mcps.find((mcp) => (
      mcp.type === 'local'
      && Array.isArray(mcp.command)
      && !mcp.packageName
    ))
    if (unsupportedBareMcp) {
      throw new Error(
        `Cloud smoke config advertises unsupported bare local MCP ${unsupportedBareMcp.name}`,
      )
    }
    const configuredBaseURL = effectiveConfig.providers.descriptors.openrouter?.options?.baseURL
    if (configuredBaseURL !== input.providerBaseURL) {
      throw new Error('Cloud smoke config did not preserve the loopback provider adapter URL')
    }
    if (effectiveConfig.providers.defaultModel !== 'cloud-smoke-model') {
      throw new Error('Cloud smoke config did not preserve the deterministic default model')
    }
  } finally {
    process.chdir(previousCwd)
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function cloudChildArgs() {
  return [
    '--experimental-sqlite',
    bundle,
    '--development-process',
  ]
}

function waitForCloudReady(child, output) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`bundle did not become ready within ${BOOT_TIMEOUT_MS}ms`))
    }, BOOT_TIMEOUT_MS)
    const onData = (chunk) => {
      output.value += chunk.toString()
      if (/ERR_MODULE_NOT_FOUND|Cannot find package|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(output.value)) {
        clearTimeout(timer)
        rejectReady(new Error('bundle hit a module-resolution error'))
        return
      }
      const ready = output.value.match(READY_PATTERN)
      if (!ready) return
      clearTimeout(timer)
      resolveReady(ready[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectReady(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      rejectReady(new Error(
        `bundle exited before readiness (code ${code}, signal ${signal})`,
      ))
    })
  })
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolveExit()
    }, SHUTDOWN_GRACE_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function requireJson(baseUrl, path, input = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: input.method || 'GET',
    headers: input.body ? { 'content-type': 'application/json' } : undefined,
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(input.timeoutMs || PROBE_TIMEOUT_MS),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${path} returned non-JSON content: ${text.slice(0, 240)}`)
  }
  const acceptedStatuses = input.statuses || [200]
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 240)}`)
  }
  if (input.validate && !input.validate(body)) {
    throw new Error(`${path} returned an invalid smoke contract`)
  }
  return body
}

async function waitFor(check, label) {
  const deadline = Date.now() + PROBE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`${label} did not complete within ${PROBE_TIMEOUT_MS}ms`)
}

async function startModelProvider() {
  let requestEvidence = null
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requestEvidence = {
        method: request.method,
        url: request.url,
        model: body.model,
        authorization: request.headers.authorization === `Bearer ${SMOKE_PROVIDER_KEY}`,
      }
      if (
        request.method !== 'POST'
        || !request.url?.endsWith('/chat/completions')
        || body.model !== 'cloud-smoke-model'
      ) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Unexpected provider smoke request.' } }))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
      send({
        id: 'chatcmpl-cloud-closure-smoke',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'cloud-smoke-model',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: 'cloud-provider-smoke-ok',
          },
          finish_reason: null,
        }],
      })
      send({
        id: 'chatcmpl-cloud-closure-smoke',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'cloud-smoke-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
      response.end('data: [DONE]\n\n')
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Malformed provider smoke request.' } }))
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('provider smoke server did not bind a TCP port')
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    evidence: () => requestEvidence,
    resetEvidence: () => {
      requestEvidence = null
    },
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
    }),
  }
}

async function exerciseProviderBoundary(baseUrl, provider) {
  await requireJson(baseUrl, '/livez', {
    validate: (body) => body?.ok === true,
  })
  await requireJson(baseUrl, '/readyz', {
    statuses: [200, 503],
    validate: (body) => typeof body?.ok === 'boolean' && Array.isArray(body?.checks),
  })
  await requireJson(baseUrl, '/api/byok/openrouter', {
    method: 'POST',
    body: { apiKey: SMOKE_PROVIDER_KEY },
    statuses: [201],
    validate: (body) => body?.secret?.providerId === 'openrouter',
  })
  await requireJson(baseUrl, '/api/byok/openrouter/validate', {
    method: 'POST',
    validate: (body) => body?.validated === true,
  })
  // Provider validation crosses the same loopback adapter. Clear that evidence
  // so the subsequent assertion can only pass after the session prompt makes a
  // new model request.
  provider.resetEvidence()
  const created = await requireJson(baseUrl, '/api/sessions', {
    method: 'POST',
    body: {},
    statuses: [201],
    validate: (body) => typeof body?.session?.sessionId === 'string',
  })
  const sessionId = created.session.sessionId
  await requireJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: 'POST',
    body: {
      text: 'Respond with exactly cloud-provider-smoke-ok',
      agent: 'build',
    },
    statuses: [202],
    validate: (body) => Number(body?.processed) === 1,
  })
  let evidence
  try {
    evidence = await waitFor(provider.evidence, 'provider adapter request')
  } catch (error) {
    const view = await requireJson(
      baseUrl,
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    ).catch((viewError) => ({
      viewError: viewError instanceof Error ? viewError.message : String(viewError),
    }))
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; `
      + `session=${JSON.stringify(view).slice(0, 8_000)}`,
      { cause: error },
    )
  }
  if (
    evidence.method !== 'POST'
    || !evidence.url?.endsWith('/chat/completions')
    || !evidence.authorization
    || evidence.model !== 'cloud-smoke-model'
  ) {
    throw new Error(
      `provider adapter request was unexpected: ${JSON.stringify(evidence)}`,
    )
  }
  await requireJson(baseUrl, '/api/byok/openrouter', {
    method: 'DELETE',
    validate: (body) => body?.disabled === true,
  })
}

async function exerciseBundledMcp() {
  const result = await invokeStdioMcpTool({
    script: chartsMcp,
    runtimeRoot,
    toolName: 'mermaid',
    arguments: {
      diagram: 'graph TD; PrunedRuntime-->ChartsMCP',
      title: 'Cloud closure smoke',
    },
  })
  const text = result.content.find((entry) => entry?.type === 'text')?.text
  const payload = JSON.parse(text || 'null')
  if (
    payload?.type !== 'mermaid'
    || payload?.diagram !== 'graph TD; PrunedRuntime-->ChartsMCP'
  ) {
    throw new Error('bundled charts MCP returned an unexpected tools/call result')
  }
}

async function main() {
  requireFile(bundle, 'cloud bundle')
  requireFile(chartsMcp, 'bundled charts MCP')
  const { externalPackages, runtimePackages } = readRuntimePackageClosure()
  assertRuntimeExternalResolutionsContained({
    runtimeRoot,
    bundle,
    externalPackages: [...externalPackages, ...runtimePackages],
  })

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-smoke-root-')))
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-smoke-data-')))
  const output = { value: '' }
  let child = null
  let provider = null
  try {
    provider = await startModelProvider()
    const providerConfigPath = join(root, 'open-cowork.config.json')
    writeFileSync(
      providerConfigPath,
      `${JSON.stringify(buildSmokeProviderOverride(provider.baseURL), null, 2)}\n`,
      { mode: 0o600 },
    )
    await assertSmokeConfigLoaded({
      root,
      data,
      providerConfigPath,
      providerBaseURL: provider.baseURL,
    })
    child = spawn(process.execPath, cloudChildArgs(), {
      cwd: runtimeRoot,
      env: allowlistedChildEnvironment({ root, data, providerConfigPath }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const baseUrl = await waitForCloudReady(child, output)
    await exerciseProviderBoundary(baseUrl, provider)
    await exerciseBundledMcp()
    process.stdout.write(
      `[cloud-smoke] OK: ${externalPackages.length} externals and `
      + `${runtimePackages.length} runtime packages stayed inside the runtime root; `
      + 'Cloud crossed the OpenCode provider adapter and invoked the bundled charts MCP.\n',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[cloud-smoke] FAIL: ${message}\n`)
    if (output.value.trim()) {
      const lines = output.value.trim().split('\n')
      const relevant = lines.filter((line) => (
        /error|opencode|provider|runtime|supervisor|session wait/i.test(line)
      ))
      process.stderr.write(
        `--- bundle output (diagnostic tail) ---\n${(relevant.length ? relevant : lines).slice(-80).join('\n')}\n`,
      )
    }
    process.exitCode = 1
  } finally {
    if (child) await stopChild(child)
    if (provider) await provider.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
}

await main()
