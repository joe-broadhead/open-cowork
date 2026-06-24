import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  buildPortableRuntimeManifest,
  checkSandboxRuntimeEngine,
  createSandboxRuntimeLaunchPlan,
  isRuntimeSnapshotSecretBearingPath,
  planSandboxPolicy,
  readSandboxRuntimeStatus,
  SANDBOX_COMPONENT_MANIFEST_FORMAT,
  runtimePathsForPortability,
  runSandboxRuntimeOneShot,
  runSandboxRuntimeSmoke,
  startSandboxRuntime,
  stopSandboxRuntime,
} from '@open-cowork/cloud-server/runtime-portability'

type RuntimePortabilityInput = Parameters<typeof createSandboxRuntimeLaunchPlan>[0]

test('runtime portability manifest inventories OpenCode XDG roots and Cowork runtime content', () => {
  const root = '/tmp/open-cowork-portability'
  const runtimePaths = runtimePathsForPortability({
    home: join(root, 'runtime-home'),
    configHome: join(root, 'runtime-home/.config'),
    dataHome: join(root, 'runtime-home/.local/share'),
    cacheHome: join(root, 'runtime-home/.cache'),
    stateHome: join(root, 'runtime-home/.local/state'),
  })

  const manifest = buildPortableRuntimeManifest({
    runtimePaths,
    workspaceDirs: [join(root, 'workspace')],
    artifactDirs: [join(root, 'chart-artifacts')],
    metadataPaths: [join(root, 'sessions.json')],
  })

  assert.deepEqual(
    manifest.map((entry) => entry.kind),
    [
      'opencode-config',
      'opencode-data',
      'opencode-state',
      'opencode-cache',
      'cowork-runtime-content',
      'cowork-runtime-content',
      'workspace',
      'artifact',
      'metadata',
    ],
  )
  assert.equal(manifest.find((entry) => entry.kind === 'opencode-cache')?.required, false)
  assert.equal(manifest.find((entry) => entry.kind === 'opencode-data')?.secretBearing, true)
  assert.equal(manifest.find((entry) => entry.path.endsWith('runtime-skill-catalog'))?.required, true)
})

test('runtime portability classifier flags secret-bearing snapshot paths', () => {
  assert.equal(isRuntimeSnapshotSecretBearingPath('/runtime-home/.local/share/opencode/auth.json'), true)
  assert.equal(isRuntimeSnapshotSecretBearingPath('/app-data/settings.enc'), true)
  assert.equal(isRuntimeSnapshotSecretBearingPath('/workspace/.env.production'), true)
  assert.equal(isRuntimeSnapshotSecretBearingPath('/Users/alice/.ssh/id_ed25519'), true)
  assert.equal(isRuntimeSnapshotSecretBearingPath('/workspace/report.csv'), false)
})

test('sandbox policy resolves verified components and allowlisted mounts', () => {
  const root = '/tmp/open-cowork-sandbox-policy'
  const plan = planSandboxPolicy({
    engine: 'docker',
    imageComponentId: 'opencode-runtime-image',
    helperComponentIds: ['runtime-helper'],
    allowedSourceRoots: [root],
    mounts: [{
      source: join(root, 'workspace'),
      target: '/workspace',
      mode: 'read-write',
      purpose: 'workspace',
    }],
    componentManifest: {
      format: SANDBOX_COMPONENT_MANIFEST_FORMAT,
      components: [
        {
          id: 'opencode-runtime-image',
          kind: 'image',
          source: 'docker://open-cowork/opencode:local',
          sha256: `sha256:${'a'.repeat(64)}`,
          verified: true,
        },
        {
          id: 'runtime-helper',
          kind: 'helper',
          source: '/opt/open-cowork/helper',
          signature: 'cosign:example-signature',
          verified: true,
        },
      ],
    },
  })

  assert.equal(plan.ok, true)
  assert.deepEqual(plan.components.map((component) => component.id), ['opencode-runtime-image', 'runtime-helper'])
})

