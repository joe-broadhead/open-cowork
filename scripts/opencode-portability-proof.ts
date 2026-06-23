#!/usr/bin/env node
import { createManagedOpencodeServerAuth } from '@open-cowork/runtime-host'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { RuntimePortabilityProofStore } from './support/runtime-portability-proof-store.ts'
import {
  buildPortableRuntimeManifest,
  checkSandboxRuntimeEngine,
  isRuntimeSnapshotSecretBearingPath,
  runtimePathsForPortability,
  type SandboxEngine,
  type PortableRuntimeEntry,
} from '../apps/desktop/src/main/cloud/runtime-portability.ts'
import { createNodeManagedOpencodeServer } from '../apps/desktop/src/main/runtime-node-managed-server.ts'

type RuntimePathSet = ReturnType<typeof runtimePathsForPortability>

type ProofCliOptions = {
  keep: boolean
  json: boolean
  opencodeBinPath: string
  root: string
  sandboxEngine: SandboxEngine | 'none'
  timeoutMs: number
}

type SdkSnapshot = {
  session: unknown
  messages: unknown[]
  todos: unknown
  children: unknown[]
  permissions: unknown[]
  questions: unknown[]
}

type ManifestCopyResult = {
  source: string
  target: string
  kind: PortableRuntimeEntry['kind']
  required: boolean
  secretBearing: boolean
  digest: string | null
  copied: boolean
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOpencodeBinPath = join(repoRoot, 'apps/desktop/node_modules/.bin/opencode')

function writeStdout(message: string) {
  process.stdout.write(`${message}\n`)
}

function writeStderr(message: string) {
  process.stderr.write(`${message}\n`)
}

function parseArgs(argv: string[]): ProofCliOptions {
  const options: ProofCliOptions = {
    keep: false,
    json: false,
    opencodeBinPath: defaultOpencodeBinPath,
    root: mkdtempSync(join(tmpdir(), 'open-cowork-portability-proof-')),
    sandboxEngine: 'docker',
    timeoutMs: 60_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep') options.keep = true
    else if (arg === '--json') options.json = true
    else if (arg === '--opencode-bin') options.opencodeBinPath = resolve(argv[++index] || '')
    else if (arg === '--root') options.root = resolve(argv[++index] || '')
    else if (arg === '--sandbox-engine') {
      const value = argv[++index]
      if (value !== 'docker' && value !== 'apple-container' && value !== 'none') {
        throw new Error('--sandbox-engine must be docker, apple-container, or none.')
      }
      options.sandboxEngine = value
    }
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
  writeStdout(`Usage: pnpm proof:cloud:opencode-portability [--json] [--keep] [--root DIR] [--opencode-bin PATH] [--sandbox-engine docker|apple-container|none] [--timeout-ms MS]

Runs the OpenCode portability proof with isolated runtime homes:
  1. start OpenCode runtime A through the Node RuntimeLauncher
  2. create and prompt a session without model credentials using noReply
  3. snapshot OpenCode/Cowork/workspace/artifact state
  4. restore that snapshot to a separate runtime/workspace path
  5. start OpenCode runtime B through the Node RuntimeLauncher
  6. verify SDK session, messages, todos, children, permissions, and questions match
  7. report sandbox engine preflight availability without leaking local paths
`)
}

function runtimePaths(root: string, name: string): RuntimePathSet {
  const home = join(root, name, 'runtime-home')
  return runtimePathsForPortability({
    home,
    configHome: join(home, '.config'),
    dataHome: join(home, '.local', 'share'),
    cacheHome: join(home, '.cache'),
    stateHome: join(home, '.local', 'state'),
  })
}

function buildProofRuntimeEnvironment(input: {
  auth: ReturnType<typeof createManagedOpencodeServerAuth>
  runtimePaths: RuntimePathSet
}) {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'ComSpec',
    'COMSPEC',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_CTYPE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.HOME = input.runtimePaths.home
  env.USERPROFILE = input.runtimePaths.home
  env.XDG_CONFIG_HOME = input.runtimePaths.configHome
  env.XDG_DATA_HOME = input.runtimePaths.dataHome
  env.XDG_CACHE_HOME = input.runtimePaths.cacheHome
  env.XDG_STATE_HOME = input.runtimePaths.stateHome
  env.APPDATA = input.runtimePaths.configHome
  env.LOCALAPPDATA = input.runtimePaths.dataHome
  env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = '1'
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = '1'
  env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = 'true'
  env.OPENCODE_SERVER_USERNAME = input.auth.username
  env.OPENCODE_SERVER_PASSWORD = input.auth.password
  return env
}

async function loadOpencodeClientFactory() {
  const sdkPath = join(repoRoot, 'apps/desktop/node_modules/@opencode-ai/sdk/dist/v2/index.js')
  const sdk = await import(pathToFileURL(sdkPath).href) as {
    createOpencodeClient(config: {
      baseUrl: string
      directory?: string
      headers?: Record<string, string>
    }): {
      session: {
        create(parameters?: Record<string, unknown>, options?: { throwOnError?: boolean }): Promise<{ data: { id: string } }>
        get(parameters: Record<string, unknown>, options?: { throwOnError?: boolean }): Promise<{ data: unknown }>
        messages(parameters: Record<string, unknown>, options?: { throwOnError?: boolean }): Promise<{ data: unknown[] }>
        promptAsync(parameters: Record<string, unknown>, options?: { throwOnError?: boolean }): Promise<{ data: unknown }>
        todo(parameters: Record<string, unknown>, options?: { throwOnError?: boolean }): Promise<{ data: unknown }>
        children(parameters: Record<string, unknown>, options?: { throwOnError?: boolean }): Promise<{ data: unknown[] }>
      }
      permission: {
        list(parameters?: Record<string, unknown>, options?: { throwOnError?: boolean }): Promise<{ data: unknown[] }>
      }
      question: {
        list(parameters?: Record<string, unknown>, options?: { throwOnError?: boolean }): Promise<{ data: unknown[] }>
      }
    }
  }
  return sdk.createOpencodeClient
}

async function startRuntime(input: {
  opencodeBinPath: string
  runtimePaths: RuntimePathSet
  timeoutMs: number
  workspaceDir: string
}) {
  mkdirSync(input.runtimePaths.home, { recursive: true })
  mkdirSync(input.workspaceDir, { recursive: true })
  const auth = createManagedOpencodeServerAuth()
  const port = await findAvailablePort()
  const server = await createNodeManagedOpencodeServer({
    cwd: input.runtimePaths.home,
    env: buildProofRuntimeEnvironment({ auth, runtimePaths: input.runtimePaths }),
    hostname: '127.0.0.1',
    port,
    timeout: input.timeoutMs,
    opencodeBinPath: input.opencodeBinPath,
    config: { logLevel: 'WARN' },
  })
  const createOpencodeClient = await loadOpencodeClientFactory()
  return {
    auth,
    server,
    client: createOpencodeClient({
      baseUrl: server.url,
      directory: input.workspaceDir,
      headers: { Authorization: auth.authorizationHeader },
    }),
  }
}

async function findAvailablePort() {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => {
        if (error) reject(error)
        else if (port) resolvePort(port)
        else reject(new Error('Could not reserve an available OpenCode runtime port.'))
      })
    })
  })
}

