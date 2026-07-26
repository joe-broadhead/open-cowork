import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import {
  assertCloudExecutionIsolationCapability,
  CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
  CloudExecutionIsolationError,
  developmentProcessIsolationCapability,
  evaluateCloudExecutionIsolationCapability,
  resolveCloudExecutionIsolationPolicy,
  resolveCloudExecutionWorkerId,
} from '@open-cowork/cloud-server/execution-isolation'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { createByokSecretStore } from '@open-cowork/cloud-server/byok-secret-store'
import {
  cloudKnowledgeRuntimeEligible,
  startCloudApp,
} from '@open-cowork/cloud-server/app'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import {
  createCloudPathProvider,
  createCloudSessionPathProvider,
} from '@open-cowork/cloud-server/path-provider'
import { createSandboxCloudExecutionIsolationProvider } from '@open-cowork/cloud-server/sandbox-execution-isolation-provider'
import { createEnvelopeSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import { createWorkerScopedRuntimeAdapter } from '@open-cowork/cloud-server/worker-scoped-runtime-adapter'
import type { SandboxRuntimeCommandRunner } from '@open-cowork/cloud-server/runtime-portability'
import { sandboxWorkerOwnerHash } from '../packages/cloud-server/src/sandbox-orphan-cleanup.ts'

const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`

function flagValue(args: string[], flag: string) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function fakeBoundaryInspection(
  runArgs: string[],
  boundaryId: string,
  override: Record<string, unknown> = {},
) {
  const mounts = runArgs.flatMap((arg, index) => {
    if (arg !== '--mount') return []
    const fields = Object.fromEntries(
      (runArgs[index + 1] || '').split(',').map((part) => {
        const separator = part.indexOf('=')
        return separator < 0 ? [part, true] : [part.slice(0, separator), part.slice(separator + 1)]
      }),
    )
    return [{
      Type: fields.type,
      Source: fields.src,
      Destination: fields.dst,
      RW: fields.readonly !== true,
    }]
  })
  const network = flagValue(runArgs, '--network') || 'none'
  const labels = Object.fromEntries(runArgs.flatMap((arg, index) => {
    if (arg !== '--label') return []
    const label = runArgs[index + 1] || ''
    const separator = label.indexOf('=')
    return separator < 1 ? [] : [[label.slice(0, separator), label.slice(separator + 1)]]
  }))
  return {
    Id: 'c'.repeat(64),
    Name: `/${boundaryId}`,
    Image: IMAGE_DIGEST,
    State: { Running: true },
    Config: {
      Image: `open-cowork/opencode@${IMAGE_DIGEST}`,
      User: flagValue(runArgs, '--user'),
      WorkingDir: flagValue(runArgs, '--workdir'),
      Entrypoint: [flagValue(runArgs, '--entrypoint')],
      Cmd: ['serve', '--hostname=0.0.0.0', '--port=4096'],
      Labels: labels,
    },
    HostConfig: {
      NetworkMode: network,
      AutoRemove: true,
      Privileged: false,
      ReadonlyRootfs: true,
      CapAdd: null,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Init: true,
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      RestartPolicy: { Name: 'no' },
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=268435456' },
    },
    Mounts: mounts,
    NetworkSettings: { Networks: { [network]: {} } },
    ...override,
  }
}

function sandboxPolicy(overrides: Record<string, string | undefined> = {}) {
  return resolveCloudExecutionIsolationPolicy({
    deploymentTier: 'public_production',
    role: 'worker',
    env: {
      OPEN_COWORK_CLOUD_ISOLATION_IMAGE: 'open-cowork/opencode:test',
      OPEN_COWORK_CLOUD_ISOLATION_IMAGE_SHA256: IMAGE_DIGEST,
      ...overrides,
    },
  })
}

function respondToSandboxReadinessProbe(
  req: IncomingMessage,
  res: ServerResponse,
  permissionEffect: 'allow' | 'deny' = 'deny',
) {
  if (req.url === '/doc') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return true
  }
  if (req.method === 'POST' && req.url === '/api/session') {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: { id: 'readiness-session' } }))
    return true
  }
  if (req.method === 'GET' && req.url === '/api/agent') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [{
        id: 'build',
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      }],
    }))
    return true
  }
  if (req.method === 'POST' && req.url === '/api/session/readiness-session/permission') {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: { id: 'readiness-permission', effect: permissionEffect },
    }))
    return true
  }
  if (
    req.method === 'DELETE'
    && req.url === '/session/readiness-session?directory=%2Fworkspace'
  ) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: true }))
    return true
  }
  return false
}

test('Cloud execution isolation requires local workers to opt into the warned development boundary', () => {
  const implicit = resolveCloudExecutionIsolationPolicy({
    deploymentTier: 'local',
    role: 'worker',
    env: {},
  })

  assert.equal(implicit.required, false)
  assert.equal(implicit.mode, 'sandbox')
  assert.equal(implicit.blockers.includes('sandbox_image_missing'), true)
  assert.equal(implicit.blockers.includes('sandbox_image_digest_missing'), true)

  const policy = resolveCloudExecutionIsolationPolicy({
    deploymentTier: 'local',
    role: 'worker',
    env: {
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
    },
  })
  assert.equal(policy.mode, 'development-process')
  assert.match(policy.warning || '', /development-only/)
  assert.equal(evaluateCloudExecutionIsolationCapability(
    policy,
    developmentProcessIsolationCapability(),
  ).ok, true)
})

test('Cloud execution isolation defaults non-local workers to fail-closed sandbox admission', () => {
  const policy = resolveCloudExecutionIsolationPolicy({
    deploymentTier: 'private_beta',
    role: 'worker',
    env: {},
  })

  assert.equal(policy.required, true)
  assert.equal(policy.mode, 'sandbox')
  assert.deepEqual(policy.blockers, [
    'sandbox_image_missing',
    'sandbox_image_digest_missing',
  ])
  assert.throws(
    () => assertCloudExecutionIsolationCapability(policy, developmentProcessIsolationCapability()),
    (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.code === 'cloud_execution_isolation_unavailable'
    ),
  )
})

test('Cloud execution worker identity rejects missing or malformed production admission', () => {
  const base = {
    deploymentTier: 'public_production' as const,
    role: 'worker' as const,
    isolationMode: 'sandbox' as const,
  }
  for (const workerId of [
    undefined,
    '',
    '   ',
    '../worker-a',
    'worker/a',
    'worker a',
    `worker-${'a'.repeat(128)}`,
  ]) {
    assert.throws(
      () => resolveCloudExecutionWorkerId({
        ...base,
        env: workerId === undefined
          ? {}
          : { OPEN_COWORK_CLOUD_WORKER_ID: workerId },
      }),
      (error: unknown) => (
        error instanceof CloudExecutionIsolationError
        && (
          error.reasonCode === 'cloud_worker_id_missing'
          || error.reasonCode === 'cloud_worker_id_invalid'
        )
      ),
    )
  }
  assert.deepEqual(resolveCloudExecutionWorkerId({
    ...base,
    env: { OPEN_COWORK_CLOUD_WORKER_ID: 'worker-REGION.pool_001' },
  }), {
    workerId: 'worker-REGION.pool_001',
    usedDevelopmentFallback: false,
  })
  assert.deepEqual(resolveCloudExecutionWorkerId({
    deploymentTier: 'local',
    role: 'all-in-one',
    isolationMode: 'development-process',
    env: {},
  }), {
    workerId: 'all-in-one-worker',
    usedDevelopmentFallback: true,
  })
})

test('non-executing Cloud roles ignore worker isolation settings', () => {
  const policy = resolveCloudExecutionIsolationPolicy({
    deploymentTier: 'public_production',
    role: 'web',
    env: {
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'invalid-for-a-worker',
      OPEN_COWORK_CLOUD_ISOLATION_NETWORK_POLICY: 'invalid-for-a-worker',
    },
  })
  assert.equal(policy.required, false)
  assert.equal(policy.mode, 'development-process')
  assert.deepEqual(policy.blockers, [])
})

test('Cloud execution isolation rejects unknown modes and incomplete restricted egress', () => {
  assert.throws(() => resolveCloudExecutionIsolationPolicy({
    deploymentTier: 'public_production',
    role: 'worker',
    env: {
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'maybe',
    },
  }), /Invalid OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE/)

  const policy = sandboxPolicy({
    OPEN_COWORK_CLOUD_ISOLATION_NETWORK_POLICY: 'restricted',
  })
  assert.equal(policy.blockers.includes('sandbox_network_name_missing'), true)
  assert.equal(policy.blockers.includes('sandbox_egress_policy_id_missing'), true)

  const invalidCommand = sandboxPolicy({
    OPEN_COWORK_CLOUD_ISOLATION_OPENCODE_BIN: '../opencode',
  })
  assert.equal(invalidCommand.blockers.includes('sandbox_opencode_command_invalid'), true)
})

test('Cloud Knowledge runtime registration requires feature, policy, and reachable transport', () => {
  const base = {
    knowledgeEnabled: true,
    allowedTools: null,
    allowedMcps: null,
    isolationMode: 'sandbox' as const,
    networkPolicy: 'restricted' as const,
  }
  assert.equal(cloudKnowledgeRuntimeEligible(base), true)
  assert.equal(cloudKnowledgeRuntimeEligible({
    ...base,
    knowledgeEnabled: false,
  }), false)
  assert.equal(cloudKnowledgeRuntimeEligible({
    ...base,
    allowedTools: [],
  }), false)
  assert.equal(cloudKnowledgeRuntimeEligible({
    ...base,
    allowedMcps: [],
  }), false)
  assert.equal(cloudKnowledgeRuntimeEligible({
    ...base,
    networkPolicy: 'deny-all',
  }), false)
  assert.equal(cloudKnowledgeRuntimeEligible({
    ...base,
    isolationMode: 'development-process',
    networkPolicy: 'deny-all',
  }), true)
})

test('external execution isolation requires an injected verified provider without Docker blockers', async () => {
  const policy = resolveCloudExecutionIsolationPolicy({
    deploymentTier: 'public_production',
    role: 'worker',
    env: {
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'external-provider',
    },
  })
  assert.equal(policy.mode, 'external-provider')
  assert.equal(policy.engine, null)
  assert.equal(policy.componentManifest, null)
  assert.deepEqual(policy.blockers, [])
  assert.throws(
    () => assertCloudExecutionIsolationCapability(
      policy,
      developmentProcessIsolationCapability(),
    ),
    CloudExecutionIsolationError,
  )
  assert.doesNotThrow(() => assertCloudExecutionIsolationCapability(policy, {
    provider: 'kubernetes-workload',
    available: true,
    verified: true,
    engine: 'external',
    processIsolation: 'external-boundary',
    userIsolation: 'external-identity',
    mountScope: 'execution',
    runtimeHomeScope: 'execution',
    descendantCleanup: 'provider-owned',
    networkPolicy: 'deny-all',
    reasonCode: 'external_capability_verified',
  }))

  await assert.rejects(() => startCloudApp({
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_DEPLOYMENT_TIER: 'local',
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'external-provider',
      OPEN_COWORK_CLOUD_WORKER_ID: 'external-provider-test-worker',
    },
  }), (error: unknown) => (
    error instanceof CloudExecutionIsolationError
    && error.reasonCode === 'external_isolation_provider_missing'
  ))
})

test('Cloud startup releases an exclusive isolation claim when later startup fails', async () => {
  let claimed = false
  let capabilityCalls = 0
  let closeCalls = 0
  const provider = {
    name: 'startup-cleanup-test',
    async capability() {
      capabilityCalls += 1
      if (claimed) {
        return {
          provider: 'startup-cleanup-test',
          available: false,
          verified: false,
          engine: 'external' as const,
          processIsolation: 'external-boundary' as const,
          userIsolation: 'external-identity' as const,
          mountScope: 'unverified' as const,
          runtimeHomeScope: 'unverified' as const,
          descendantCleanup: 'provider-owned' as const,
          networkPolicy: 'deny-all' as const,
          reasonCode: 'sandbox_worker_owner_active',
        }
      }
      claimed = true
      return {
        provider: 'startup-cleanup-test',
        available: true,
        verified: true,
        engine: 'external' as const,
        processIsolation: 'external-boundary' as const,
        userIsolation: 'external-identity' as const,
        mountScope: 'execution' as const,
        runtimeHomeScope: 'execution' as const,
        descendantCleanup: 'provider-owned' as const,
        networkPolicy: 'deny-all' as const,
        reasonCode: 'external_capability_verified',
      }
    },
    async provision() {
      throw new Error('Startup must fail before runtime provisioning.')
    },
    async close() {
      closeCalls += 1
      claimed = false
    },
  }
  const start = () => startCloudApp({
    executionIsolationProvider: provider,
    storeFactory() {
      throw new Error('synthetic store startup failure')
    },
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'external-provider',
      OPEN_COWORK_CLOUD_WORKER_ID: 'startup-cleanup-worker',
    },
  })

  await assert.rejects(start, /synthetic store startup failure/)
  assert.equal(claimed, false)
  await assert.rejects(start, /synthetic store startup failure/)
  assert.equal(claimed, false)
  assert.equal(capabilityCalls, 2)
  assert.equal(closeCalls, 2)
})

test('external isolation rejects a per-boundary attestation that weakens the declared contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-external-attestation-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const byokSecrets = createByokSecretStore(
    store,
    createEnvelopeSecretAdapter('external-attestation-test-key'),
  )
  const isolationPolicy = resolveCloudExecutionIsolationPolicy({
    deploymentTier: 'public_production',
    role: 'worker',
    env: {
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'external-provider',
    },
  })
  let closed = 0
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets,
    isolationPolicy,
    isolationProvider: {
      name: 'synthetic-external',
      async capability() {
        throw new Error('Worker adapter must consume the startup-verified provider.')
      },
      async provision() {
        return {
          adapter: {
            async promptSession() {},
            async abortSession() {},
          },
          attestation: {
            format: CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
            boundaryId: 'external-boundary',
            establishedAt: new Date().toISOString(),
            provider: 'synthetic-external',
            available: true,
            verified: true,
            engine: 'external',
            processIsolation: 'external-boundary',
            userIsolation: 'external-identity',
            mountScope: 'execution',
            runtimeHomeScope: 'execution',
            descendantCleanup: 'provider-owned',
            networkPolicy: 'restricted',
            reasonCode: 'external_capability_verified',
          },
          async close() {
            closed += 1
          },
        }
      },
    },
    runtimeFactory() {
      throw new Error('External provider owns runtime creation.')
    },
  })

  try {
    await assert.rejects(() => runtime.promptSession({
      sessionId: 'native-session',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-a' },
    }), CloudExecutionIsolationError)
    assert.equal(closed, 1)
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('sandbox provider establishes a private runtime boundary and tears it down idempotently', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-cloud-isolation-'))
  const basePaths = createCloudPathProvider(root)
  const context = { tenantId: 'tenant-a', sessionId: 'session-a' }
  const paths = createCloudSessionPathProvider(basePaths, context.tenantId, context.sessionId)
  const workspace = paths.resolveWorkspacePath(context.tenantId, context.sessionId)
  mkdirSync(join(workspace, '.opencode', 'plugins'), { recursive: true })
  mkdirSync(join(workspace, '.opencode', 'agents'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'Trusted project instructions.\n')
  writeFileSync(join(workspace, 'opencode.json'), JSON.stringify({
    permission: { bash: 'allow' },
    agent: { build: { permission: { bash: 'allow' } } },
  }))
  writeFileSync(
    join(workspace, '.opencode', 'plugins', 'project-override.js'),
    'throw new Error("project plugin must not load")\n',
  )
  writeFileSync(
    join(workspace, '.opencode', 'agents', 'project-override.md'),
    '---\ndescription: Project override\npermission:\n  bash: allow\n---\nOverride.\n',
  )
  const calls: Array<{ command: string, args: string[] }> = []
  let runtimeRunArgs: string[] = []
  let observedEnvFile: string | null = null
  let knowledgeTransportProbes = 0
  let knowledgeTransportAvailable = true
  let readinessPermissionEffect: 'allow' | 'deny' = 'deny'

  const readinessServer = createServer((req, res) => {
    if (respondToSandboxReadinessProbe(req, res, readinessPermissionEffect)) return
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolveListen) => readinessServer.listen(0, '127.0.0.1', resolveListen))
  const address = readinessServer.address()
  assert.ok(address && typeof address !== 'string')

  const runner: SandboxRuntimeCommandRunner = {
    async run(command, args) {
      calls.push({ command, args: [...args] })
      if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
      if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
      if (args[0] === 'image') {
        return {
          exitCode: 0,
          stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}`,
        }
      }
      if (args[0] === 'network') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Internal: true,
            Labels: {
              'open-cowork.isolation': 'true',
              'open-cowork.egress_policy': 'knowledge-only-v1',
            },
          }),
        }
      }
      if (args[0] === 'run') {
        runtimeRunArgs = [...args]
        const workspaceMount = args.flatMap((arg, index) => (
          arg === '--mount' ? [args[index + 1] || ''] : []
        )).find((mount) => mount.includes('dst=/workspace,') || mount.endsWith('dst=/workspace'))
        const workspaceSource = workspaceMount
          ?.split(',')
          .find((part) => part.startsWith('src='))
          ?.slice(4)
        assert.ok(workspaceSource)
        // Docker creates a missing nested bind-mount destination on the host.
        writeFileSync(join(workspaceSource, 'opencode.jsonc'), '')
        const envIndex = args.indexOf('--env-file')
        assert.ok(envIndex >= 0)
        const path = args[envIndex + 1]!
        observedEnvFile = readFileSync(path, 'utf8')
        assert.equal(statSync(path).mode & 0o777, 0o600)
        return { exitCode: 0, stdout: 'container-id' }
      }
      if (args[0] === 'port') {
        return { exitCode: 0, stdout: `127.0.0.1:${address.port}` }
      }
      if (args[0] === 'inspect' && args[2] === '{{json .}}') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(fakeBoundaryInspection(runtimeRunArgs, args.at(-1) || '')),
        }
      }
      if (args[0] === 'inspect') return { exitCode: 0, stdout: 'true' }
      if (args[0] === 'exec') {
        knowledgeTransportProbes += 1
        return { exitCode: knowledgeTransportAvailable ? 0 : 1 }
      }
      if (args[0] === 'stop' || args[0] === 'rm') return { exitCode: 0 }
      return { exitCode: 1, stderr: 'unexpected fake command' }
    },
  }

  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy({
      OPEN_COWORK_CLOUD_ISOLATION_NETWORK_POLICY: 'restricted',
      OPEN_COWORK_CLOUD_ISOLATION_NETWORK_NAME: 'open-cowork-egress',
      OPEN_COWORK_CLOUD_ISOLATION_EGRESS_POLICY_ID: 'knowledge-only-v1',
    }),
    workerId: 'sandbox-boundary-test-worker',
    runtimeRootPath: root,
    runner,
    startupTimeoutMs: 2_000,
    async controlBridgeFactory() {
      return {
        url: `http://127.0.0.1:${address.port}`,
        async close() {},
      }
    },
  })

  try {
    const boundary = await provider.provision({
      paths,
      policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
      }),
      env: {
        OPEN_COWORK_KNOWLEDGE_TOOL_URL: 'https://knowledge.example.test/api/knowledge/agent',
        OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN: 'synthetic-boundary-token',
        OPEN_COWORK_CLOUD_CONTROL_PLANE_URL: 'postgres://control-plane-secret',
        OPEN_COWORK_CLOUD_SECRET_KEY: 'synthetic-control-plane-key',
        HTTPS_PROXY: 'http://operator:synthetic-proxy-credential@proxy.example.test',
        ALL_PROXY: 'socks5://operator:synthetic-all-proxy-secret@proxy.example.test',
        PATH: '/host/operator-only/bin',
        USER: 'synthetic-host-identity',
        SSL_CERT_FILE: '/host/operator-only/ca.pem',
        UNRELATED_HOST_SECRET: 'must-not-cross-boundary',
      },
      config: DEFAULT_CONFIG,
      execution: context,
      runtimeConfig: {
        $schema: 'https://opencode.ai/config.json',
        permission: { '*': 'deny' },
        provider: {
          example: {
            name: 'Example',
            npm: '@ai-sdk/openai-compatible',
            options: { apiKey: 'synthetic-fixture-secret' },
          },
        },
      },
    })

    assert.equal(boundary.attestation.verified, true)
    assert.equal(boundary.attestation.mountScope, 'execution')
    assert.equal(boundary.attestation.runtimeHomeScope, 'execution')
    assert.equal(boundary.attestation.networkPolicy, 'restricted')
    assert.ok(observedEnvFile)
    assert.match(observedEnvFile!, /OPENCODE_SERVER_PASSWORD=/)
    assert.match(observedEnvFile!, /OPENCODE_DISABLE_PROJECT_CONFIG=1/)
    assert.match(
      observedEnvFile!,
      /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/,
    )
    assert.match(observedEnvFile!, /OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN=synthetic-boundary-token/)
    assert.doesNotMatch(observedEnvFile!, /synthetic-fixture-secret/)
    assert.doesNotMatch(observedEnvFile!, /control-plane-secret/)
    assert.doesNotMatch(observedEnvFile!, /synthetic-control-plane-key/)
    assert.doesNotMatch(observedEnvFile!, /synthetic-proxy-credential/)
    assert.doesNotMatch(observedEnvFile!, /synthetic-all-proxy-secret/)
    assert.doesNotMatch(observedEnvFile!, /host\/operator-only/)
    assert.doesNotMatch(observedEnvFile!, /synthetic-host-identity/)
    assert.doesNotMatch(observedEnvFile!, /must-not-cross-boundary/)
    const managedConfig = JSON.parse(readFileSync(
      join(paths.getRuntimeXdgRoots().configHome, 'opencode', 'opencode.json'),
      'utf8',
    )) as { instructions?: string[], permission?: { bash?: string } }
    assert.deepEqual(managedConfig.instructions, ['/workspace/AGENTS.md'])
    assert.equal(managedConfig.permission?.bash, undefined)

    const run = calls.find((call) => call.args[0] === 'run')
    assert.ok(run)
    assert.equal(run.args.includes('--read-only'), true)
    assert.equal(run.args.includes('--init'), true)
    assert.equal(run.args.includes('--pids-limit'), true)
    assert.equal(run.args.includes('open-cowork-egress'), true)
    assert.equal(
      run.args[run.args.indexOf('--entrypoint') + 1],
      '/app/node_modules/.pnpm/node_modules/.bin/opencode',
    )
    assert.equal(
      run.args.some((arg) => arg === `type=bind,src=${root},dst=${CONTAINER_ROOT_SENTINEL}`),
      false,
    )
    const mountArguments = run.args.flatMap((arg, index) => (
      arg === '--mount' ? [run.args[index + 1] || ''] : []
    ))
    const configMasks = [
      ['/workspace/opencode.json', false],
      ['/workspace/opencode.jsonc', false],
      ['/workspace/.opencode', true],
    ] as const
    for (const [target, directory] of configMasks) {
      const mount = mountArguments.find((entry) => (
        entry.includes(`dst=${target},`) || entry.endsWith(`dst=${target}`)
      ))
      assert.ok(mount, `expected managed workspace mask for ${target}`)
      assert.match(mount, /,readonly$/)
      const source = mount.split(',').find((part) => part.startsWith('src='))?.slice(4)
      assert.ok(source)
      const sourceStat = statSync(source)
      assert.equal(sourceStat.mode & 0o077, 0)
      assert.equal(sourceStat.isDirectory(), directory)
      if (!directory) assert.equal(readFileSync(source, 'utf8'), '{}\n')
    }
    assert.equal(
      JSON.parse(readFileSync(join(workspace, 'opencode.json'), 'utf8')).permission.bash,
      'allow',
    )
    assert.throws(() => statSync(join(workspace, 'opencode.jsonc')))
    assert.equal(knowledgeTransportProbes, 1)

    await boundary.close()
    await boundary.close()
    assert.throws(() => statSync(paths.getRuntimeHomeDir()))
    assert.equal(calls.filter((call) => call.args[0] === 'rm').length, 1)

    await t.test('V2 readiness rejects a widened permission verdict before admission', async () => {
      readinessPermissionEffect = 'allow'
      const deniedContext = { tenantId: 'tenant-a', sessionId: 'session-v2-widened' }
      const deniedPaths = createCloudSessionPathProvider(
        basePaths,
        deniedContext.tenantId,
        deniedContext.sessionId,
      )
      await assert.rejects(() => provider.provision({
        paths: deniedPaths,
        policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
          OPEN_COWORK_CLOUD_ROLE: 'worker',
          OPEN_COWORK_CLOUD_PROFILE: 'full',
        }),
        env: {},
        config: DEFAULT_CONFIG,
        execution: deniedContext,
        runtimeConfig: { permission: { '*': 'deny' } },
      }), (error: unknown) => (
        error instanceof CloudExecutionIsolationError
        && error.reasonCode === 'sandbox_runtime_v2_permission_unverified'
      ))
      assert.throws(() => statSync(deniedPaths.getRuntimeHomeDir()))
    })

    await t.test('Knowledge transport failure keeps the boundary out of service', async () => {
      readinessPermissionEffect = 'deny'
      knowledgeTransportAvailable = false
      const deniedContext = { tenantId: 'tenant-a', sessionId: 'session-knowledge-unreachable' }
      const deniedPaths = createCloudSessionPathProvider(
        basePaths,
        deniedContext.tenantId,
        deniedContext.sessionId,
      )
      await assert.rejects(() => provider.provision({
        paths: deniedPaths,
        policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
          OPEN_COWORK_CLOUD_ROLE: 'worker',
          OPEN_COWORK_CLOUD_PROFILE: 'full',
        }),
        env: {
          OPEN_COWORK_KNOWLEDGE_TOOL_URL: 'https://knowledge.example.test/api/knowledge/agent',
          OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN: 'synthetic-unreachable-token',
        },
        config: DEFAULT_CONFIG,
        execution: deniedContext,
        runtimeConfig: { permission: { '*': 'deny' } },
      }), (error: unknown) => (
        error instanceof CloudExecutionIsolationError
        && error.reasonCode === 'sandbox_knowledge_transport_unavailable'
      ))
      assert.throws(() => statSync(deniedPaths.getRuntimeHomeDir()))
    })

    readinessPermissionEffect = 'deny'
    knowledgeTransportAvailable = true
    const providerCloseContext = {
      tenantId: 'tenant-a',
      sessionId: 'session-provider-close',
    }
    const providerClosePaths = createCloudSessionPathProvider(
      basePaths,
      providerCloseContext.tenantId,
      providerCloseContext.sessionId,
    )
    const liveBoundary = await provider.provision({
      paths: providerClosePaths,
      policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
      }),
      env: {},
      config: DEFAULT_CONFIG,
      execution: providerCloseContext,
      runtimeConfig: { permission: { '*': 'deny' } },
    })
    const removalsBeforeProviderClose = calls.filter(
      (call) => call.args[0] === 'rm',
    ).length
    await provider.close?.()
    assert.throws(() => statSync(providerClosePaths.getRuntimeHomeDir()))
    assert.equal(
      calls.filter((call) => call.args[0] === 'rm').length,
      removalsBeforeProviderClose + 1,
    )
    await liveBoundary.close()
    assert.equal(
      calls.filter((call) => call.args[0] === 'rm').length,
      removalsBeforeProviderClose + 1,
    )
  } finally {
    await provider.close?.()
    await new Promise<void>((resolveClose, reject) => {
      readinessServer.close((error) => error ? reject(error) : resolveClose())
    })
    rmSync(root, { recursive: true, force: true })
  }
})

