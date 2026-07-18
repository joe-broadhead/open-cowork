import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { clearLocalContainerWarmPoolsForTest, environmentControllerForSpec, finalizeEnvironmentRun, localProcessEnvironmentController, normalizeGatewayEnvironmentConfig, prepareEnvironment, registerEnvironmentControllerForTest, resolveEnvironmentSpec } from '../environments.js'

describe('execution environments', () => {
  let testDir = ''
  let originalPath = ''

  beforeEach(() => {
    originalPath = process.env['PATH'] || ''
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-environments-test-'))
  })

  afterEach(() => {
    process.env['PATH'] = originalPath
    delete process.env['FAKE_CONTAINER_MISSING_TOOLS']
    delete process.env['FAKE_CONTAINER_IMAGE_MISSING']
    delete process.env['FAKE_CONTAINER_LOG']
    delete process.env['FAKE_CRABBOX_LOG']
    delete process.env['FAKE_CRABBOX_WARMUP_FAIL']
    delete process.env['FAKE_CRABBOX_FAIL_COMMAND']
    delete process.env['FAKE_CRABBOX_HANG']
    delete process.env['FAKE_CRABBOX_HANG_MS']
    delete process.env['FAKE_CRABBOX_STOP_FAIL']
    delete process.env['FAKE_CONTAINER_FAIL_COMMAND']
    clearLocalContainerWarmPoolsForTest()
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    testDir = ''
  })

  it('resolves deterministic merge order from global, profile, repo, roadmap, and task selectors', () => {
    const repoDir = path.join(testDir, 'repo')
    fs.mkdirSync(path.join(repoDir, '.gateway'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, '.gateway', 'env.json'), JSON.stringify({
      defaultEnvironment: 'repo',
      environments: {
        repo: { extends: 'base', tools: ['uv'], network: { mode: 'unrestricted' }, resources: { cpu: 2 } },
      },
    }))

    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'base',
      environments: {
        base: { backend: 'local-process', tools: ['node'], network: { mode: 'unrestricted' }, resources: { cpu: 2, timeoutMs: 2000 } },
      },
    })

    const resolved = resolveEnvironmentSpec({
      config,
      stage: 'implement',
      workdir: repoDir,
      profileEnvironment: { tools: ['git'], resources: { memory: '2Gi' } },
      roadmapEnvironment: { tools: ['cargo'], resources: { cpu: 4 } },
      taskEnvironment: { tools: ['npm'], resources: { timeoutMs: 5000 } },
      requiredTools: ['node'],
    })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.spec.backend).toBe('local-process')
    expect(resolved.spec.workdir).toBe(fs.realpathSync(repoDir))
    expect(resolved.spec.tools).toEqual(['cargo', 'git', 'node', 'npm', 'uv'])
    expect(resolved.spec.network.mode).toBe('unrestricted')
    expect(resolved.spec.resources).toMatchObject({ cpu: 4, memory: '2Gi', timeoutMs: 5000 })
    expect(resolved.spec.source).toEqual(['config:base', 'profile:inline', 'repo:repo', 'roadmap:inline', 'task:inline'])
  })

  it('parses repo yaml environment config', () => {
    const repoDir = path.join(testDir, 'yaml-repo')
    fs.mkdirSync(path.join(repoDir, '.gateway'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, '.gateway', 'env.yaml'), `defaultEnvironment: local\nenvironments:\n  local:\n    extends: local-process\n    tools:\n      - node\n      - npm\n    resources:\n      timeout: 2m\n`)

    const resolved = resolveEnvironmentSpec({ config: normalizeGatewayEnvironmentConfig(), stage: 'verify', workdir: repoDir })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.spec.name).toBe('local')
    expect(resolved.spec.tools).toEqual(['node', 'npm'])
    expect(resolved.spec.resources.timeoutMs).toBe(120000)
  })

  it('rejects unapproved repository runtime executables without executing payloads', () => {
    const containerRuntime = installFakeContainerRuntime(testDir)
    const crabboxCli = installFakeCrabboxCli(testDir)
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'approved-container',
      environments: {
        'approved-container': { backend: 'local-container', container: { runtime: containerRuntime, image: 'example/test:latest' } },
        'approved-crabbox': { backend: 'remote-crabbox', crabbox: { cli: crabboxCli, profile: 'ci' } },
        'approved-custom': { backend: 'custom', custom: { runtimeIsolation: 'declared', executable: '/opt/gateway/approved-adapter' } },
      },
    })

    for (const attack of [
      { name: 'container', approved: 'approved-container', override: (payload: string) => ({ container: { runtime: payload } }), reason: 'runtime executable is not administrator-approved' },
      { name: 'crabbox', approved: 'approved-crabbox', override: (payload: string) => ({ crabbox: { cli: payload } }), reason: 'runtime executable is not administrator-approved' },
      { name: 'custom', approved: 'approved-custom', override: (payload: string) => ({ custom: { executable: payload } }), reason: 'may not override administrator-owned custom adapter configuration' },
    ]) {
      const repoDir = path.join(testDir, `repo-${attack.name}`)
      const marker = path.join(testDir, `${attack.name}-payload-executed`)
      const payload = path.join(repoDir, 'repository-runtime-payload')
      fs.mkdirSync(path.join(repoDir, '.gateway'), { recursive: true })
      fs.writeFileSync(payload, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`)
      fs.chmodSync(payload, 0o755)
      fs.writeFileSync(path.join(repoDir, '.gateway', 'env.json'), JSON.stringify({
        defaultEnvironment: attack.approved,
        environments: { [attack.approved]: attack.override(payload) },
      }))

      const resolved = resolveEnvironmentSpec({ config, stage: 'verify', workdir: repoDir })

      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.reason).toContain(attack.reason)
      expect(fs.existsSync(marker)).toBe(false)
    }
  })

  it('requires repository definitions to anchor to administrator environments', () => {
    const repoDir = path.join(testDir, 'unapproved-repo')
    fs.mkdirSync(path.join(repoDir, '.gateway'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, '.gateway', 'env.json'), JSON.stringify({
      defaultEnvironment: 'repository-container',
      environments: {
        'repository-container': { backend: 'local-container', container: { runtime: process.execPath, image: 'example/test:latest' } },
      },
    }))

    const resolved = resolveEnvironmentSpec({ config: normalizeGatewayEnvironmentConfig(), stage: 'verify', workdir: repoDir })

    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toContain('must extend or replace an administrator-approved environment')
  })

  it('preserves administrator-owned custom runtimes through canonical approval', () => {
    installFakeContainerRuntime(testDir)
    const runtimePath = path.join(testDir, 'fake-container')
    const runtimeAlias = path.join(testDir, 'approved-container-alias')
    fs.symlinkSync(runtimePath, runtimeAlias)
    const repoDir = path.join(testDir, 'approved-runtime-repo')
    fs.mkdirSync(path.join(repoDir, '.gateway'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, '.gateway', 'env.json'), JSON.stringify({
      defaultEnvironment: 'repository-container',
      environments: {
        'repository-container': {
          extends: 'approved-container',
          container: { runtime: runtimeAlias, image: 'example/test:latest' },
        },
      },
    }))
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'approved-container',
      environments: {
        'approved-container': { backend: 'local-container', container: { runtime: runtimePath, image: 'example/test:latest' } },
      },
    })

    const resolved = resolveEnvironmentSpec({ config, stage: 'verify', workdir: repoDir })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.spec.container?.runtime).toBe(fs.realpathSync(runtimePath))
    const controller = environmentControllerForSpec(resolved.spec)
    const run = controller.prepare(resolved.spec, { taskId: 'task_approved_runtime', stage: 'verify' })
    expect(run.preflight.ok).toBe(true)
    expect(fs.readFileSync(process.env['FAKE_CONTAINER_LOG']!, 'utf-8')).toContain('"image","inspect"')
    controller.release(run)
  })

  it('generates fail-closed network arguments for every supported container mode', () => {
    const runtime = installFakeContainerRuntime(testDir)
    const cases = [
      { name: 'disabled-default', network: { mode: 'disabled' as const }, containerNetwork: undefined, expected: ['--network', 'none'] },
      { name: 'disabled-explicit-none', network: { mode: 'disabled' as const }, containerNetwork: 'none', expected: ['--network', 'none'] },
      { name: 'restricted-deny-all', network: { mode: 'restricted' as const }, containerNetwork: undefined, expected: ['--network', 'none'] },
      { name: 'unrestricted-default', network: { mode: 'unrestricted' as const }, containerNetwork: undefined, expected: [] },
      { name: 'unrestricted-named', network: { mode: 'unrestricted' as const }, containerNetwork: 'bridge', expected: ['--network', 'bridge'] },
    ]

    for (const testCase of cases) {
      const config = normalizeGatewayEnvironmentConfig({
        defaultEnvironment: testCase.name,
        environments: {
          [testCase.name]: {
            backend: 'local-container',
            network: testCase.network,
            container: { runtime, image: 'example/test:latest', network: testCase.containerNetwork },
          },
        },
      })
      const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) continue
      const controller = environmentControllerForSpec(resolved.spec)
      const run = controller.prepare(resolved.spec, { taskId: `task_${testCase.name}`, stage: 'verify' })
      const args = (run.metadata['runtimeCommandPrefix'] as string[]).slice(1)
      const networkIndexes = args.map((value, index) => value === '--network' ? index : -1).filter(index => index >= 0)
      expect(networkIndexes).toHaveLength(testCase.expected.length ? 1 : 0)
      expect(networkIndexes.length ? args.slice(networkIndexes[0], networkIndexes[0]! + 2) : []).toEqual(testCase.expected)
      controller.release(run)
    }
  })

  it('rejects conflicting or unenforceable network policies before container preparation', () => {
    const runtime = installFakeContainerRuntime(testDir)
    const cases = [
      { name: 'disabled-conflict', network: { mode: 'disabled' as const }, containerNetwork: 'bridge', reason: 'conflicts with container.network=bridge' },
      { name: 'restricted-conflict', network: { mode: 'restricted' as const }, containerNetwork: 'host', reason: 'conflicts with container.network=host' },
      { name: 'restricted-allow', network: { mode: 'restricted' as const, allow: ['registry.example.test'] }, containerNetwork: undefined, reason: 'no allowlist enforcement mechanism' },
      { name: 'disabled-allow', network: { mode: 'disabled' as const, allow: ['registry.example.test'] }, containerNetwork: undefined, reason: 'network.allow is only valid' },
      { name: 'unrestricted-allow', network: { mode: 'unrestricted' as const, allow: ['registry.example.test'] }, containerNetwork: undefined, reason: 'network.allow is only valid' },
    ]

    for (const testCase of cases) {
      const resolved = resolveEnvironmentSpec({
        config: normalizeGatewayEnvironmentConfig({
          defaultEnvironment: testCase.name,
          environments: {
            [testCase.name]: {
              backend: 'local-container',
              network: testCase.network,
              container: { runtime, image: 'example/test:latest', network: testCase.containerNetwork },
            },
          },
        }),
        stage: 'verify',
      })

      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.reason).toContain(testCase.reason)
    }
    const valid = resolveEnvironmentSpec({
      config: normalizeGatewayEnvironmentConfig({
        defaultEnvironment: 'forged-network',
        environments: { 'forged-network': { backend: 'local-container', network: { mode: 'unrestricted' }, container: { runtime, image: 'example/test:latest' } } },
      }),
      stage: 'verify',
    })
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      const forged = { ...valid.spec, network: { mode: 'disabled' as const, allow: [] }, container: { ...valid.spec.container, network: 'host' } }
      expect(() => environmentControllerForSpec(forged).prepare(forged, { taskId: 'task_forged_network', stage: 'verify' })).toThrow('conflicts with container.network=host')
    }
    expect(fs.existsSync(process.env['FAKE_CONTAINER_LOG']!)).toBe(false)
  })

  it('fails invalid backend specs before dispatch', () => {
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'bad-container',
      environments: { 'bad-container': { backend: 'local-container' } },
    })

    const resolved = resolveEnvironmentSpec({ config, stage: 'implement' })

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toContain('container.image')
  })

  it('preflights local-container tools through the container runtime without host tools', () => {
    const runtime = installFakeContainerRuntime(testDir)
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'container',
      environments: {
        container: {
          backend: 'local-container',
          container: { runtime, image: 'example/test:latest' },
          tools: ['gateway-tool-missing'],
          env: { GITHUB_TOKEN: 'secret-value' },
          secrets: { allow: ['GITHUB_TOKEN'] },
        },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(JSON.stringify(resolved.spec)).not.toContain('secret-value')

    const run = prepareEnvironment(resolved.spec, { taskId: 'task_env', stage: 'verify' })

    expect(run.preflight.ok).toBe(true)
    expect(run.preflight.missing).toEqual([])
    expect(run.preflight.commandRefs.some(ref => ref.includes(`${runtime} run`) && ref.includes('command -v gateway-tool-missing'))).toBe(true)
    expect(JSON.stringify(run)).toContain('GITHUB_TOKEN')
    expect(JSON.stringify(run)).not.toContain('secret-value')
  })

  it('stores local-container runtime metadata and cleans isolated workspaces', () => {
    const runtime = installFakeContainerRuntime(testDir)
    const repoDir = path.join(testDir, 'repo')
    const mountDir = path.join(testDir, 'shared-cache')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(mountDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{}')
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'container',
      environments: {
        container: {
          backend: 'local-container',
          workdir: repoDir,
          tools: ['node'],
          resources: { cpu: 2, memory: '1Gi' },
          network: { mode: 'disabled' },
          cache: { volumes: [{ name: 'npm-cache', path: '/cache/npm' }] },
          container: { runtime, image: 'example/test:latest', workdir: '/workspace/app', user: '1000:1000', mounts: [{ source: mountDir, target: '/mnt/shared', readonly: true }] },
        },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'implement' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const controller = environmentControllerForSpec(resolved.spec)

    const run = controller.prepare(resolved.spec, { taskId: 'task_container', stage: 'implement' })
    const attachment = controller.attach(resolved.spec, run)

    expect(controller.backend).toBe('local-container')
    expect(run).toMatchObject({ backend: 'local-container', provider: 'local-container', image: 'example/test:latest', runtime, preflight: { ok: true } })
    expect(run.metadata).toMatchObject({ imageDigest: 'sha256:fake-image', containerWorkdir: '/workspace/app' })
    expect(String(run.metadata['workspaceHostPath'])).toContain('opencode-gateway')
    expect(fs.existsSync(path.join(String(run.metadata['workspaceHostPath']), 'package.json'))).toBe(true)
    expect(attachment.commandPrefix).toEqual([expect.stringContaining('gateway-container-command.js')])
    expect(run.metadata['runtimeCommandPrefix']).toEqual(expect.arrayContaining([runtime, '--cpus', '2', '--memory', '1Gi', '--network', 'none']))
    expect(String(run.metadata['runtimeCommandPrefix'])).toContain('opencode-gateway-')
    expect(String(run.metadata['runtimeCommandPrefix'])).toContain(`${mountDir}:/mnt/shared:ro`)

    const released = controller.release(run)
    expect(released).toMatchObject({ status: 'released', cleanup: { state: 'released' } })
    expect(fs.existsSync(String(run.metadata['workspaceHostPath']))).toBe(false)
  })

  it('captures local-container command stdout stderr exit code and timing through the wrapper', () => {
    const runtime = installFakeContainerRuntime(testDir)
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'container',
      environments: {
        container: { backend: 'local-container', container: { runtime, image: 'example/test:latest' } },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const controller = environmentControllerForSpec(resolved.spec)
    const run = controller.prepare(resolved.spec, { taskId: 'task_capture', stage: 'verify' })
    const attachment = controller.attach(resolved.spec, run)

    const command = spawnSync(attachment.commandPrefix[0]!, ['capture-fail'], { encoding: 'utf8' })
    const artifacts = controller.collectArtifacts(run)

    expect(command.status).toBe(7)
    expect(command.stdout).toContain('captured stdout')
    expect(command.stderr).toContain('captured stderr')
    expect(artifacts.artifacts).toEqual(expect.arrayContaining([expect.stringMatching(/\.stdout\.log$/), expect.stringMatching(/\.stderr\.log$/), expect.stringMatching(/\.json$/)]))
    expect(artifacts.evidence.join('\n')).toContain('captured 1 command')
    const metadataPath = artifacts.artifacts.find(ref => ref.endsWith('.json'))!.replace(/^file:/, '')
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
    expect(metadata).toMatchObject({ exitCode: 7, command: ['capture-fail'], stdoutPath: expect.any(String), stderrPath: expect.any(String), runtimeMs: expect.any(Number) })
  })

  it('warms local-container pools by image and spec hash', () => {
    const runtime = installFakeContainerRuntime(testDir)
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'container',
      environments: {
        container: { backend: 'local-container', container: { runtime, image: 'example/test:latest', warm: true } },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const controller = environmentControllerForSpec(resolved.spec)

    const first = controller.prepare(resolved.spec, { taskId: 'task_warm_1', stage: 'verify' })
    const second = controller.prepare(resolved.spec, { taskId: 'task_warm_2', stage: 'verify' })

    expect(first.metadata['warmPool']).toMatchObject({ hit: false, key: expect.any(String), result: { ok: true, phase: 'warmup' } })
    expect(second.metadata['warmPool']).toMatchObject({ hit: true, key: first.metadata['warmPool'] && (first.metadata['warmPool'] as any).key })
    const warmups = fs.readFileSync(process.env['FAKE_CONTAINER_LOG']!, 'utf-8').split('\n').filter(line => line.includes('"true"'))
    expect(warmups).toHaveLength(1)
  })

  it('runs local-container setup and validation commands in preflight', () => {
    const runtime = installFakeContainerRuntime(testDir)
    process.env['FAKE_CONTAINER_FAIL_COMMAND'] = 'setup'
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'container',
      environments: {
        container: { backend: 'local-container', setup: ['npm ci'], validation: ['npm test'], container: { runtime, image: 'example/test:latest' } },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const run = environmentControllerForSpec(resolved.spec).prepare(resolved.spec, { taskId: 'task_setup', stage: 'verify' })

    expect(run).toMatchObject({ status: 'blocked', preflight: { ok: false, missing: ['setup:1'] } })
    expect(run.preflight.warnings.join('\n')).toContain('setup command 1 failed')
    expect(run.metadata['commandResults']).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, phase: 'setup:1', exitCode: 9 })]))
  })

  it('blocks local-container preflight when image, runtime, or tools are missing', () => {
    const runtime = installFakeContainerRuntime(testDir)
    process.env['FAKE_CONTAINER_MISSING_TOOLS'] = 'missing-tool'
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'container',
      environments: {
        container: { backend: 'local-container', container: { runtime, image: 'example/test:latest' }, tools: ['missing-tool'] },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const toolRun = prepareEnvironment(resolved.spec, { taskId: 'task_env', stage: 'verify' })
    expect(toolRun.preflight).toMatchObject({ ok: false, missing: ['missing-tool'] })
    expect(toolRun.preflight.warnings.join('\n')).toContain('missing missing-tool')

    process.env['FAKE_CONTAINER_IMAGE_MISSING'] = '1'
    delete process.env['FAKE_CONTAINER_MISSING_TOOLS']
    const imageRun = prepareEnvironment(resolved.spec, { taskId: 'task_env', stage: 'verify' })
    expect(imageRun.preflight.ok).toBe(false)
    expect(imageRun.preflight.missing).toContain('image:example/test:latest')

    const missingRuntimeConfig = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'container',
      environments: {
        container: { backend: 'local-container', container: { runtime: 'gateway-runtime-not-installed', image: 'example/test:latest' } },
      },
    })
    const missingRuntime = resolveEnvironmentSpec({ config: missingRuntimeConfig, stage: 'verify' })
    expect(missingRuntime.ok).toBe(true)
    if (!missingRuntime.ok) return
    const runtimeRun = prepareEnvironment(missingRuntime.spec, { taskId: 'task_env', stage: 'verify' })
    expect(runtimeRun.preflight.ok).toBe(false)
    expect(runtimeRun.preflight.missing).toContain('gateway-runtime-not-installed')
  })

  it('leases remote-crabbox capacity and records Crabbox metadata', () => {
    const cli = installFakeCrabboxCli(testDir)
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'remote',
      environments: {
        remote: {
          backend: 'remote-crabbox',
          workdir: testDir,
          tools: ['node'],
          setup: ['npm ci'],
          validation: ['npm test'],
          env: { NODE_ENV: 'test' },
          crabbox: { cli, profile: 'ci', provider: 'aws', class: 'beast', ttl: '2h', keepOnFailure: true, brokerUrl: 'https://broker.example.test' },
        },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const controller = environmentControllerForSpec(resolved.spec)

    const run = controller.prepare(resolved.spec, { taskId: 'task_remote', stage: 'verify' })
    const attachment = controller.attach(resolved.spec, run)
    const artifacts = controller.collectArtifacts(run)
    const released = controller.release(run)

    expect(controller.backend).toBe('remote-crabbox')
    expect(run).toMatchObject({ backend: 'remote-crabbox', leaseId: 'cbx_gateway_test', runId: 'run_fake', provider: 'aws', class: 'beast', preflight: { ok: true } })
    expect(run.cleanup.retainOnFailure).toBe(true)
    expect(run.artifacts).toContain('crabbox://run/run_fake/artifact/proof.md')
    expect(run.metadata).toMatchObject({ slug: 'swift-crab', inspect: { id: 'cbx_gateway_test', provider: 'aws', sshKey: '<redacted>' } })
    expect(JSON.stringify(run)).not.toContain('broker.example.test')
    expect(attachment.commandPrefix).toEqual(expect.arrayContaining([cli, 'run', '--id', 'cbx_gateway_test', '--timing-json', '--']))
    expect(artifacts).toMatchObject({ ok: true, artifacts: expect.arrayContaining(['crabbox://run/run_fake/artifact/proof.md']) })
    expect(released).toMatchObject({ status: 'released', cleanup: { state: 'released' } })
    expect(fs.readFileSync(process.env['FAKE_CRABBOX_LOG']!, 'utf-8')).toContain('["stop","--provider","aws","cbx_gateway_test"]')
  })

  it('maps remote-crabbox lease failures to actionable classes', () => {
    const cli = installFakeCrabboxCli(testDir)
    process.env['FAKE_CRABBOX_WARMUP_FAIL'] = 'capacity'
    const resolved = resolveEnvironmentSpec({
      config: normalizeGatewayEnvironmentConfig({ defaultEnvironment: 'remote', environments: { remote: { backend: 'remote-crabbox', env: { FAKE_CRABBOX_WARMUP_FAIL: 'capacity' }, crabbox: { cli, profile: 'ci' } } } }),
      stage: 'implement',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    expect(() => environmentControllerForSpec(resolved.spec).prepare(resolved.spec, { taskId: 'task_remote', stage: 'implement' })).toThrow('Crabbox lease failed (capacity)')
  })

  it('blocks remote-crabbox setup command failures without creating a session', () => {
    const cli = installFakeCrabboxCli(testDir)
    process.env['FAKE_CRABBOX_FAIL_COMMAND'] = 'setup'
    const resolved = resolveEnvironmentSpec({
      config: normalizeGatewayEnvironmentConfig({ defaultEnvironment: 'remote', environments: { remote: { backend: 'remote-crabbox', setup: ['npm ci'], env: { FAKE_CRABBOX_FAIL_COMMAND: 'setup' }, crabbox: { cli, profile: 'ci' } } } }),
      stage: 'implement',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const run = environmentControllerForSpec(resolved.spec).prepare(resolved.spec, { taskId: 'task_remote', stage: 'implement' })

    expect(run).toMatchObject({ status: 'blocked', preflight: { ok: false, missing: ['setup:1'] } })
    expect(run.preflight.warnings.join('\n')).toContain('setup command 1 failed (setup)')
    expect(run.metadata['commandResults']).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, failureClass: 'setup' })]))
  })

  it('maps remote-crabbox command timeouts during preflight', () => {
    const cli = installFakeCrabboxCli(testDir)
    const resolved = resolveEnvironmentSpec({
      config: normalizeGatewayEnvironmentConfig({ defaultEnvironment: 'remote', environments: { remote: { backend: 'remote-crabbox', tools: ['node'], resources: { timeoutMs: 2000 }, env: { FAKE_CRABBOX_HANG: '1', FAKE_CRABBOX_HANG_MS: '4000' }, crabbox: { cli, profile: 'ci' } } } }),
      stage: 'verify',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const run = environmentControllerForSpec(resolved.spec).prepare(resolved.spec, { taskId: 'task_remote', stage: 'verify' })

    expect(run.preflight).toMatchObject({ ok: false, missing: ['node'] })
    expect(run.preflight.warnings.join('\n')).toContain('(timeout)')
    expect(run.metadata['commandResults']).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, failureClass: 'timeout' })]))
  })

  it('surfaces remote-crabbox release failures and retain-on-failure policy', () => {
    const cli = installFakeCrabboxCli(testDir)
    const resolved = resolveEnvironmentSpec({
      config: normalizeGatewayEnvironmentConfig({ defaultEnvironment: 'remote', environments: { remote: { backend: 'remote-crabbox', crabbox: { cli, profile: 'ci', keepOnFailure: true } } } }),
      stage: 'verify',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const controller = environmentControllerForSpec(resolved.spec)
    const run = controller.prepare(resolved.spec, { taskId: 'task_remote', stage: 'verify' })

    const retained = finalizeEnvironmentRun(run, false)
    expect(retained).toMatchObject({ status: 'retained', cleanup: { state: 'retained' } })

    process.env['FAKE_CRABBOX_STOP_FAIL'] = '1'
    const cleanupFailed = finalizeEnvironmentRun(run, true)
    expect(cleanupFailed).toMatchObject({ status: 'cleanup_failed', cleanup: { state: 'failed' }, metadata: { cleanupError: expect.stringContaining('Crabbox stop failed') } })
  })

  it('reconciles retained remote-crabbox leases after restart', () => {
    const cli = installFakeCrabboxCli(testDir)
    const resolved = resolveEnvironmentSpec({
      config: normalizeGatewayEnvironmentConfig({ defaultEnvironment: 'remote', environments: { remote: { backend: 'remote-crabbox', crabbox: { cli, profile: 'ci' } } } }),
      stage: 'verify',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const controller = environmentControllerForSpec(resolved.spec)
    const run = controller.retain(controller.prepare(resolved.spec, { taskId: 'task_remote', stage: 'verify' }))

    const reconciliation = controller.reconcile([run])

    expect(reconciliation).toMatchObject({ ok: true, checked: 1, retained: 1 })
    expect(reconciliation.evidence).toEqual(expect.arrayContaining([expect.stringContaining('remote-crabbox cbx_gateway_test inspect ok')]))
  })

  it('reconciles stale local-container cleanup failures', () => {
    const runtime = installFakeContainerRuntime(testDir)
    const config = normalizeGatewayEnvironmentConfig({ defaultEnvironment: 'container', environments: { container: { backend: 'local-container', container: { runtime, image: 'example/test:latest' } } } })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const controller = environmentControllerForSpec(resolved.spec)
    const run = controller.prepare(resolved.spec, { taskId: 'task_reconcile', stage: 'verify' })
    const workspace = String(run.metadata['workspaceHostPath'])
    const failed = { ...run, status: 'cleanup_failed' as const, cleanup: { ...run.cleanup, state: 'failed' as const } }

    const result = controller.reconcile([failed])

    expect(result.evidence).toEqual(expect.arrayContaining([expect.stringContaining('stale workspace cleanup attempted')]))
    expect(fs.existsSync(workspace)).toBe(false)
  })

  it('requires exact allowlist entries for secret-like env keys', () => {
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'container',
      environments: {
        container: {
          backend: 'local-container',
          container: { runtime: 'node', image: 'example/test:latest' },
          env: { GITHUB_TOKEN: 'secret-value' },
          secrets: { allow: ['OTHER_TOKEN'] },
        },
      },
    })

    const resolved = resolveEnvironmentSpec({ config, stage: 'verify' })

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toContain('GITHUB_TOKEN')
  })

  it('exposes local-process lifecycle through the Environment Controller interface', () => {
    const resolved = resolveEnvironmentSpec({ config: normalizeGatewayEnvironmentConfig(), stage: 'implement', requiredTools: ['node'] })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const controller = environmentControllerForSpec(resolved.spec)
    const hydration = controller.hydrate(resolved.spec, { taskId: 'task_controller', stage: 'implement' })
    const run = controller.prepare(resolved.spec, { taskId: 'task_controller', stage: 'implement' })
    const attachment = controller.attach(resolved.spec, run)
    const artifacts = controller.collectArtifacts(run)
    const retained = controller.retain(run)
    const released = controller.release(run)
    const reconciliation = controller.reconcile([retained, released])

    expect(controller.backend).toBe('local-process')
    expect(hydration).toMatchObject({ ok: true, status: 'not_required' })
    expect(run).toMatchObject({ backend: 'local-process', preflight: { ok: true } })
    expect(attachment).toMatchObject({ ok: true, commandPrefix: [] })
    expect(artifacts).toMatchObject({ ok: true, artifacts: [] })
    expect(retained).toMatchObject({ status: 'retained', cleanup: { state: 'retained' } })
    expect(released).toMatchObject({ status: 'released', cleanup: { state: 'released' } })
    expect(reconciliation).toMatchObject({ ok: true, checked: 2, retained: 1 })
  })

  it('defers local-container dependency patches until the isolated workspace is attached', () => {
    const runtime = installFakeContainerRuntime(testDir)
    const host = path.join(testDir, 'host-checkout')
    const isolated = path.join(testDir, 'isolated-checkout')
    fs.mkdirSync(host, { recursive: true })
    fs.mkdirSync(isolated, { recursive: true })
    fs.writeFileSync(path.join(host, 'feature.txt'), 'base\n')
    fs.writeFileSync(path.join(isolated, 'feature.txt'), 'base\n')
    for (const dir of [host, isolated]) {
      spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, encoding: 'utf8' })
      spawnSync('git', ['add', 'feature.txt'], { cwd: dir, encoding: 'utf8' })
      spawnSync('git', ['commit', '-m', 'base'], { cwd: dir, encoding: 'utf8' })
    }
    const resolved = resolveEnvironmentSpec({
      config: normalizeGatewayEnvironmentConfig({
        defaultEnvironment: 'container',
        environments: {
          container: { backend: 'local-container', workdir: host, container: { runtime, image: 'example/test:latest' } },
        },
      }),
      stage: 'implement',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const sourcePlan = {
      required: true,
      baseRef: 'HEAD',
      workdir: host,
      dependencyTaskIds: ['task_dependency'],
      missing: [],
      patches: [{
        id: 'task_dependency:run_dependency:1',
        taskId: 'task_dependency',
        runId: 'run_dependency',
        stage: 'implement',
        ref: 'artifacts/dependency.patch',
        content: [
          'diff --git a/feature.txt b/feature.txt',
          'index df967b9..2b1efc7 100644',
          '--- a/feature.txt',
          '+++ b/feature.txt',
          '@@ -1 +1 @@',
          '-base',
          '+patched',
          '',
        ].join('\n'),
        changedFiles: ['feature.txt'],
      }],
    }
    const controller = environmentControllerForSpec(resolved.spec)

    const initial = controller.hydrate(resolved.spec, { taskId: 'task_container', stage: 'implement', workdir: host, sourcePlan })
    const workspace = controller.hydrate(resolved.spec, { taskId: 'task_container', stage: 'implement', workdir: isolated, sourcePlan })

    expect(initial).toMatchObject({ ok: true, status: 'not_required', source: { applyResult: 'not_required' } })
    expect(workspace).toMatchObject({ ok: true, status: 'applied', source: { applyResult: 'applied' } })
    expect(fs.readFileSync(path.join(host, 'feature.txt'), 'utf8')).toBe('base\n')
    expect(fs.readFileSync(path.join(isolated, 'feature.txt'), 'utf8')).toBe('patched\n')
  })

  it('allows scheduler tests to register mock controllers by backend', () => {
    const resolved = resolveEnvironmentSpec({ config: normalizeGatewayEnvironmentConfig(), stage: 'verify', taskEnvironment: { backend: 'custom', name: 'mock' } })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const unregister = registerEnvironmentControllerForTest('custom', { ...localProcessEnvironmentController, backend: 'custom' })

    expect(environmentControllerForSpec(resolved.spec).backend).toBe('custom')

    unregister()
    expect(environmentControllerForSpec(resolved.spec).backend).toBe('metadata')
  })
})

function installFakeContainerRuntime(testDir: string): string {
  const runtime = 'fake-container'
  const scriptPath = path.join(testDir, runtime)
  const logPath = path.join(testDir, 'fake-container.log')
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_CONTAINER_LOG) fs.appendFileSync(process.env.FAKE_CONTAINER_LOG, JSON.stringify(args) + '\\n')
if (args[0] === '--version') { console.log('fake-container 1.0.0'); process.exit(0) }
if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.FAKE_CONTAINER_IMAGE_MISSING) { console.error('image missing'); process.exit(1) }
  console.log('sha256:fake-image')
  process.exit(0)
}
if (args[0] === 'run') {
  const commandIndex = args.indexOf('command')
  const command = commandIndex >= 0 ? args.slice(commandIndex) : []
  if (command[0] === 'command' && command[1] === '-v') {
    const tool = command[2]
    const missing = (process.env.FAKE_CONTAINER_MISSING_TOOLS || '').split(',').filter(Boolean)
    if (missing.includes(tool)) { console.error('missing ' + tool); process.exit(1) }
    console.log('/usr/bin/' + tool)
    process.exit(0)
  }
  const imageIndex = args.indexOf('example/test:latest')
  const stageCommand = imageIndex >= 0 ? args.slice(imageIndex + 1) : []
  if (stageCommand[0] === 'capture-fail') { console.log('captured stdout'); console.error('captured stderr'); process.exit(7) }
  if (stageCommand[0] === 'sh' && stageCommand[1] === '-lc') {
    const shellCommand = stageCommand[2] || ''
    if (process.env.FAKE_CONTAINER_FAIL_COMMAND === 'setup' && shellCommand.includes('npm ci')) { console.log('setup stdout'); console.error('setup failed'); process.exit(9) }
    console.log('shell ran: ' + shellCommand)
    process.exit(0)
  }
  if (stageCommand[0] === 'true') { console.log('warm true'); process.exit(0) }
  console.log('ran container command')
  process.exit(0)
}
console.error('unsupported fake-container args: ' + args.join(' '))
process.exit(1)
`)
  fs.chmodSync(scriptPath, 0o755)
  process.env['PATH'] = `${testDir}${path.delimiter}${process.env['PATH'] || ''}`
  process.env['FAKE_CONTAINER_LOG'] = logPath
  return runtime
}

