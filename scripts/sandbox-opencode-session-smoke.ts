#!/usr/bin/env node
import { sanitizeForExport } from '@open-cowork/shared'
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkSandboxRuntimeEngine,
  runSandboxRuntimeOneShot,
  SANDBOX_COMPONENT_MANIFEST_FORMAT,
  type SandboxEngine,
  type SandboxRuntimeEngineCheckResult,
  type SandboxRuntimeOneShotResult,
} from '../apps/desktop/src/main/cloud/runtime-portability.ts'

type ProofOptions = {
  developmentOverride: boolean
  engine: SandboxEngine
  image: string | null
  imageSha256: string | null
  imageSignature: string | null
  json: boolean
  keep: boolean
  root: string
  strict: boolean
  timeoutMs: number
}

type ProofReasonCode =
  | 'sandbox-opencode-session-passed'
  | 'sandbox-runtime-engine-unavailable'
  | 'sandbox-runtime-engine-check-failed'
  | 'sandbox-runtime-image-not-configured'
  | 'sandbox-runtime-policy-blocked'
  | 'sandbox-runtime-command-failed'

type ProofReport = {
  ok: boolean
  reasonCode: ProofReasonCode
  engine: SandboxEngine
  image: string | null
  root: string
  redacted: true
  strict: boolean
  sandboxEnginePreflight: SandboxRuntimeEngineCheckResult
  oneShot: SandboxRuntimeOneShotResult | null
}

const defaultRoot = () => mkdtempSync(join(tmpdir(), 'open-cowork-sandbox-opencode-proof-'))

function writeStdout(message: string) {
  process.stdout.write(`${message}\n`)
}

function writeStderr(message: string) {
  process.stderr.write(`${message}\n`)
}

function envFlag(name: string) {
  return ['1', 'true', 'yes'].includes((process.env[name] || '').trim().toLowerCase())
}

function parseArgs(argv: string[]): ProofOptions {
  const options: ProofOptions = {
    developmentOverride: envFlag('OPEN_COWORK_SANDBOX_DEVELOPMENT_OVERRIDE'),
    engine: (process.env.OPEN_COWORK_SANDBOX_ENGINE as SandboxEngine | undefined) || 'docker',
    image: process.env.OPEN_COWORK_SANDBOX_IMAGE || null,
    imageSha256: process.env.OPEN_COWORK_SANDBOX_IMAGE_SHA256 || null,
    imageSignature: process.env.OPEN_COWORK_SANDBOX_IMAGE_SIGNATURE || null,
    json: false,
    keep: false,
    root: defaultRoot(),
    strict: false,
    timeoutMs: Number.parseInt(process.env.OPEN_COWORK_SANDBOX_TIMEOUT_MS || '120000', 10),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--development-override') options.developmentOverride = true
    else if (arg === '--engine') {
      const engine = argv[++index]
      if (engine !== 'docker' && engine !== 'apple-container') {
        throw new Error('--engine must be docker or apple-container.')
      }
      options.engine = engine
    } else if (arg === '--image') options.image = argv[++index] || null
    else if (arg === '--image-sha256') options.imageSha256 = argv[++index] || null
    else if (arg === '--image-signature') options.imageSignature = argv[++index] || null
    else if (arg === '--json') options.json = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--root') options.root = resolve(argv[++index] || '')
    else if (arg === '--strict') options.strict = true
    else if (arg === '--timeout-ms') options.timeoutMs = Number.parseInt(argv[++index] || '', 10)
    else if (arg === '--help') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer.')
  }
  return options
}

function printHelp() {
  writeStdout(`Usage: pnpm proof:sandbox:opencode-session [--json] [--strict] [--engine docker|apple-container] [--image IMAGE] [--image-sha256 DIGEST | --image-signature SIGNATURE] [--development-override] [--root DIR] [--keep]

Runs a real sandboxed OpenCode no-reply session proof when a sandbox engine and
OpenCode runtime image are configured. Without --strict, missing engine/image
is reported as typed redacted evidence and exits 0. With --strict, any result
other than sandbox-opencode-session-passed exits non-zero.

Environment equivalents:
  OPEN_COWORK_SANDBOX_ENGINE=docker
  OPEN_COWORK_SANDBOX_IMAGE=open-cowork/opencode:local
  OPEN_COWORK_SANDBOX_IMAGE_SHA256=sha256:...
  OPEN_COWORK_SANDBOX_IMAGE_SIGNATURE=cosign:...
  OPEN_COWORK_SANDBOX_DEVELOPMENT_OVERRIDE=1
`)
}