// A deliberately impossible target used only to prove the broad Cloud root is
// never mounted as a single source. Exact per-execution descendants are allowed.
const CONTAINER_ROOT_SENTINEL = '/cloud-root'

test('restricted sandbox capability requires labels and an enforceable internal network', async () => {
  const policy = sandboxPolicy({
    OPEN_COWORK_CLOUD_ISOLATION_NETWORK_POLICY: 'restricted',
    OPEN_COWORK_CLOUD_ISOLATION_NETWORK_NAME: 'open-cowork-egress',
    OPEN_COWORK_CLOUD_ISOLATION_EGRESS_POLICY_ID: 'model-api-only-v1',
  })
  let providerSequence = 0
  function providerForNetwork(inspection: {
    Internal: boolean
    Labels: Record<string, string>
  }) {
    providerSequence += 1
    return createSandboxCloudExecutionIsolationProvider({
      policy,
      workerId: `sandbox-network-test-worker-${providerSequence}`,
      runtimeRootPath: tmpdir(),
      runner: {
        async run(_command, args) {
          if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
          if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
          if (args[0] === 'image') {
            return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
          }
          if (args[0] === 'network') {
            return { exitCode: 0, stdout: JSON.stringify(inspection) }
          }
          return { exitCode: 1 }
        },
      },
    })
  }
  const correctlyLabeled = {
    'open-cowork.isolation': 'true',
    'open-cowork.egress_policy': 'model-api-only-v1',
  }
  const labelOnly = await providerForNetwork({
    Internal: false,
    Labels: correctlyLabeled,
  }).capability()
  const wrongPolicy = await providerForNetwork({
    Internal: true,
    Labels: {
      ...correctlyLabeled,
      'open-cowork.egress_policy': 'wrong-policy',
    },
  }).capability()
  const enforced = await providerForNetwork({
    Internal: true,
    Labels: correctlyLabeled,
  }).capability()

  assert.equal(labelOnly.available, false)
  assert.equal(labelOnly.reasonCode, 'sandbox_network_policy_unverified')
  assert.equal(wrongPolicy.available, false)
  assert.equal(enforced.available, true)
  assert.equal(enforced.verified, true)
  assert.throws(
    () => assertCloudExecutionIsolationCapability(policy, labelOnly),
    CloudExecutionIsolationError,
  )
})