function seedPortableRuntimeContent(input: {
  artifactDir: string
  metadataPath: string
  runtimePaths: RuntimePathSet
  workspaceDir: string
}) {
  const files = [
    [join(input.runtimePaths.home, 'runtime-skill-catalog', 'catalog.json'), '{"skills":["portability"]}\n'],
    [join(input.runtimePaths.home, 'managed-skills', 'portability', 'SKILL.md'), '# Managed Portability Skill\n'],
    [join(input.workspaceDir, 'README.md'), 'Portability proof workspace fixture\n'],
    [join(input.workspaceDir, '.env.portability'), 'PORTABILITY_DUMMY_SECRET=secret\n'],
    [join(input.artifactDir, 'chart-artifact.json'), '{"artifact":true}\n'],
    [input.metadataPath, '{"sessions":[],"portabilityProof":true}\n'],
    [join(dirname(input.metadataPath), 'settings.enc'), 'dummy encrypted settings fixture\n'],
  ] as const

  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

function writeCoworkSessionMetadata(input: {
  metadataPath: string
  sessionId: string
  workspaceDir: string
}) {
  mkdirSync(dirname(input.metadataPath), { recursive: true })
  writeFileSync(input.metadataPath, `${JSON.stringify({
    portabilityProof: true,
    sessions: [{
      id: input.sessionId,
      title: 'OpenCode portability proof',
      kind: 'chat',
      opencodeDirectory: input.workspaceDir,
    }],
  }, null, 2)}\n`)
}

function assertRestoredCoworkMetadata(input: {
  metadataPath: string
  sessionId: string
}) {
  const parsed = JSON.parse(readFileSync(input.metadataPath, 'utf8')) as {
    sessions?: Array<{ id?: string }>
  }
  assert.equal(parsed.sessions?.[0]?.id, input.sessionId)
}

function hashPath(path: string): string | null {
  const hash = createHash('sha256')
  let entries: Dirent[]
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code !== 'ENOTDIR') throw error
    hash.update(readFileSync(path))
    return hash.digest('hex')
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const entryHash = hashPath(join(path, entry.name))
    hash.update(entry.name)
    if (entryHash) hash.update(entryHash)
  }
  return hash.digest('hex')
}