test('sandbox policy blocks relative, secret, unallowlisted, and unverified inputs', () => {
  const root = '/tmp/open-cowork-sandbox-policy'
  const plan = planSandboxPolicy({
    engine: 'docker',
    imageComponentId: 'opencode-runtime-image',
    allowedSourceRoots: [root],
    mounts: [
      {
        source: 'relative-workspace',
        target: '/workspace',
        mode: 'read-write',
        purpose: 'workspace',
      },
      {
        source: join(root, '.ssh'),
        target: '/ssh',
        mode: 'read-only',
        purpose: 'metadata',
      },
      {
        source: '/private/outside',
        target: '/outside',
        mode: 'read-only',
        purpose: 'metadata',
      },
    ],
    componentManifest: {
      format: SANDBOX_COMPONENT_MANIFEST_FORMAT,
      components: [
        { id: 'opencode-runtime-image', kind: 'image', source: 'docker://open-cowork/opencode:local', verified: false },
      ],
    },
  })

  assert.equal(plan.ok, false)
  assert.equal(plan.blockers.some((blocker) => blocker.startsWith('sandbox-mount-source-not-absolute:relative-workspace')), true)
  assert.equal(plan.blockers.some((blocker) => blocker.startsWith('sandbox-mount-secret-bearing:')), true)
  assert.equal(plan.blockers.some((blocker) => blocker.startsWith('sandbox-mount-source-not-allowlisted:')), true)
  assert.equal(plan.blockers.includes('sandbox-component-unverified:opencode-runtime-image'), true)
})

test('sandbox policy requires component digest or signature evidence outside development override', () => {
  const root = '/tmp/open-cowork-sandbox-policy'
  const plan = planSandboxPolicy({
    engine: 'apple-container',
    imageComponentId: 'opencode-runtime-image',
    helperComponentIds: ['duplicate-helper'],
    allowedSourceRoots: [root],
    mounts: [{
      source: join(root, 'workspace'),
      target: '/workspace',
      mode: 'read-write',
      purpose: 'workspace',
    }],
    componentManifest: {
      format: SANDBOX_COMPONENT_MANIFEST_FORMAT,
      components: [
        {
          id: 'opencode-runtime-image',
          kind: 'image',
          source: 'oci://open-cowork/opencode:local',
          sha256: 'not-a-digest',
          verified: true,
        },
        {
          id: 'duplicate-helper',
          kind: 'helper',
          source: '/opt/open-cowork/helper',
          verified: true,
        },
        {
          id: 'duplicate-helper',
          kind: 'helper',
          source: '/opt/open-cowork/helper-copy',
          signature: 'cosign:example-signature',
          verified: true,
        },
      ],
    },
  })

  assert.equal(plan.ok, false)
  assert.equal(plan.blockers.includes('sandbox-component-sha256-invalid:opencode-runtime-image'), true)
  assert.equal(plan.blockers.includes('sandbox-component-provenance-missing:opencode-runtime-image'), true)
  assert.equal(plan.blockers.includes('sandbox-component-provenance-missing:duplicate-helper'), true)
  assert.equal(plan.blockers.includes('sandbox-component-duplicate:duplicate-helper'), true)
})