test('sandbox readiness rejects a root worker before Docker discovery or launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-root-worker-isolation-'))
  const runnerCalls: string[][] = []
  let ownerClaims = 0
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId: 'root-worker-test',
    runtimeRootPath: root,
    runtimeIdentity: { uid: 0, gid: 0 },
    ownerLease: {
      async claim() {
        ownerClaims += 1
        return { owned: true, reasonCode: 'sandbox_worker_owner_claimed' }
      },
      async close() {},
    },
    runner: {
      async run(_command, args) {
        runnerCalls.push([...args])
        return { exitCode: 0 }
      },
    },
  })
  const context = { tenantId: 'tenant-a', sessionId: 'session-a' }
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    context.tenantId,
    context.sessionId,
  )

  try {
    const capability = await provider.capability()
    assert.equal(capability.available, false)
    assert.equal(capability.verified, false)
    assert.equal(capability.reasonCode, 'sandbox_runtime_user_not_non_root')
    await assert.rejects(() => provider.provision({
      paths,
      policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
      }),
      env: {},
      config: DEFAULT_CONFIG,
      execution: context,
      runtimeConfig: {},
    }), (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'sandbox_runtime_user_not_non_root'
    ))
    assert.deepEqual(runnerCalls, [])
    assert.equal(ownerClaims, 0)
  } finally {
    await provider.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('closed sandbox provider rejects new capability and provision admission before Docker access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-closed-isolation-provider-'))
  const runnerCalls: string[][] = []
  let ownerLeaseCloseCalls = 0
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId: 'closed-provider-test-worker',
    runtimeRootPath: root,
    runtimeIdentity: { uid: 1000, gid: 1000 },
    ownerLease: {
      async claim() {
        return { owned: true, reasonCode: 'sandbox_worker_owner_claimed' }
      },
      async close() {
        ownerLeaseCloseCalls += 1
      },
    },
    runner: {
      async run(_command, args) {
        runnerCalls.push([...args])
        return { exitCode: 1 }
      },
    },
  })
  const context = { tenantId: 'tenant-a', sessionId: 'session-a' }
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    context.tenantId,
    context.sessionId,
  )

  try {
    await provider.close?.()
    await assert.rejects(() => provider.capability(), (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'sandbox_provider_closing'
    ))
    await assert.rejects(() => provider.provision({
      paths,
      policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
      }),
      env: {},
      config: DEFAULT_CONFIG,
      execution: context,
      runtimeConfig: {},
    }), (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'sandbox_provider_closing'
    ))
    assert.equal(ownerLeaseCloseCalls, 1)
    assert.deepEqual(runnerCalls, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sandbox startup reclaims only live boundaries owned by the stable worker hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-worker-orphan-sweep-'))
  const basePaths = createCloudPathProvider(root)
  const ownedPaths = createCloudSessionPathProvider(basePaths, 'tenant-a', 'owned-session')
  const otherPaths = createCloudSessionPathProvider(basePaths, 'tenant-b', 'other-session')
  const privateRoots = (paths: typeof ownedPaths) => {
    const xdg = paths.getRuntimeXdgRoots()
    return [
      paths.getRuntimeHomeDir(),
      xdg.configHome,
      xdg.dataHome,
      xdg.stateHome,
      xdg.cacheHome,
    ]
  }
  for (const path of [...privateRoots(ownedPaths), ...privateRoots(otherPaths)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  const ownedId = 'a'.repeat(64)
  const otherId = 'b'.repeat(64)
  const workerId = 'stable-worker-a'
  const ownerHash = sandboxWorkerOwnerHash(workerId, root)
  const removed: string[] = []
  const calls: string[][] = []
  const destinations = [
    '/runtime-home/home',
    '/runtime-home/xdg/config',
    '/runtime-home/xdg/data',
    '/runtime-home/xdg/state',
    '/runtime-home/xdg/cache',
  ]
  const mounts = privateRoots(ownedPaths).map((source, index) => ({
    Type: 'bind',
    Source: source,
    Destination: destinations[index],
    RW: true,
  }))
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId,
    runtimeRootPath: root,
    runner: {
      async run(_command, args) {
        calls.push([...args])
        if (args[0] === 'ps') return { exitCode: 0, stdout: `${ownedId}\n` }
        if (args[0] === 'inspect' && args[2] === '{{json .}}') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: ownedId,
              State: { Running: true },
              Config: {
                Labels: {
                  'open-cowork.sandbox': 'true',
                  'open-cowork.sandbox.worker_owner': ownerHash,
                  'open-cowork.sandbox.lease_id': 'c'.repeat(32),
                },
              },
              Mounts: mounts,
            }),
          }
        }
        if (args[0] === 'rm' && args[1] === '--force') {
          removed.push(args[2] || '')
          return { exitCode: 0 }
        }
        if (args[0] === 'inspect' && args[2] === '{{.Id}}') {
          return { exitCode: 1, stderr: 'No such container' }
        }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
        }
        return { exitCode: 1 }
      },
    },
  })

  try {
    const capability = await provider.capability()
    assert.equal(capability.verified, true)
    assert.deepEqual(removed, [ownedId])
    assert.equal(removed.includes(otherId), false)
    for (const path of privateRoots(ownedPaths)) assert.throws(() => statSync(path))
    for (const path of privateRoots(otherPaths)) assert.equal(statSync(path).isDirectory(), true)
    const discovery = calls.find((args) => args[0] === 'ps')
    assert.ok(discovery)
    assert.equal(
      discovery.includes(`label=open-cowork.sandbox.worker_owner=${ownerHash}`),
      true,
    )
    assert.equal(discovery.some((arg) => arg.includes(workerId)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sandbox worker ownership is disjoint across canonical runtime roots', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'open-cowork-owner-root-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'open-cowork-owner-root-b-'))
  try {
    assert.notEqual(
      sandboxWorkerOwnerHash('duplicate-worker-id', realpathSync(rootA)),
      sandboxWorkerOwnerHash('duplicate-worker-id', realpathSync(rootB)),
    )
  } finally {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})