function cleanupProofRoot(root: string) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeStderr(`Warning: OpenCode portability proof passed, but temporary root cleanup failed: ${message}`)
  }
}

export function mapPortableEntryPath(input: {
  path: string
  sourceArtifactDir: string
  sourceMetadataPath: string
  sourceRuntimePaths: RuntimePathSet
  sourceWorkspaceDir: string
  targetArtifactDir: string
  targetMetadataPath: string
  targetRuntimePaths: RuntimePathSet
  targetWorkspaceDir: string
}) {
  const mappings = [
    [input.sourceRuntimePaths.home, input.targetRuntimePaths.home],
    [input.sourceWorkspaceDir, input.targetWorkspaceDir],
    [input.sourceArtifactDir, input.targetArtifactDir],
    [input.sourceMetadataPath, input.targetMetadataPath],
    [dirname(input.sourceMetadataPath), dirname(input.targetMetadataPath)],
  ] as const
  const sourcePath = resolve(input.path)
  for (const [sourceRoot, targetRoot] of mappings) {
    const resolvedSourceRoot = resolve(sourceRoot)
    if (sourcePath === resolvedSourceRoot) return resolve(targetRoot)
    const rel = relative(resolvedSourceRoot, sourcePath)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return resolve(targetRoot, rel)
    }
  }
  throw new Error(`No portable restore mapping for ${input.path}`)
}

function copyPortableManifest(input: {
  artifactDirA: string
  artifactDirB: string
  manifest: PortableRuntimeEntry[]
  metadataPathA: string
  metadataPathB: string
  runtimePathsA: RuntimePathSet
  runtimePathsB: RuntimePathSet
  workspaceDirA: string
  workspaceDirB: string
}) {
  const results: ManifestCopyResult[] = []
  for (const entry of input.manifest) {
    const target = mapPortableEntryPath({
      path: entry.path,
      sourceArtifactDir: input.artifactDirA,
      sourceMetadataPath: input.metadataPathA,
      sourceRuntimePaths: input.runtimePathsA,
      sourceWorkspaceDir: input.workspaceDirA,
      targetArtifactDir: input.artifactDirB,
      targetMetadataPath: input.metadataPathB,
      targetRuntimePaths: input.runtimePathsB,
      targetWorkspaceDir: input.workspaceDirB,
    })
    const sourceExists = existsSync(entry.path)
    if (!sourceExists && entry.required) throw new Error(`Required portable path is missing: ${entry.path}`)
    if (sourceExists && entry.kind !== 'opencode-cache') {
      mkdirSync(dirname(target), { recursive: true })
      cpSync(entry.path, target, { recursive: true })
    }
    results.push({
      source: entry.path,
      target,
      kind: entry.kind,
      required: entry.required,
      secretBearing: entry.secretBearing || isRuntimeSnapshotSecretBearingPath(entry.path),
      digest: sourceExists ? hashPath(entry.path) : null,
      copied: sourceExists && entry.kind !== 'opencode-cache',
    })
  }
  return results
}

function redactProofPath(path: string, root: string) {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  if (resolvedPath === resolvedRoot) return '[proof-root]'
  const rel = relative(resolvedRoot, resolvedPath)
  if (!rel.startsWith('..') && !isAbsolute(rel)) return join('[proof-root]', rel)
  return '[outside-proof-root]'
}