test('sandbox policy development override can bypass component trust only with a reason', () => {
  const root = '/tmp/open-cowork-sandbox-policy'
  const baseInput = {
    engine: 'docker' as const,
    imageComponentId: 'opencode-runtime-image',
    allowedSourceRoots: [root],
    mounts: [{
      source: join(root, 'workspace'),
      target: '/workspace',
      mode: 'read-write' as const,
      purpose: 'workspace' as const,
    }],
    componentManifest: {
      format: SANDBOX_COMPONENT_MANIFEST_FORMAT,
      components: [
        {
          id: 'opencode-runtime-image',
          kind: 'image' as const,
          source: 'docker://open-cowork/opencode:local',
          verified: false,
        },
      ],
    },
  }

  const withoutReason = planSandboxPolicy({
    ...baseInput,
    developmentOverride: { enabled: true },
  })
  const withReason = planSandboxPolicy({
    ...baseInput,
    developmentOverride: {
      enabled: true,
      reason: 'local unsigned sandbox image while packaging signatures are generated',
    },
  })

  assert.equal(withoutReason.ok, false)
  assert.equal(withoutReason.blockers.includes('sandbox-component-unverified:opencode-runtime-image'), true)
  assert.equal(withReason.ok, true)
  assert.equal(withReason.developmentOverride, true)
})

function sandboxLaunchInput(overrides: Partial<RuntimePortabilityInput> = {}): RuntimePortabilityInput {
  const root = '/tmp/open-cowork-sandbox-runtime'
  return {
    engine: 'docker',
    imageComponentId: 'opencode-runtime-image',
    runtimeId: 'roadmap-27-runtime',
    allowedSourceRoots: [root],
    mounts: [
      {
        source: join(root, 'workspace'),
        target: '/workspace',
        mode: 'read-write',
        purpose: 'workspace',
      },
      {
        source: join(root, 'metadata'),
        target: '/metadata',
        mode: 'read-only',
        purpose: 'metadata',
      },
    ],
    componentManifest: {
      format: SANDBOX_COMPONENT_MANIFEST_FORMAT,
      components: [
        {
          id: 'opencode-runtime-image',
          kind: 'image',
          source: 'docker://open-cowork/opencode:local',
          sha256: `sha256:${'b'.repeat(64)}`,
          verified: true,
        },
      ],
    },
    command: ['node', 'worker.js'],
    ...overrides,
  }
}

test('sandbox runtime launch plan builds hardened Docker command plans with redacted mount paths', () => {
  const input = sandboxLaunchInput()
  const plan = createSandboxRuntimeLaunchPlan(input)

  assert.equal(plan.ok, true)
  assert.equal(plan.runtimeId, 'roadmap-27-runtime')
  assert.equal(plan.image, 'open-cowork/opencode:local')
  assert.equal(plan.commands.start.command, 'docker')
  assert.deepEqual(plan.commands.status.args, ['inspect', '--format', '{{.State.Status}}', 'roadmap-27-runtime'])
  assert.deepEqual(plan.commands.stop.args, ['stop', 'roadmap-27-runtime'])
  assert.deepEqual(plan.commands.cleanup.args, ['rm', '-f', 'roadmap-27-runtime'])
  assert.equal(plan.commands.start.args.includes('--network'), true)
  assert.equal(plan.commands.start.args.includes('none'), true)
  assert.equal(plan.commands.start.args.includes('--security-opt'), true)
  assert.equal(plan.commands.start.args.includes('no-new-privileges'), true)
  assert.equal(plan.commands.start.args.includes('--cap-drop'), true)
  assert.equal(plan.commands.start.args.includes('ALL'), true)
  assert.equal(plan.commands.start.args.includes('--pull'), true)
  assert.equal(plan.commands.start.args.includes('never'), true)
  assert.equal(plan.commands.start.args.includes('--mount'), true)
  assert.equal(plan.commands.start.args.at(-3), 'open-cowork/opencode:local')
  assert.deepEqual(plan.commands.start.args.slice(-2), ['node', 'worker.js'])
  assert.equal(
    plan.commands.start.args.includes('type=bind,src=/tmp/open-cowork-sandbox-runtime/metadata,dst=/metadata,readonly'),
    true,
  )
  assert.equal(plan.commands.start.redactedArgs.some((arg) => arg.includes('/tmp/open-cowork-sandbox-runtime')), false)
  assert.equal(plan.commands.start.redactedArgs.some((arg) => arg.includes('[redacted-path]')), true)
})