test('a duplicate live sandbox owner cannot sweep its peer boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-live-owner-peer-'))
  const workerId = 'duplicate-live-worker'
  const ownerHash = sandboxWorkerOwnerHash(workerId, realpathSync(root))
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    'tenant-peer',
    'session-peer',
  )
  const xdg = paths.getRuntimeXdgRoots()
  const privateRoots = [
    paths.getRuntimeHomeDir(),
    xdg.configHome,
    xdg.dataHome,
    xdg.stateHome,
    xdg.cacheHome,
  ]
  for (const path of privateRoots) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  const destinations = [
    '/runtime-home/home',
    '/runtime-home/xdg/config',
    '/runtime-home/xdg/data',
    '/runtime-home/xdg/state',
    '/runtime-home/xdg/cache',
  ]
  const peerId = 'e'.repeat(64)
  const removed: string[] = []
  let peerVisible = false
  const runner: SandboxRuntimeCommandRunner = {
    async run(_command, args) {
      if (args[0] === 'ps') {
        return { exitCode: 0, stdout: peerVisible ? `${peerId}\n` : '' }
      }
      if (args[0] === 'inspect' && args[2] === '{{json .}}') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Id: peerId,
            State: { Running: true },
            Config: {
              Labels: {
                'open-cowork.sandbox': 'true',
                'open-cowork.sandbox.worker_owner': ownerHash,
                'open-cowork.sandbox.lease_id': 'd'.repeat(32),
              },
            },
            Mounts: privateRoots.map((source, index) => ({
              Type: 'bind',
              Source: source,
              Destination: destinations[index],
              RW: true,
            })),
          }),
        }
      }
      if (args[0] === 'rm' && args[1] === '--force') {
        removed.push(args[2] || '')
        return { exitCode: 0 }
      }
      if (args[0] === 'inspect' && args[2] === '{{.Id}}') {
        return { exitCode: 1, stderr: 'No such container' }
      }
      if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
      if (args[0] === 'image') {
        return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
      }
      return { exitCode: 1 }
    },
  }
  const firstProvider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId,
    runtimeRootPath: root,
    runner,
    ownerLease: {
      async claim() {
        return { owned: true, reasonCode: 'sandbox_worker_owner_claimed' }
      },
      async close() {},
    },
  })
  const duplicateProvider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId,
    runtimeRootPath: root,
    runner,
    ownerLease: {
      async claim() {
        return { owned: false, reasonCode: 'sandbox_worker_owner_active' }
      },
      async close() {},
    },
  })

  try {
    assert.equal((await firstProvider.capability()).available, true)
    peerVisible = true
    const duplicateCapability = await duplicateProvider.capability()
    assert.equal(duplicateCapability.available, false)
    assert.equal(duplicateCapability.reasonCode, 'sandbox_worker_owner_active')
    assert.deepEqual(removed, [])
    for (const path of privateRoots) assert.equal(statSync(path).isDirectory(), true)
  } finally {
    await duplicateProvider.close?.()
    await firstProvider.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('sandbox provider rejects launched boundaries whose live Docker state differs from policy', async () => {
  for (const mismatch of ['image', 'mount', 'rootfs', 'network'] as const) {
    const root = mkdtempSync(join(tmpdir(), `open-cowork-boundary-${mismatch}-`))
    const context = { tenantId: 'tenant-a', sessionId: `session-${mismatch}` }
    const paths = createCloudSessionPathProvider(
      createCloudPathProvider(root),
      context.tenantId,
      context.sessionId,
    )
    let runtimeRunArgs: string[] = []
    let teardownCalls = 0
    let networkInspections = 0
    const provider = createSandboxCloudExecutionIsolationProvider({
      policy: mismatch === 'network'
        ? sandboxPolicy({
            OPEN_COWORK_CLOUD_ISOLATION_NETWORK_POLICY: 'restricted',
            OPEN_COWORK_CLOUD_ISOLATION_NETWORK_NAME: 'open-cowork-egress',
            OPEN_COWORK_CLOUD_ISOLATION_EGRESS_POLICY_ID: 'model-api-only-v1',
          })
        : sandboxPolicy(),
      workerId: `sandbox-${mismatch}-test-worker`,
      runtimeRootPath: root,
      runner: {
        async run(_command, args) {
          if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
          if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
          if (args[0] === 'image') {
            return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
          }
          if (args[0] === 'run') {
            runtimeRunArgs = [...args]
            return { exitCode: 0, stdout: 'container-id' }
          }
          if (args[0] === 'network') {
            networkInspections += 1
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Internal: networkInspections === 1,
                Labels: {
                  'open-cowork.isolation': 'true',
                  'open-cowork.egress_policy': 'model-api-only-v1',
                },
              }),
            }
          }
          if (args[0] === 'inspect' && args[2] === '{{json .}}') {
            const inspection = fakeBoundaryInspection(runtimeRunArgs, args.at(-1) || '')
            if (mismatch === 'image') inspection.Image = `sha256:${'b'.repeat(64)}`
            if (mismatch === 'mount') {
              inspection.Mounts.push({
                Type: 'bind',
                Source: join(root, 'unexpected'),
                Destination: '/unexpected',
                RW: true,
              })
            }
            if (mismatch === 'rootfs') inspection.HostConfig.ReadonlyRootfs = false
            return { exitCode: 0, stdout: JSON.stringify(inspection) }
          }
          if (args[0] === 'stop' || args[0] === 'rm') {
            teardownCalls += 1
            return { exitCode: 0 }
          }
          return { exitCode: 1 }
        },
      },
    })

    await assert.rejects(() => provider.provision({
      paths,
      policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
      }),
      env: {},
      config: DEFAULT_CONFIG,
      execution: context,
      runtimeConfig: {},
    }), (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'sandbox_boundary_attestation_failed'
      && !error.message.includes(root)
    ))
    assert.ok(teardownCalls >= 2)
    if (mismatch === 'network') assert.equal(networkInspections, 2)
    assert.throws(() => statSync(paths.getRuntimeHomeDir()))
    rmSync(root, { recursive: true, force: true })
  }
})