function extractMessageText(message: unknown) {
  const parts = Array.isArray((message as { parts?: unknown[] }).parts)
    ? (message as { parts: unknown[] }).parts
    : []
  return parts
    .map((part) => typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')
    .filter(Boolean)
    .join('\n')
}

export function digestSdkSnapshot(snapshot: SdkSnapshot) {
  const session = snapshot.session as { id?: string; title?: string | null }
  return {
    sessionId: session?.id || null,
    title: session?.title || null,
    messages: snapshot.messages.map((message) => {
      const info = (message as { info?: { id?: string; role?: string } }).info || {}
      return {
        id: info.id || null,
        role: info.role || null,
        text: extractMessageText(message),
      }
    }),
    todos: snapshot.todos,
    childCount: snapshot.children.length,
    permissionCount: snapshot.permissions.length,
    questionCount: snapshot.questions.length,
  }
}

export function assertPortabilitySnapshotsMatch(before: SdkSnapshot, after: SdkSnapshot) {
  assert.deepEqual(digestSdkSnapshot(after), digestSdkSnapshot(before))
}

async function readSdkSnapshot(input: {
  client: Awaited<ReturnType<typeof startRuntime>>['client']
  sessionId: string
  workspaceDir: string
}): Promise<SdkSnapshot> {
  const parameters = { sessionID: input.sessionId, directory: input.workspaceDir }
  const [session, messages, todos, children, permissions, questions] = await Promise.all([
    input.client.session.get(parameters, { throwOnError: true }),
    input.client.session.messages(parameters, { throwOnError: true }),
    input.client.session.todo(parameters, { throwOnError: true }),
    input.client.session.children(parameters, { throwOnError: true }),
    input.client.permission.list({ directory: input.workspaceDir }, { throwOnError: true }),
    input.client.question.list({ directory: input.workspaceDir }, { throwOnError: true }),
  ])
  return {
    session: session.data,
    messages: messages.data || [],
    todos: todos.data,
    children: children.data || [],
    permissions: permissions.data || [],
    questions: questions.data || [],
  }
}

async function waitForPromptMessage(input: {
  client: Awaited<ReturnType<typeof startRuntime>>['client']
  expectedText: string
  sessionId: string
  timeoutMs: number
  workspaceDir: string
}) {
  const deadline = Date.now() + input.timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await readSdkSnapshot({
      client: input.client,
      sessionId: input.sessionId,
      workspaceDir: input.workspaceDir,
    })
    if (snapshot.messages.some((message) => extractMessageText(message).includes(input.expectedText))) {
      return snapshot
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for prompt message in session ${input.sessionId}.`)
}

function runControlPlaneProof(sessionId: string) {
  const store = new RuntimePortabilityProofStore()
  const first = store.claimSession(sessionId, 'worker-a', new Date('2026-05-26T00:00:00.000Z'), 1000)
  assert.ok(first)
  store.writeProjection(first, 1)
  store.enqueueCommand({
    commandId: 'prompt-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId,
    kind: 'prompt',
    payload: { text: 'hello' },
    targetLeaseToken: first.leaseToken,
  })
  assert.equal(store.claimNextCommand(first)?.commandId, 'prompt-1')
  const second = store.claimSession(sessionId, 'worker-b', new Date('2026-05-26T00:00:02.000Z'), 1000)
  assert.ok(second)
  assert.throws(() => store.writeProjection(first, 2), /stale/i)
  assert.throws(() => store.ackCommand(first, 'prompt-1'), /stale/i)
  for (const kind of ['abort', 'permission.respond', 'question.reply'] as const) {
    const command = store.enqueueCommand({
      commandId: `${kind}-1`,
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId,
      kind,
      payload: { kind },
    })
    assert.equal(store.enqueueCommand({
      commandId: `${kind}-1`,
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId,
      kind,
      payload: { kind },
    }).createdSeq, command.createdSeq)
  }
  return {
    staleProjectionRejected: true,
    staleAckRejected: true,
    interruptedTurnSemantics: 'lease expiry permits reassignment; stale worker writes and command acks are rejected; active model streams are not resumed mid-token and must be retried or marked interrupted by the cloud control plane',
    idempotentCommandKinds: ['prompt', 'abort', 'permission.respond', 'question.reply'],
  }
}

export async function runOpencodePortabilityProof(options: ProofCliOptions) {
  const runtimePathsA = runtimePaths(options.root, 'a')
  const runtimePathsB = runtimePaths(options.root, 'b')
  const workspaceDirA = join(options.root, 'a', 'workspace')
  const workspaceDirB = join(options.root, 'b', 'workspace')
  const artifactDirA = join(options.root, 'a', 'chart-artifacts')
  const artifactDirB = join(options.root, 'b', 'chart-artifacts')
  const metadataPathA = join(options.root, 'a', 'sessions.json')
  const metadataPathB = join(options.root, 'b', 'sessions.json')
  const settingsPathA = join(options.root, 'a', 'settings.enc')
  const promptText = `opencode portability proof ${Date.now()}`

  seedPortableRuntimeContent({
    artifactDir: artifactDirA,
    metadataPath: metadataPathA,
    runtimePaths: runtimePathsA,
    workspaceDir: workspaceDirA,
  })
  const manifest = buildPortableRuntimeManifest({
    runtimePaths: runtimePathsA,
    workspaceDirs: [workspaceDirA],
    artifactDirs: [artifactDirA],
    metadataPaths: [metadataPathA, settingsPathA],
  })

  const runtimeA = await startRuntime({
    opencodeBinPath: options.opencodeBinPath,
    runtimePaths: runtimePathsA,
    timeoutMs: options.timeoutMs,
    workspaceDir: workspaceDirA,
  })
  let sessionId: string
  let before: SdkSnapshot
  try {
    const created = await runtimeA.client.session.create({
      directory: workspaceDirA,
      title: 'OpenCode portability proof',
    }, { throwOnError: true })
    sessionId = created.data.id
    writeCoworkSessionMetadata({
      metadataPath: metadataPathA,
      sessionId,
      workspaceDir: workspaceDirA,
    })
    await runtimeA.client.session.promptAsync({
      sessionID: sessionId,
      directory: workspaceDirA,
      noReply: true,
      parts: [{ type: 'text', text: promptText }],
    }, { throwOnError: true })
    before = await waitForPromptMessage({
      client: runtimeA.client,
      expectedText: promptText,
      sessionId,
      timeoutMs: options.timeoutMs,
      workspaceDir: workspaceDirA,
    })
  } finally {
    runtimeA.server.close()
    await delay(2000)
  }

  const copied = copyPortableManifest({
    artifactDirA,
    artifactDirB,
    manifest,
    metadataPathA,
    metadataPathB,
    runtimePathsA,
    runtimePathsB,
    workspaceDirA,
    workspaceDirB,
  })
  assertRestoredCoworkMetadata({ metadataPath: metadataPathB, sessionId })

  const runtimeB = await startRuntime({
    opencodeBinPath: options.opencodeBinPath,
    runtimePaths: runtimePathsB,
    timeoutMs: options.timeoutMs,
    workspaceDir: workspaceDirB,
  })
  let after: SdkSnapshot
  try {
    after = await readSdkSnapshot({
      client: runtimeB.client,
      sessionId,
      workspaceDir: workspaceDirB,
    })
    assertPortabilitySnapshotsMatch(before!, after)
  } finally {
    runtimeB.server.close()
    await delay(2000)
  }

  const redactedCopied = copied.map((entry) => ({
    ...entry,
    source: redactProofPath(entry.source, options.root),
    target: redactProofPath(entry.target, options.root),
  }))

  return {
    ok: true,
    root: options.keep ? options.root : '[proof-root]',
    redacted: !options.keep,
    sessionId,
    sandboxEnginePreflight: options.sandboxEngine === 'none'
      ? null
      : await checkSandboxRuntimeEngine(options.sandboxEngine),
    nodeRuntimeLauncher: true,
    runtimeConfigSource: 'app-managed',
    machineNativeRuntimeConfigDisabled: true,
    promptMode: 'noReply',
    copied: redactedCopied,
    omittedOptionalKinds: ['opencode-cache'],
    secretBearingPaths: copied
      .filter((entry) => entry.secretBearing)
      .map((entry) => redactProofPath(entry.source, options.root)),
    before: digestSdkSnapshot(before!),
    after: digestSdkSnapshot(after!),
    controlPlane: runControlPlaneProof(sessionId),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  try {
    const report = await runOpencodePortabilityProof(options)
    if (options.json) writeStdout(JSON.stringify(report, null, 2))
    else {
      writeStdout(`OpenCode portability proof passed for ${report.sessionId}`)
      writeStdout(`Restored ${report.copied.filter((entry) => entry.copied).length} portable entries; omitted cache as optional.`)
      writeStdout(`Secret-bearing paths classified: ${report.secretBearingPaths.length}`)
    }
  } finally {
    if (!options.keep) cleanupProofRoot(options.root)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeStderr(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