test('sandbox runtime launch plan builds Apple Container command plans without weakening policy', () => {
  const input = sandboxLaunchInput({
    engine: 'apple-container',
    componentManifest: {
      format: SANDBOX_COMPONENT_MANIFEST_FORMAT,
      components: [
        {
          id: 'opencode-runtime-image',
          kind: 'image',
          source: 'oci://registry.example.com/open-cowork/opencode:local',
          signature: 'cosign:example-signature',
          verified: true,
        },
      ],
    },
  })

  const plan = createSandboxRuntimeLaunchPlan(input)

  assert.equal(plan.ok, true)
  assert.equal(plan.commands.start.command, 'container')
  assert.equal(plan.commands.start.args.includes('--network'), true)
  assert.equal(plan.commands.start.args.includes('none'), true)
  assert.equal(plan.commands.start.args.includes('--cap-drop'), true)
  assert.equal(plan.commands.start.args.includes('ALL'), true)
  assert.equal(
    plan.commands.start.args.includes('type=bind,source=/tmp/open-cowork-sandbox-runtime/metadata,target=/metadata,readonly'),
    true,
  )
  assert.equal(plan.commands.start.args.at(-3), 'registry.example.com/open-cowork/opencode:local')
  assert.deepEqual(plan.commands.status.args, ['inspect', 'roadmap-27-runtime'])
  assert.deepEqual(plan.commands.stop.args, ['stop', 'roadmap-27-runtime'])
  assert.deepEqual(plan.commands.cleanup.args, ['delete', 'roadmap-27-runtime'])
  assert.equal(plan.commands.start.redactedArgs.some((arg) => arg.includes('/tmp/open-cowork-sandbox-runtime')), false)
})

test('sandbox runtime launch plan fails closed for unsafe command inputs', () => {
  const input = sandboxLaunchInput({
    runtimeId: '../bad id',
    mounts: [{
      source: '/tmp/open-cowork-sandbox-runtime/work,space',
      target: '/workspace',
      mode: 'read-write',
      purpose: 'workspace',
    }],
    command: ['node', 'bad\0arg'],
  })

  const plan = createSandboxRuntimeLaunchPlan(input)

  assert.equal(plan.ok, false)
  assert.equal(plan.blockers.some((blocker) => blocker.startsWith('sandbox-mount-source-command-unsafe:')), true)
  assert.equal(plan.blockers.includes('sandbox-runtime-command-arg-invalid'), true)
  assert.equal(plan.commands.start.command, '')
})