test('sandbox provider owns failed-provision orphan cleanup and stays unavailable until it succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-boundary-orphan-'))
  const context = { tenantId: 'tenant-a', sessionId: 'session-orphan' }
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    context.tenantId,
    context.sessionId,
  )
  let runtimeRunArgs: string[] = []
  let teardownFails = true
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId: 'sandbox-orphan-test-worker',
    runtimeRootPath: root,
    orphanCleanupRetryMs: 10,
    runner: {
      async run(_command, args) {
        if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
        }
        if (args[0] === 'run') {
          runtimeRunArgs = [...args]
          return { exitCode: 0, stdout: 'container-id' }
        }
        if (args[0] === 'inspect' && args[2] === '{{json .}}') {
          const inspection = fakeBoundaryInspection(runtimeRunArgs, args.at(-1) || '')
          inspection.HostConfig.ReadonlyRootfs = false
          return { exitCode: 0, stdout: JSON.stringify(inspection) }
        }
        if (args[0] === 'stop' || args[0] === 'rm') {
          return teardownFails
            ? { exitCode: 1, stderr: 'synthetic daemon failure' }
            : { exitCode: 0 }
        }
        return { exitCode: 1 }
      },
    },
  })

  await assert.rejects(() => provider.provision({
    paths,
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    execution: context,
    runtimeConfig: {},
  }), (error: unknown) => (
    error instanceof CloudExecutionIsolationError
    && error.reasonCode === 'sandbox_runtime_teardown_failed'
  ))
  assert.doesNotThrow(() => statSync(paths.getRuntimeHomeDir()))
  assert.equal((await provider.capability()).reasonCode, 'sandbox_orphan_cleanup_pending')

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
  assert.equal((await provider.capability()).available, false)
  assert.doesNotThrow(() => statSync(paths.getRuntimeHomeDir()))

  teardownFails = false
  const deadline = Date.now() + 2_000
  while (!(await provider.capability()).available && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.equal((await provider.capability()).available, true)
  assert.throws(() => statSync(paths.getRuntimeHomeDir()))
  rmSync(root, { recursive: true, force: true })
})

test('sandbox provider owns private-runtime cleanup debt after a stopped failed launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-boundary-cleanup-debt-'))
  const context = { tenantId: 'tenant-a', sessionId: 'session-cleanup-debt' }
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    context.tenantId,
    context.sessionId,
  )
  let cleanupFails = true
  let cleanupAttempts = 0
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId: 'sandbox-cleanup-debt-test-worker',
    runtimeRootPath: root,
    orphanCleanupRetryMs: 10,
    cleanupPrivateRuntimePaths(input) {
      cleanupAttempts += 1
      if (cleanupFails) throw new Error('synthetic private path cleanup failure')
      const xdg = input.paths.getRuntimeXdgRoots()
      for (const path of [
        input.paths.getRuntimeHomeDir(),
        xdg.configHome,
        xdg.dataHome,
        xdg.stateHome,
        xdg.cacheHome,
      ]) {
        rmSync(path, { recursive: true, force: true })
      }
    },
    runner: {
      async run(_command, args) {
        if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
        }
        if (args[0] === 'run') return { exitCode: 1, stderr: 'synthetic launch failure' }
        if (args[0] === 'stop' || args[0] === 'rm') return { exitCode: 0 }
        return { exitCode: 1 }
      },
    },
  })

  await assert.rejects(() => provider.provision({
    paths,
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    execution: context,
    runtimeConfig: {},
  }), (error: unknown) => (
    error instanceof CloudExecutionIsolationError
    && error.reasonCode === 'sandbox_private_runtime_cleanup_failed'
  ))
  assert.equal(cleanupAttempts, 1)
  assert.doesNotThrow(() => statSync(paths.getRuntimeHomeDir()))
  assert.equal((await provider.capability()).reasonCode, 'sandbox_orphan_cleanup_pending')

  cleanupFails = false
  const deadline = Date.now() + 2_000
  while (!(await provider.capability()).available && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.equal((await provider.capability()).available, true)
  assert.ok(cleanupAttempts >= 2)
  assert.throws(() => statSync(paths.getRuntimeHomeDir()))
  rmSync(root, { recursive: true, force: true })
})

test('sandbox capability binds mutable image tags to the declared and inspected digest', async () => {
  const policy = sandboxPolicy()
  const imageSource = policy.componentManifest?.components[0]?.source
  assert.equal(imageSource, `docker://open-cowork/opencode@${IMAGE_DIGEST}`)
  let inspectedImage = ''
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy,
    workerId: 'sandbox-image-test-worker',
    runtimeRootPath: tmpdir(),
    runner: {
      async run(_command, args) {
        if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          inspectedImage = args.at(-1) || ''
          return {
            exitCode: 0,
            stdout: `sha256:${'b'.repeat(64)}|open-cowork/opencode@sha256:${'b'.repeat(64)}`,
          }
        }
        return { exitCode: 1 }
      },
    },
  })

  const capability = await provider.capability()
  assert.equal(inspectedImage, `open-cowork/opencode@${IMAGE_DIGEST}`)
  assert.equal(capability.verified, false)
  assert.equal(capability.reasonCode, 'sandbox_runtime_image_unverified')
})

test('sandbox capability accepts an immutable local Docker image id without RepoDigests', async () => {
  const imageId = `sha256:${'d'.repeat(64)}`
  const policy = sandboxPolicy({
    OPEN_COWORK_CLOUD_ISOLATION_IMAGE: imageId,
    OPEN_COWORK_CLOUD_ISOLATION_IMAGE_SHA256: imageId,
  })
  assert.equal(
    policy.componentManifest?.components[0]?.source,
    `docker://${imageId}`,
  )
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy,
    workerId: 'sandbox-local-image-test-worker',
    runtimeRootPath: tmpdir(),
    runner: {
      async run(_command, args) {
        if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          assert.equal(args.at(-1), imageId)
          return { exitCode: 0, stdout: `${imageId}|` }
        }
        return { exitCode: 1 }
      },
    },
  })

  const capability = await provider.capability()
  assert.equal(capability.available, true)
  assert.equal(capability.verified, true)
})

test('sandbox provisioning removes crash-stale private symlinks before writing fresh credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-stale-private-'))
  const context = { tenantId: 'tenant-a', sessionId: 'session-stale-private' }
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    context.tenantId,
    context.sessionId,
  )
  const workspace = paths.resolveWorkspacePath(
    context.tenantId,
    context.sessionId,
  )
  const leakTarget = join(workspace, 'captured-boundary.env')
  const workspaceSentinel = join(workspace, 'keep.txt')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(leakTarget, 'unchanged\n')
  writeFileSync(workspaceSentinel, 'workspace survives\n')
  mkdirSync(paths.getRuntimeHomeDir(), { recursive: true })
  symlinkSync(
    leakTarget,
    join(paths.getRuntimeHomeDir(), '.open-cowork-boundary.env'),
  )
  const restoredCheckpoint = join(
    paths.getRuntimeXdgRoots().dataHome,
    'opencode',
    'restored-checkpoint.json',
  )
  let restoredAtLaunch: string | null = null

  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId: 'sandbox-stale-private-test-worker',
    runtimeRootPath: root,
    runner: {
      async run(_command, args) {
        if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
        }
        if (args[0] === 'run') {
          restoredAtLaunch = readFileSync(restoredCheckpoint, 'utf8')
          return { exitCode: 1, stderr: 'synthetic launch failure' }
        }
        if (args[0] === 'stop' || args[0] === 'rm') return { exitCode: 0 }
        return { exitCode: 1 }
      },
    },
  })
  const input = {
    paths,
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    execution: context,
    runtimeConfig: {},
  }

  try {
    assert.ok(provider.prepareProvision)
    const preparation = await provider.prepareProvision(input)
    mkdirSync(join(restoredCheckpoint, '..'), { recursive: true })
    writeFileSync(restoredCheckpoint, '{"restored":true}\n')

    await assert.rejects(
      () => provider.provision(input),
      CloudExecutionIsolationError,
    )
    await preparation.release()

    assert.equal(restoredAtLaunch, '{"restored":true}\n')
    assert.equal(readFileSync(leakTarget, 'utf8'), 'unchanged\n')
    assert.equal(readFileSync(workspaceSentinel, 'utf8'), 'workspace survives\n')
    assert.equal(statSync(workspace).isDirectory(), true)
    assert.throws(() => statSync(paths.getRuntimeHomeDir()))
  } finally {
    await provider.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('sandbox provider close removes abandoned prepared roots without touching workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-abandoned-prepare-'))
  const context = { tenantId: 'tenant-a', sessionId: 'session-abandoned-prepare' }
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    context.tenantId,
    context.sessionId,
  )
  const workspace = paths.resolveWorkspacePath(
    context.tenantId,
    context.sessionId,
  )
  const workspaceSentinel = join(workspace, 'keep.txt')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(workspaceSentinel, 'workspace survives\n')
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId: 'sandbox-abandoned-prepare-test-worker',
    runtimeRootPath: root,
    runner: {
      async run(_command, args) {
        if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
        }
        return { exitCode: 1 }
      },
    },
  })
  const input = {
    paths,
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    execution: context,
    runtimeConfig: {},
  }

  try {
    assert.ok(provider.prepareProvision)
    const preparation = await provider.prepareProvision(input)
    const restoredCheckpoint = join(
      paths.getRuntimeXdgRoots().dataHome,
      'opencode',
      'restored-checkpoint.json',
    )
    mkdirSync(join(restoredCheckpoint, '..'), { recursive: true })
    writeFileSync(restoredCheckpoint, '{"restored":true}\n')

    await provider.close?.()
    await preparation.release()

    assert.throws(() => statSync(paths.getRuntimeHomeDir()))
    assert.equal(readFileSync(workspaceSentinel, 'utf8'), 'workspace survives\n')
    assert.equal(statSync(workspace).isDirectory(), true)
  } finally {
    await provider.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('sandbox provisioning failure removes partial runtime and credential artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-failure-'))
  const context = { tenantId: 'tenant-a', sessionId: 'session-failure' }
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    context.tenantId,
    context.sessionId,
  )
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId: 'sandbox-failure-test-worker',
    runtimeRootPath: root,
    runner: {
      async run(_command, args) {
        if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
        }
        if (args[0] === 'run') return { exitCode: 1, stderr: 'synthetic launch failure' }
        if (args[0] === 'stop' || args[0] === 'rm') return { exitCode: 0 }
        return { exitCode: 1 }
      },
    },
  })

  await assert.rejects(() => provider.provision({
    paths,
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    execution: context,
    runtimeConfig: {
      provider: {
        example: {
          name: 'Example',
          npm: '@ai-sdk/openai-compatible',
          options: { apiKey: 'synthetic-failed-secret' },
        },
      },
    },
  }), CloudExecutionIsolationError)

  assert.throws(() => statSync(paths.getRuntimeHomeDir()))
  assert.throws(() => statSync(paths.getRuntimeXdgRoots().dataHome))
  rmSync(root, { recursive: true, force: true })
})