function installFakeCrabboxCli(testDir: string): string {
  const cli = 'fake-crabbox'
  const scriptPath = path.join(testDir, cli)
  const logPath = path.join(testDir, 'fake-crabbox.log')
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_CRABBOX_LOG) fs.appendFileSync(process.env.FAKE_CRABBOX_LOG, JSON.stringify(args) + '\\n')
function timing(extra) { console.error(JSON.stringify(Object.assign({ provider: 'aws', leaseId: 'cbx_gateway_test', slug: 'swift-crab', exitCode: 0 }, extra || {}))) }
if (args[0] === '--version') { console.log('fake-crabbox 1.0.0'); process.exit(0) }
if (args[0] === 'warmup') {
  if (process.env.FAKE_CRABBOX_WARMUP_FAIL === 'capacity') { console.error('capacity exhausted for requested class'); process.exit(1) }
  console.log('leased cbx_gateway_test slug=swift-crab provider=aws server=i-test type=beast ip=203.0.113.10 idle_timeout=30m expires=soon')
  console.log('ready ssh=root@203.0.113.10 :2222 network=public workroot=/work/crabbox')
  timing({ totalMs: 123 })
  process.exit(0)
}
if (args[0] === 'inspect') {
  console.log(JSON.stringify({ id: 'cbx_gateway_test', slug: 'swift-crab', provider: 'aws', state: 'active', host: '203.0.113.10', sshKey: '/tmp/id_ed25519', workroot: '/work/crabbox' }))
  process.exit(0)
}
if (args[0] === 'run') {
  if (args.includes('--shell')) {
    const command = args[args.indexOf('--shell') + 1] || ''
    if (process.env.FAKE_CRABBOX_FAIL_COMMAND === 'setup' && command.includes('npm ci')) {
      console.error('install/setup failed while running npm ci')
      timing({ runId: 'run_fake', exitCode: 1, blockedStage: 'setup' })
      process.exit(1)
    }
  }
  const commandIndex = args.indexOf('--')
  const command = commandIndex >= 0 ? args.slice(commandIndex + 1) : []
  if (process.env.FAKE_CRABBOX_HANG && command[0] === 'command' && command[1] === '-v') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CRABBOX_HANG_MS || 3000)); process.exit(0) }
  if (command[0] === 'command' && command[1] === '-v') console.log('/usr/bin/' + command[2])
  else console.log('ran remote command')
  timing({ runId: 'run_fake', artifacts: ['crabbox://run/run_fake/artifact/proof.md'] })
  process.exit(0)
}
if (args[0] === 'stop' || args[0] === 'release') {
  if (process.env.FAKE_CRABBOX_STOP_FAIL) { console.error('network release failed'); process.exit(1) }
  console.log('released lease=cbx_gateway_test')
  process.exit(0)
}
console.error('unsupported fake-crabbox args: ' + args.join(' '))
process.exit(1)
`)
  fs.chmodSync(scriptPath, 0o755)
  process.env['PATH'] = `${testDir}${path.delimiter}${process.env['PATH'] || ''}`
  process.env['FAKE_CRABBOX_LOG'] = logPath
  return cli
}