function imageSource(engine: SandboxEngine, image: string) {
  return engine === 'docker' ? `docker://${image}` : `oci://${image}`
}

function redactPath(path: string, root: string) {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  if (resolvedPath === resolvedRoot) return '[proof-root]'
  if (resolvedPath.startsWith(`${resolvedRoot}/`)) return `[proof-root]${resolvedPath.slice(resolvedRoot.length)}`
  return '[outside-proof-root]'
}

function cleanupRoot(root: string) {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
}

function writeHarness(path: string, timeoutMs: number) {
  const password = randomBytes(24).toString('hex')
  const promptText = `sandbox opencode no-reply proof ${Date.now()}`
  const readinessTimeoutMs = Math.max(10_000, Math.floor(timeoutMs / 3))
  const promptTimeoutMs = Math.max(10_000, Math.floor(timeoutMs / 2))
  const source = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const workspaceDir = '/workspace'
const runtimeHome = '/runtime-home'
const authUser = 'opencode'
const authPass = '${password}'
const promptText = ${JSON.stringify(promptText)}
const serverUrl = 'http://127.0.0.1:4096'
const authHeader = 'Basic ' + Buffer.from(authUser + ':' + authPass).toString('base64')

for (const dir of [
  workspaceDir,
  runtimeHome,
  join(runtimeHome, '.config'),
  join(runtimeHome, '.local', 'share'),
  join(runtimeHome, '.cache'),
  join(runtimeHome, '.local', 'state'),
]) {
  mkdirSync(dir, { recursive: true })
}
writeFileSync(join(workspaceDir, 'README.md'), 'Open Cowork sandbox OpenCode proof workspace\\n')

const child = spawn(process.env.OPENCODE_BIN || 'opencode', [
  'serve',
  '--hostname',
  '127.0.0.1',
  '--port',
  '4096',
], {
  cwd: workspaceDir,
  env: {
    ...process.env,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    XDG_CONFIG_HOME: join(runtimeHome, '.config'),
    XDG_DATA_HOME: join(runtimeHome, '.local', 'share'),
    XDG_CACHE_HOME: join(runtimeHome, '.cache'),
    XDG_STATE_HOME: join(runtimeHome, '.local', 'state'),
    APPDATA: join(runtimeHome, '.config'),
    LOCALAPPDATA: join(runtimeHome, '.local', 'share'),
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
    OPENCODE_SERVER_USERNAME: authUser,
    OPENCODE_SERVER_PASSWORD: authPass,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let logs = ''
child.stdout.on('data', (chunk) => {
  logs += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  logs += chunk.toString()
})

async function request(method, pathname, body) {
  const response = await fetch(serverUrl + pathname, {
    method,
    headers: {
      Authorization: authHeader,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (!response.ok) {
    throw new Error(method + ' ' + pathname + ' failed with ' + response.status + ': ' + text.slice(0, 400))
  }
  return parsed
}

function sessionIdFrom(value) {
  return value?.id || value?.data?.id || null
}

function messageListFrom(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  if (Array.isArray(value?.messages)) return value.messages
  return []
}

function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return parts.map((part) => typeof part?.text === 'string' ? part.text : '').join('\\n')
}

async function waitForServer() {
  const deadline = Date.now() + ${readinessTimeoutMs}
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('opencode serve exited before readiness: ' + logs.slice(-800))
    try {
      await request('GET', '/doc')
      return
    } catch {
      await delay(250)
    }
  }
  throw new Error('timed out waiting for opencode serve readiness: ' + logs.slice(-800))
}

async function waitForPrompt(sessionId) {
  const deadline = Date.now() + ${promptTimeoutMs}
  while (Date.now() < deadline) {
    const messages = messageListFrom(await request(
      'GET',
      '/session/' + encodeURIComponent(sessionId) + '/message?directory=' + encodeURIComponent(workspaceDir),
    ))
    if (messages.some((message) => messageText(message).includes(promptText))) return true
    await delay(250)
  }
  return false
}

try {
  await waitForServer()
  const session = await request('POST', '/session?directory=' + encodeURIComponent(workspaceDir), {
    title: 'Open Cowork sandbox OpenCode proof',
  })
  const sessionId = sessionIdFrom(session)
  if (!sessionId) throw new Error('OpenCode session create response did not include an id.')
  await request(
    'POST',
    '/session/' + encodeURIComponent(sessionId) + '/prompt_async?directory=' + encodeURIComponent(workspaceDir),
    {
      noReply: true,
      parts: [{ type: 'text', text: promptText }],
    },
  )
  const observed = await waitForPrompt(sessionId)
  if (!observed) throw new Error('Timed out waiting for no-reply prompt message.')
  process.stdout.write(JSON.stringify({
    ok: true,
    sessionId,
    messageObserved: true,
    runtimeAuthority: 'sandbox-container',
  }) + '\\n')
} finally {
  child.kill('SIGTERM')
  await delay(500)
  if (child.exitCode === null) child.kill('SIGKILL')
}
`
  writeFileSync(path, source, { mode: 0o700 })
}

async function runProof(options: ProofOptions): Promise<ProofReport> {
  mkdirSync(options.root, { recursive: true })
  const engineCheck = await checkSandboxRuntimeEngine(options.engine)
  const base = {
    engine: options.engine,
    image: options.image ? sanitizeForExport(options.image) : null,
    root: options.keep ? redactPath(options.root, options.root) : '[proof-root]',
    redacted: true as const,
    strict: options.strict,
    sandboxEnginePreflight: engineCheck,
  }

  if (!engineCheck.ok) {
    return {
      ...base,
      ok: false,
      reasonCode: engineCheck.reasonCode === 'sandbox-runtime-engine-unavailable'
        ? 'sandbox-runtime-engine-unavailable'
        : 'sandbox-runtime-engine-check-failed',
      oneShot: null,
    }
  }
  if (!options.image?.trim()) {
    return {
      ...base,
      ok: false,
      reasonCode: 'sandbox-runtime-image-not-configured',
      oneShot: null,
    }
  }

  const proofDir = join(options.root, 'proof')
  const workspaceDir = join(options.root, 'workspace')
  const runtimeHome = join(options.root, 'runtime-home')
  mkdirSync(proofDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(runtimeHome, { recursive: true })
  writeHarness(join(proofDir, 'sandbox-session-proof.mjs'), options.timeoutMs)

  const imageComponent = {
    id: 'opencode-runtime-image',
    kind: 'image' as const,
    source: imageSource(options.engine, options.image),
    ...(options.imageSha256 ? { sha256: options.imageSha256 } : {}),
    ...(options.imageSignature ? { signature: options.imageSignature } : {}),
    verified: Boolean(options.imageSha256 || options.imageSignature),
  }
  const oneShot = await runSandboxRuntimeOneShot({
    engine: options.engine,
    imageComponentId: imageComponent.id,
    runtimeId: `open-cowork-proof-${randomBytes(4).toString('hex')}`,
    allowedSourceRoots: [options.root],
    mounts: [
      {
        source: proofDir,
        target: '/proof',
        mode: 'read-only',
        purpose: 'metadata',
      },
      {
        source: workspaceDir,
        target: '/workspace',
        mode: 'read-write',
        purpose: 'workspace',
      },
      {
        source: runtimeHome,
        target: '/runtime-home',
        mode: 'read-write',
        purpose: 'runtime-home',
      },
    ],
    componentManifest: {
      format: SANDBOX_COMPONENT_MANIFEST_FORMAT,
      components: [imageComponent],
    },
    developmentOverride: options.developmentOverride
      ? {
        enabled: true,
        reason: 'operator requested unsigned local sandbox image proof',
      }
      : undefined,
    command: ['node', '/proof/sandbox-session-proof.mjs'],
  })

  return {
    ...base,
    ok: oneShot.ok,
    reasonCode: oneShot.ok
      ? 'sandbox-opencode-session-passed'
      : oneShot.reasonCode === 'sandbox-runtime-policy-blocked'
        ? 'sandbox-runtime-policy-blocked'
        : 'sandbox-runtime-command-failed',
    oneShot,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  try {
    const report = await runProof(options)
    if (options.json) writeStdout(JSON.stringify(report, null, 2))
    else if (report.ok) {
      writeStdout('Sandboxed OpenCode no-reply session proof passed.')
    } else {
      writeStdout(`Sandboxed OpenCode no-reply session proof did not pass: ${report.reasonCode}`)
    }
    if (options.strict && !report.ok) process.exitCode = 1
  } finally {
    if (!options.keep) cleanupRoot(options.root)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeStderr(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