test('sandbox teardown failure is redacted, observable, and retryable without deleting live credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-teardown-'))
  const context = { tenantId: 'tenant-a', sessionId: 'session-teardown' }
  const paths = createCloudSessionPathProvider(
    createCloudPathProvider(root),
    context.tenantId,
    context.sessionId,
  )
  let teardownFails = true
  let privateCleanupFails = true
  let runtimeRunArgs: string[] = []
  let ownerLeaseCloseCalls = 0
  const readinessServer = createServer((req, res) => {
    if (respondToSandboxReadinessProbe(req, res)) return
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolveListen) => readinessServer.listen(0, '127.0.0.1', resolveListen))
  const address = readinessServer.address()
  assert.ok(address && typeof address !== 'string')
  const provider = createSandboxCloudExecutionIsolationProvider({
    policy: sandboxPolicy(),
    workerId: 'sandbox-teardown-test-worker',
    runtimeRootPath: root,
    startupTimeoutMs: 2_000,
    ownerLease: {
      async claim() {
        return { owned: true, reasonCode: 'sandbox_worker_owner_claimed' }
      },
      async close() {
        ownerLeaseCloseCalls += 1
      },
    },
    cleanupPrivateRuntimePaths(input) {
      if (privateCleanupFails) throw new Error('synthetic private cleanup failure')
      const xdg = input.paths.getRuntimeXdgRoots()
      for (const path of [
        input.paths.getRuntimeHomeDir(),
        xdg.configHome,
        xdg.dataHome,
        xdg.stateHome,
        xdg.cacheHome,
      ]) {
        rmSync(path, { recursive: true, force: true })
      }
    },
    async controlBridgeFactory() {
      return {
        url: `http://127.0.0.1:${address.port}`,
        async close() {},
      }
    },
    runner: {
      async run(_command, args) {
        if (args[0] === 'ps') return { exitCode: 0, stdout: '' }
        if (args[0] === 'version') return { exitCode: 0, stdout: '27.1.0' }
        if (args[0] === 'image') {
          return { exitCode: 0, stdout: `${IMAGE_DIGEST}|open-cowork/opencode@${IMAGE_DIGEST}` }
        }
        if (args[0] === 'run') {
          runtimeRunArgs = [...args]
          return { exitCode: 0, stdout: 'container-id' }
        }
        if (args[0] === 'port') return { exitCode: 0, stdout: `127.0.0.1:${address.port}` }
        if (args[0] === 'inspect' && args[2] === '{{json .}}') {
          return {
            exitCode: 0,
            stdout: JSON.stringify(fakeBoundaryInspection(runtimeRunArgs, args.at(-1) || '')),
          }
        }
        if (args[0] === 'inspect') return { exitCode: 0, stdout: 'true' }
        if (args[0] === 'stop' || args[0] === 'rm') {
          return teardownFails
            ? { exitCode: 1, stderr: 'synthetic daemon failure' }
            : { exitCode: 0 }
        }
        return { exitCode: 1 }
      },
    },
  })

  try {
    const boundary = await provider.provision({
      paths,
      policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
      }),
      env: {},
      config: DEFAULT_CONFIG,
      execution: context,
      runtimeConfig: {
        permission: { '*': 'deny' },
        provider: {
          example: {
            name: 'Example',
            npm: '@ai-sdk/openai-compatible',
            options: { apiKey: 'synthetic-live-boundary-secret' },
          },
        },
      },
    })

    await assert.rejects(
      () => boundary.close(),
      (error: unknown) => (
        error instanceof CloudExecutionIsolationError
        && error.reasonCode === 'sandbox_runtime_teardown_failed'
        && !error.message.includes('tenant-a')
        && !error.message.includes('synthetic-live-boundary-secret')
      ),
    )
    assert.doesNotThrow(() => statSync(paths.getRuntimeHomeDir()))
    assert.doesNotThrow(() => statSync(paths.getRuntimeXdgRoots().dataHome))
    assert.equal((await provider.capability()).reasonCode, 'sandbox_orphan_cleanup_pending')
    await assert.rejects(() => provider.close?.(), (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'sandbox_provider_cleanup_residue'
    ))
    assert.equal(ownerLeaseCloseCalls, 0)

    teardownFails = false
    await assert.rejects(
      () => boundary.close(),
      (error: unknown) => (
        error instanceof CloudExecutionIsolationError
        && error.reasonCode === 'sandbox_private_runtime_cleanup_failed'
      ),
    )
    assert.doesNotThrow(() => statSync(paths.getRuntimeHomeDir()))

    privateCleanupFails = false
    await boundary.close()
    assert.throws(() => statSync(paths.getRuntimeHomeDir()))
    await provider.close?.()
    assert.equal(ownerLeaseCloseCalls, 1)
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      readinessServer.close((error) => error ? reject(error) : resolveClose())
    })
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker prepares isolation before checkpoint restore and releases failed preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-prepare-order-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const order: string[] = []
  let provisioned = 0
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets: createByokSecretStore(
      store,
      createEnvelopeSecretAdapter('prepare-order-test-key'),
    ),
    async prepareProvision() {
      order.push('checkpoint-restore')
      throw new Error('synthetic checkpoint restore failure')
    },
    isolationProvider: {
      name: 'prepare-order-test',
      async capability() {
        return developmentProcessIsolationCapability()
      },
      async prepareProvision() {
        order.push('isolation-prepare')
        return {
          async release() {
            order.push('isolation-release')
          },
        }
      },
      async provision() {
        provisioned += 1
        throw new Error('provision must not run after restore failure')
      },
      async close() {
        order.push('provider-close')
      },
    },
    runtimeFactory() {
      throw new Error('Synthetic provider owns runtime creation.')
    },
  })

  try {
    await assert.rejects(
      () => runtime.promptSession({
        sessionId: 'native-session',
        parts: [],
        agent: 'build',
        context: { tenantId: 'tenant-a', sessionId: 'session-a' },
      }),
      /synthetic checkpoint restore failure/,
    )
    assert.equal(provisioned, 0)
    assert.deepEqual(order, [
      'isolation-prepare',
      'checkpoint-restore',
      'isolation-release',
    ])
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('unexpected runtime exit evicts and tears down the complete boundary before reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-exit-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const byokSecrets = createByokSecretStore(
    store,
    createEnvelopeSecretAdapter('unexpected-exit-isolation-test-key'),
  )
  const unexpectedExits: Array<() => void> = []
  let provisioned = 0
  let closed = 0
  const restored: string[] = []
  let credentialPath = ''
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets,
    async prepareProvision(input) {
      restored.push(input.execution.sessionId)
    },
    runtimeFactory(input) {
      provisioned += 1
      unexpectedExits.push(input.onUnexpectedExit!)
      credentialPath = join(input.paths.getRuntimeHomeDir(), 'synthetic-credential')
      mkdirSync(input.paths.getRuntimeHomeDir(), { recursive: true })
      writeFileSync(credentialPath, 'synthetic', { mode: 0o600 })
      return {
        async createSession() {
          return {
            id: 'native-session',
            title: 'Native session',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession() {},
        async abortSession() {},
        async close() {
          closed += 1
          rmSync(input.paths.getRuntimeHomeDir(), { recursive: true, force: true })
        },
      }
    },
  })

  try {
    const prompt = {
      sessionId: 'native-session',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-a' },
    }
    await runtime.promptSession(prompt)
    assert.equal(provisioned, 1)
    assert.deepEqual(restored, ['session-a'])
    assert.equal(unexpectedExits.length, 1)
    unexpectedExits[0]!()
    const deadline = Date.now() + 2_000
    while (closed === 0 && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    assert.equal(closed, 1)
    assert.throws(() => statSync(credentialPath))

    await runtime.promptSession(prompt)
    assert.equal(provisioned, 2)
    assert.deepEqual(restored, ['session-a', 'session-a'])
    unexpectedExits[0]!()
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    await runtime.promptSession(prompt)
    assert.equal(provisioned, 2)
    assert.equal(closed, 1)
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent admission for one tenant session provisions and owns exactly one boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-concurrent-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const byokSecrets = createByokSecretStore(
    store,
    createEnvelopeSecretAdapter('concurrent-isolation-test-key'),
  )
  let provisioned = 0
  let closed = 0
  const restored: string[] = []
  let releaseProvision!: () => void
  const provisionGate = new Promise<void>((resolveProvision) => {
    releaseProvision = resolveProvision
  })
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets,
    async prepareProvision(input) {
      restored.push(input.execution.sessionId)
    },
    async runtimeFactory() {
      provisioned += 1
      await provisionGate
      return {
        async createSession() {
          return {
            id: 'native-session',
            title: 'Native session',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession() {},
        async abortSession() {},
        async close() {
          closed += 1
        },
      }
    },
  })
  const prompt = {
    sessionId: 'native-session',
    parts: [],
    agent: 'build',
    context: { tenantId: 'tenant-a', sessionId: 'session-a' },
  }

  try {
    const first = runtime.promptSession(prompt)
    const second = runtime.promptSession(prompt)
    while (provisioned === 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    }
    assert.equal(provisioned, 1)
    releaseProvision()
    await Promise.all([first, second])
    assert.equal(provisioned, 1)
    assert.deepEqual(restored, ['session-a'])
  } finally {
    releaseProvision()
    await runtime.close?.()
    assert.equal(closed, 1)
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent callers wait until the shared runtime event subscription is ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-subscribe-ready-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const byokSecrets = createByokSecretStore(
    store,
    createEnvelopeSecretAdapter('subscribe-ready-test-key'),
  )
  let subscriptionStarted = false
  let promptCalls = 0
  let provisioned = 0
  let releaseSubscription!: () => void
  const subscriptionGate = new Promise<void>((resolveSubscription) => {
    releaseSubscription = resolveSubscription
  })
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets,
    runtimeFactory() {
      provisioned += 1
      return {
        async promptSession() {
          promptCalls += 1
        },
        async abortSession() {},
        async subscribeEvents() {
          subscriptionStarted = true
          await subscriptionGate
          return () => undefined
        },
        async close() {},
      }
    },
  })
  await runtime.subscribeEvents?.(() => undefined)
  const prompt = {
    sessionId: 'native-session',
    parts: [],
    agent: 'build',
    context: { tenantId: 'tenant-a', sessionId: 'session-a' },
  }

  try {
    const first = runtime.promptSession(prompt)
    while (!subscriptionStarted) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    }
    const second = runtime.promptSession(prompt)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    assert.equal(provisioned, 1)
    assert.equal(promptCalls, 0)
    releaseSubscription()
    await Promise.all([first, second])
    assert.equal(promptCalls, 2)
  } finally {
    releaseSubscription()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('unexpected exit during event subscription prevents publishing a dead generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-subscribe-exit-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const unexpectedExits: Array<() => void> = []
  let subscriptionStarted = false
  let promptCalls = 0
  let provisioned = 0
  let closed = 0
  let releaseSubscription!: () => void
  const subscriptionGate = new Promise<void>((resolveSubscription) => {
    releaseSubscription = resolveSubscription
  })
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets: createByokSecretStore(
      store,
      createEnvelopeSecretAdapter('subscribe-exit-test-key'),
    ),
    runtimeFactory(input) {
      provisioned += 1
      const generation = provisioned
      unexpectedExits.push(input.onUnexpectedExit!)
      return {
        async promptSession() {
          promptCalls += 1
        },
        async abortSession() {},
        async subscribeEvents() {
          if (generation === 1) {
            subscriptionStarted = true
            await subscriptionGate
          }
          return () => undefined
        },
        async close() {
          closed += 1
        },
      }
    },
  })
  await runtime.subscribeEvents?.(() => undefined)
  const prompt = {
    sessionId: 'native-session',
    parts: [],
    agent: 'build',
    context: { tenantId: 'tenant-a', sessionId: 'session-a' },
  }

  try {
    const first = runtime.promptSession(prompt)
    while (!subscriptionStarted) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    }
    unexpectedExits[0]!()
    releaseSubscription()
    await assert.rejects(first, (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'cloud_runtime_boundary_unexpected_exit'
    ))
    assert.equal(closed, 1)
    assert.equal(promptCalls, 0)

    await runtime.promptSession(prompt)
    assert.equal(provisioned, 2)
    assert.equal(promptCalls, 1)
  } finally {
    releaseSubscription()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('unexpected exit during publication metrics never returns a dead generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-publish-exit-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const unexpectedExits: Array<() => void> = []
  let provisioned = 0
  let closed = 0
  let publicationMetricBlocked = false
  let publicationMetricStartedResolve!: () => void
  const publicationMetricStarted = new Promise<void>((resolveStarted) => {
    publicationMetricStartedResolve = resolveStarted
  })
  let releasePublicationMetric!: () => void
  const publicationMetricGate = new Promise<void>((resolveMetric) => {
    releasePublicationMetric = resolveMetric
  })
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets: createByokSecretStore(
      store,
      createEnvelopeSecretAdapter('publish-exit-test-key'),
    ),
    observability: {
      log() {},
      span() {},
      async metric(record) {
        if (
          record.name === 'open_cowork_cloud_runtime_cache_entries'
          && record.value === 1
          && !publicationMetricBlocked
        ) {
          publicationMetricBlocked = true
          publicationMetricStartedResolve()
          await publicationMetricGate
        }
      },
    },
    runtimeFactory(input) {
      provisioned += 1
      unexpectedExits.push(input.onUnexpectedExit!)
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          closed += 1
        },
      }
    },
  })
  const prompt = {
    sessionId: 'native-session',
    parts: [],
    agent: 'build',
    context: { tenantId: 'tenant-a', sessionId: 'session-a' },
  }

  try {
    const first = runtime.promptSession(prompt)
    await publicationMetricStarted
    unexpectedExits[0]!()
    releasePublicationMetric()
    await assert.rejects(first, (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'cloud_runtime_boundary_unexpected_exit'
    ))
    const closeDeadline = Date.now() + 2_000
    while (closed === 0 && Date.now() < closeDeadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    }
    assert.equal(closed, 1)

    await runtime.promptSession(prompt)
    assert.equal(provisioned, 2)
  } finally {
    releasePublicationMetric()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker blocks replacement admission while an external boundary has cleanup debt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-external-cleanup-debt-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const byokSecrets = createByokSecretStore(
    store,
    createEnvelopeSecretAdapter('external-cleanup-debt-test-key'),
  )
  let closeFails = true
  let closeAttempts = 0
  let provisioned = 0
  let unexpectedExit: (() => void) | undefined
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets,
    isolationProvider: {
      name: 'synthetic-external-cleanup-debt',
      async capability() {
        return developmentProcessIsolationCapability()
      },
      async provision(input) {
        provisioned += 1
        unexpectedExit = input.onUnexpectedExit
        return {
          adapter: {
            async promptSession() {},
            async abortSession() {},
          },
          attestation: {
            ...developmentProcessIsolationCapability(),
            format: CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
            boundaryId: `external-cleanup-${provisioned}`,
            establishedAt: new Date().toISOString(),
          },
          async close() {
            closeAttempts += 1
            if (closeFails) throw new Error('synthetic external teardown failure')
          },
        }
      },
    },
    runtimeFactory() {
      throw new Error('Synthetic isolation provider owns runtime creation.')
    },
  })
  const prompt = {
    sessionId: 'native-session',
    parts: [],
    agent: 'build',
    context: { tenantId: 'tenant-a', sessionId: 'session-a' },
  }

  try {
    await runtime.promptSession(prompt)
    assert.ok(unexpectedExit)
    unexpectedExit!()
    const deadline = Date.now() + 2_000
    while (closeAttempts === 0 && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    }
    assert.equal(closeAttempts, 1)
    await assert.rejects(() => runtime.promptSession({
      ...prompt,
      context: { tenantId: 'tenant-a', sessionId: 'session-b' },
    }), (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'cloud_runtime_boundary_cleanup_pending'
    ))
    assert.equal(provisioned, 1)
  } finally {
    closeFails = false
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('coalesced provisioning failure closes once, clears pending state, and can retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-concurrent-failure-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const byokSecrets = createByokSecretStore(
    store,
    createEnvelopeSecretAdapter('concurrent-isolation-failure-test-key'),
  )
  let provisioned = 0
  let closed = 0
  const restored: string[] = []
  let failSubscription = true
  let releaseProvision!: () => void
  const provisionGate = new Promise<void>((resolveProvision) => {
    releaseProvision = resolveProvision
  })
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets,
    async prepareProvision(input) {
      restored.push(input.execution.sessionId)
    },
    isolationProvider: {
      name: 'synthetic-coalescing',
      async capability() {
        return developmentProcessIsolationCapability()
      },
      async provision() {
        provisioned += 1
        if (provisioned === 1) await provisionGate
        return {
          adapter: {
            async promptSession() {},
            async abortSession() {},
            async subscribeEvents() {
              if (failSubscription) throw new Error('synthetic subscription failure')
              return () => undefined
            },
          },
          attestation: {
            ...developmentProcessIsolationCapability(),
            format: CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
            boundaryId: `synthetic-${provisioned}`,
            establishedAt: new Date().toISOString(),
          },
          async close() {
            closed += 1
          },
        }
      },
    },
    runtimeFactory() {
      throw new Error('Synthetic isolation provider owns runtime creation.')
    },
  })
  await runtime.subscribeEvents?.(() => undefined)
  const prompt = {
    sessionId: 'native-session',
    parts: [],
    agent: 'build',
    context: { tenantId: 'tenant-a', sessionId: 'session-a' },
  }

  try {
    const first = runtime.promptSession(prompt)
    const second = runtime.promptSession(prompt)
    while (provisioned === 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    }
    releaseProvision()
    const failed = await Promise.allSettled([first, second])
    assert.equal(failed.every((result) => result.status === 'rejected'), true)
    assert.equal(provisioned, 1)
    assert.equal(closed, 1)
    assert.deepEqual(restored, ['session-a'])

    failSubscription = false
    await runtime.promptSession(prompt)
    assert.equal(provisioned, 2)
    assert.deepEqual(restored, ['session-a', 'session-a'])
  } finally {
    releaseProvision()
    await runtime.close?.()
    assert.equal(closed, 2)
    rmSync(root, { recursive: true, force: true })
  }
})