test('sandbox runtime engine preflight reports available engines with redacted evidence', async () => {
  const result = await checkSandboxRuntimeEngine('docker', {
    async run(command, args) {
      assert.equal(command, 'docker')
      assert.deepEqual(args, ['version', '--format', '{{.Server.Version}}'])
      return { exitCode: 0, stdout: '27.1.1\n' }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.reasonCode, 'sandbox-runtime-engine-available')
  assert.equal(result.version, '27.1.1')
  assert.equal(result.redacted, true)
})

test('sandbox runtime engine preflight distinguishes missing engines from runtime command failures', async () => {
  const unavailable = await checkSandboxRuntimeEngine('docker', {
    async run() {
      return { exitCode: 1, stderr: 'spawn docker ENOENT' }
    },
  })
  const failed = await checkSandboxRuntimeEngine('apple-container', {
    async run(command, args) {
      assert.equal(command, 'container')
      assert.deepEqual(args, ['system', 'status'])
      return { exitCode: 2, stderr: 'container runtime health check failed' }
    },
  })

  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.reasonCode, 'sandbox-runtime-engine-unavailable')
  assert.equal(failed.ok, false)
  assert.equal(failed.reasonCode, 'sandbox-runtime-engine-check-failed')
})

test('sandbox runtime start refuses to invoke a runner when policy is blocked', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const result = await startSandboxRuntime(sandboxLaunchInput({
    componentManifest: null,
  }), {
    async run(command, args) {
      calls.push({ command, args })
      return { exitCode: 0 }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'sandbox-runtime-policy-blocked')
  assert.equal(result.state.status, 'failed')
  assert.deepEqual(calls, [])
})

test('sandbox runtime lifecycle uses injected runner and redacts command output', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const input = sandboxLaunchInput()
  const runner = {
    async run(command: string, args: string[]) {
      calls.push({ command, args })
      return {
        exitCode: 0,
        stdout: `ok /tmp/open-cowork-sandbox-runtime/workspace ${command}`,
      }
    },
  }

  const startResult = await startSandboxRuntime(input, runner)
  const statusResult = await readSandboxRuntimeStatus(startResult.plan, runner)
  const stopResult = await stopSandboxRuntime(startResult.plan, runner)

  assert.equal(startResult.ok, true)
  assert.equal(startResult.reasonCode, 'sandbox-runtime-started')
  assert.equal(startResult.state.status, 'running')
  assert.equal(startResult.state.output?.includes('/tmp/open-cowork-sandbox-runtime'), false)
  assert.equal(startResult.state.output?.includes('[redacted-path]'), true)
  assert.equal(statusResult.ok, true)
  assert.equal(statusResult.reasonCode, 'sandbox-runtime-status-read')
  assert.equal(stopResult.ok, true)
  assert.equal(stopResult.reasonCode, 'sandbox-runtime-stopped')
  assert.deepEqual(calls.map((call) => `${call.command} ${call.args[0]}`), [
    'docker run',
    'docker inspect',
    'docker stop',
    'docker rm',
  ])
})

test('sandbox runtime smoke runs start, status, and stop as one redacted evidence command', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const result = await runSandboxRuntimeSmoke(sandboxLaunchInput({
    command: ['opencode', 'run', '--print', 'hello'],
  }), {
    async run(command, args) {
      calls.push({ command, args })
      return { exitCode: 0, stdout: 'ok' }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.reasonCode, 'sandbox-runtime-smoke-passed')
  assert.equal(result.redacted, true)
  assert.deepEqual(result.events.map((event) => `${event.phase}:${event.reasonCode}:${event.status}`), [
    'start:sandbox-runtime-started:running',
    'status:sandbox-runtime-status-read:running',
    'stop:sandbox-runtime-stopped:stopped',
  ])
  assert.deepEqual(calls.map((call) => `${call.command} ${call.args[0]}`), [
    'docker run',
    'docker inspect',
    'docker stop',
    'docker rm',
  ])
})

test('sandbox runtime one-shot runs a foreground proof command with hardened policy', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const result = await runSandboxRuntimeOneShot(sandboxLaunchInput({
    command: ['node', '/proof/sandbox-session-proof.mjs'],
  }), {
    async run(command, args) {
      calls.push({ command, args })
      return { exitCode: 0, stdout: 'session proof ok /tmp/open-cowork-sandbox-runtime/workspace' }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.reasonCode, 'sandbox-runtime-one-shot-passed')
  assert.equal(result.state.status, 'stopped')
  assert.equal(result.command.args.includes('--rm'), true)
  assert.equal(result.command.args.includes('--detach'), false)
  assert.equal(result.command.args.includes('--network'), true)
  assert.equal(result.command.args.includes('none'), true)
  assert.equal(result.command.args.at(-3), 'open-cowork/opencode:local')
  assert.deepEqual(result.command.args.slice(-2), ['node', '/proof/sandbox-session-proof.mjs'])
  assert.equal(result.command.redactedArgs.some((arg) => arg.includes('/tmp/open-cowork-sandbox-runtime')), false)
  assert.equal(result.state.output?.includes('/tmp/open-cowork-sandbox-runtime'), false)
  assert.equal(result.state.output?.includes('[redacted-path]'), true)
  assert.deepEqual(calls.map((call) => `${call.command} ${call.args[0]}`), ['docker run'])
})