test('execution scope pins one boundary through checkpoint save and acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-checkpoint-scope-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const byokSecrets = createByokSecretStore(
    store,
    createEnvelopeSecretAdapter('checkpoint-scope-test-key'),
  )
  const order: string[] = []
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets,
    maxRuntimeEntries: 1,
    runtimeIdleTtlMs: 60_000,
    async prepareProvision(input) {
      order.push(`restore:${input.execution.sessionId}`)
    },
    runtimeFactory(input) {
      const scopedSessionId = input.execution.sessionId
      order.push(`provision:${scopedSessionId}`)
      return {
        async promptSession() {
          order.push(`execute:${scopedSessionId}`)
          if (scopedSessionId === 'session-a') {
            return {
              events: [{
                type: 'session.idle' as const,
                payload: { sessionId: 'native-session' },
              }],
            }
          }
        },
        async abortSession() {},
        async subscribeEvents() {
          return () => undefined
        },
        async close() {
          order.push(`teardown:${scopedSessionId}`)
        },
      }
    },
  })
  const context = { tenantId: 'tenant-a', sessionId: 'session-a' }

  try {
    await runtime.withExecutionScope!(context, async () => {
      await runtime.promptSession({
        sessionId: 'native-session',
        parts: [],
        agent: 'build',
        context,
      })
      await runtime.promptSession({
        sessionId: 'native-secondary',
        parts: [],
        agent: 'build',
        context: { tenantId: 'tenant-a', sessionId: 'session-b' },
      })
      order.push('checkpoint-save')
      order.push('command-ack')
    })
    assert.deepEqual(order, [
      'restore:session-a',
      'provision:session-a',
      'execute:session-a',
      'restore:session-b',
      'provision:session-b',
      'execute:session-b',
      'checkpoint-save',
      'command-ack',
      'teardown:session-a',
    ])
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('unexpected exit defers teardown and replacement until checkpoint scope acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-crash-checkpoint-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const unexpectedExits: Array<() => void> = []
  const order: string[] = []
  let provisioned = 0
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets: createByokSecretStore(
      store,
      createEnvelopeSecretAdapter('crash-checkpoint-scope-test-key'),
    ),
    async prepareProvision() {
      order.push('restore')
    },
    runtimeFactory(input) {
      provisioned += 1
      const generation = provisioned
      unexpectedExits.push(input.onUnexpectedExit!)
      order.push(`provision:${generation}`)
      return {
        async promptSession() {
          order.push(`execute:${generation}`)
        },
        async abortSession() {},
        async close() {
          order.push(`teardown:${generation}`)
        },
      }
    },
  })
  const context = { tenantId: 'tenant-a', sessionId: 'session-a' }
  const prompt = {
    sessionId: 'native-session',
    parts: [],
    agent: 'build',
    context,
  }
  let replacementPrompt: Promise<unknown> | null = null

  try {
    await runtime.withExecutionScope!(context, async () => {
      await runtime.promptSession(prompt)
      unexpectedExits[0]!()
      order.push('checkpoint-save')
      replacementPrompt = Promise.resolve(runtime.promptSession(prompt))
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
      assert.equal(provisioned, 1)
      assert.equal(order.includes('teardown:1'), false)
      order.push('command-ack')
    })
    assert.ok(replacementPrompt)
    await replacementPrompt
    assert.equal(provisioned, 2)
    assert.deepEqual(order, [
      'restore',
      'provision:1',
      'execute:1',
      'checkpoint-save',
      'command-ack',
      'teardown:1',
      'restore',
      'provision:2',
      'execute:2',
    ])
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('adapter close waits for an in-flight crash teardown before releasing the provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-crash-close-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const order: string[] = []
  let unexpectedExit: (() => void) | undefined
  let releaseBoundaryClose!: () => void
  const boundaryCloseGate = new Promise<void>((resolveClose) => {
    releaseBoundaryClose = resolveClose
  })
  let boundaryCloseStartedResolve!: () => void
  const boundaryCloseStarted = new Promise<void>((resolveStarted) => {
    boundaryCloseStartedResolve = resolveStarted
  })
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets: createByokSecretStore(
      store,
      createEnvelopeSecretAdapter('crash-close-test-key'),
    ),
    isolationProvider: {
      name: 'crash-close-test',
      async capability() {
        return developmentProcessIsolationCapability()
      },
      async provision(input) {
        unexpectedExit = input.onUnexpectedExit
        return {
          adapter: {
            async promptSession() {},
            async abortSession() {},
          },
          attestation: {
            ...developmentProcessIsolationCapability(),
            format: CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
            boundaryId: 'crash-close-boundary',
            establishedAt: new Date().toISOString(),
          },
          async close() {
            order.push('boundary-close-start')
            boundaryCloseStartedResolve()
            await boundaryCloseGate
            order.push('boundary-close-finish')
          },
        }
      },
      async close() {
        order.push('provider-close')
      },
    },
    runtimeFactory() {
      throw new Error('Synthetic provider owns runtime creation.')
    },
  })
  const prompt = {
    sessionId: 'native-session',
    parts: [],
    agent: 'build',
    context: { tenantId: 'tenant-a', sessionId: 'session-a' },
  }

  try {
    await runtime.promptSession(prompt)
    unexpectedExit!()
    await boundaryCloseStarted
    const close = runtime.close!()
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    assert.deepEqual(order, ['boundary-close-start'])
    releaseBoundaryClose()
    await close
    assert.deepEqual(order, [
      'boundary-close-start',
      'boundary-close-finish',
      'provider-close',
    ])
  } finally {
    releaseBoundaryClose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('adapter close waits for an in-flight idle eviction before releasing the provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-isolation-eviction-close-'))
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  const order: string[] = []
  let releaseBoundaryClose!: () => void
  const boundaryCloseGate = new Promise<void>((resolveClose) => {
    releaseBoundaryClose = resolveClose
  })
  let boundaryCloseStartedResolve!: () => void
  const boundaryCloseStarted = new Promise<void>((resolveStarted) => {
    boundaryCloseStartedResolve = resolveStarted
  })
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets: createByokSecretStore(
      store,
      createEnvelopeSecretAdapter('eviction-close-test-key'),
    ),
    runtimeIdleTtlMs: 1,
    isolationProvider: {
      name: 'eviction-close-test',
      async capability() {
        return developmentProcessIsolationCapability()
      },
      async provision() {
        return {
          adapter: {
            async promptSession() {},
            async abortSession() {},
          },
          attestation: {
            ...developmentProcessIsolationCapability(),
            format: CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
            boundaryId: 'eviction-close-boundary',
            establishedAt: new Date().toISOString(),
          },
          async close() {
            order.push('boundary-close-start')
            boundaryCloseStartedResolve()
            await boundaryCloseGate
            order.push('boundary-close-finish')
          },
        }
      },
      async close() {
        order.push('provider-close')
      },
    },
    runtimeFactory() {
      throw new Error('Synthetic provider owns runtime creation.')
    },
  })

  try {
    await runtime.promptSession({
      sessionId: 'native-session',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-a' },
    })
    let sweepDeadline: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        boundaryCloseStarted,
        new Promise<never>((_resolve, reject) => {
          sweepDeadline = setTimeout(
            () => reject(new Error('idle eviction did not start before the deadline')),
            2_000,
          )
        }),
      ])
    } finally {
      if (sweepDeadline) clearTimeout(sweepDeadline)
    }
    const close = runtime.close!()
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    assert.deepEqual(order, ['boundary-close-start'])
    releaseBoundaryClose()
    await close
    assert.deepEqual(order, [
      'boundary-close-start',
      'boundary-close-finish',
      'provider-close',
    ])
  } finally {
    releaseBoundaryClose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker runtime close owns provider shutdown exactly once and propagates errors', async () => {
  const makeRuntime = (
    root: string,
    order: string[],
    failProviderClose = false,
  ) => {
    const store = new InMemoryControlPlaneStore()
    store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
    return createWorkerScopedRuntimeAdapter({
      paths: createCloudPathProvider(root),
      policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
        OPEN_COWORK_CLOUD_ROLE: 'worker',
        OPEN_COWORK_CLOUD_PROFILE: 'full',
      }),
      env: {},
      config: DEFAULT_CONFIG,
      byokSecrets: createByokSecretStore(
        store,
        createEnvelopeSecretAdapter('provider-close-test-key'),
      ),
      isolationProvider: {
        name: 'provider-close-test',
        async capability() {
          return developmentProcessIsolationCapability()
        },
        async provision() {
          return {
            adapter: {
              async promptSession() {},
              async abortSession() {},
            },
            attestation: {
              ...developmentProcessIsolationCapability(),
              format: CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
              boundaryId: 'provider-close-boundary',
              establishedAt: new Date().toISOString(),
            },
            async close() {
              order.push('boundary-close')
            },
          }
        },
        async close() {
          order.push('provider-close')
          if (failProviderClose) throw new Error('synthetic provider close failure')
        },
      },
      runtimeFactory() {
        throw new Error('Synthetic provider owns runtime creation.')
      },
    })
  }

  const successRoot = mkdtempSync(join(tmpdir(), 'open-cowork-provider-close-'))
  const successOrder: string[] = []
  const successRuntime = makeRuntime(successRoot, successOrder)
  try {
    await successRuntime.promptSession({
      sessionId: 'native-session',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-a' },
    })
    const firstClose = successRuntime.close!()
    const duplicateClose = successRuntime.close!()
    assert.equal(firstClose, duplicateClose)
    await firstClose
    assert.deepEqual(successOrder, ['boundary-close', 'provider-close'])
  } finally {
    rmSync(successRoot, { recursive: true, force: true })
  }

  const failureRoot = mkdtempSync(join(tmpdir(), 'open-cowork-provider-close-error-'))
  const failureOrder: string[] = []
  const failureRuntime = makeRuntime(failureRoot, failureOrder, true)
  try {
    const firstClose = failureRuntime.close!()
    const duplicateClose = failureRuntime.close!()
    assert.equal(firstClose, duplicateClose)
    await assert.rejects(firstClose, (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'sandbox_runtime_teardown_failed'
      && !error.message.includes('synthetic provider close failure')
    ))
    await assert.rejects(duplicateClose, CloudExecutionIsolationError)
    assert.deepEqual(failureOrder, ['provider-close'])
  } finally {
    rmSync(failureRoot, { recursive: true, force: true })
  }
})
