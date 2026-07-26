import {
  RUNTIME_TOOLING_BRIDGE_CATEGORIES,
  RUNTIME_TOOLING_BRIDGE_PROJECTIONS,
  createDisabledRuntimeToolingBridgeConsent,
  type RuntimeToolingBridgeCategoryId,
} from '@open-cowork/shared'
import { syncRuntimeHomeToolingBridge } from '@open-cowork/runtime-host/runtime-home-bridge'
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

function enabledConsent(...categories: RuntimeToolingBridgeCategoryId[]) {
  const consent = createDisabledRuntimeToolingBridgeConsent()
  for (const category of categories) consent.categories[category] = true
  return consent
}

function withHomes(
  prefix: string,
  run: (paths: { root: string; realHome: string; runtimeHome: string }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const realHome = join(root, 'real-home')
  const runtimeHome = join(root, 'runtime-home')
  mkdirSync(realHome, { recursive: true })
  mkdirSync(runtimeHome, { recursive: true })
  try {
    run({ root, realHome, runtimeHome })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('runtime tooling projections default off and ignore legacy monolithic consent', () => {
  withHomes('open-cowork-runtime-home-default-off-', ({ realHome, runtimeHome }) => {
    writeFileSync(join(realHome, '.gitconfig'), '[user]\n  name = Test User\n')

    const results = syncRuntimeHomeToolingBridge({ runtimeHome, realHome })

    assert.equal(existsSync(join(runtimeHome, '.gitconfig')), false)
    assert.equal(results.some(({ status }) => status === 'linked'), false)
  })
})

test('runtime tooling bridge exposes only fixed files for an enabled category', () => {
  withHomes('open-cowork-runtime-home-file-level-', ({ realHome, runtimeHome }) => {
    mkdirSync(join(realHome, '.ssh'), { recursive: true })
    writeFileSync(join(realHome, '.ssh', 'config'), 'Host example\n')
    writeFileSync(join(realHome, '.ssh', 'id_ed25519'), 'test-private-key')
    writeFileSync(join(realHome, '.ssh', 'unlisted-secret'), 'must-not-project')

    syncRuntimeHomeToolingBridge({
      runtimeHome,
      realHome,
      consent: enabledConsent('ssh'),
    })

    assert.equal(lstatSync(join(runtimeHome, '.ssh')).isSymbolicLink(), false)
    assert.equal(readlinkSync(join(runtimeHome, '.ssh', 'config')), join(realHome, '.ssh', 'config'))
    assert.equal(existsSync(join(runtimeHome, '.ssh', 'id_ed25519')), false)
    assert.equal(existsSync(join(runtimeHome, '.ssh', 'unlisted-secret')), false)
  })
})

for (const category of RUNTIME_TOOLING_BRIDGE_CATEGORIES) {
  test(`runtime tooling bridge reconciles every fixed ${category.id} projection`, () => {
    withHomes(`open-cowork-runtime-home-${category.id}-`, ({ realHome, runtimeHome }) => {
      const projections = RUNTIME_TOOLING_BRIDGE_PROJECTIONS.filter(
        ({ category: ownerCategory }) => ownerCategory === category.id,
      )
      assert.ok(projections.length > 0, `${category.id} must own at least one fixed projection`)

      for (const projection of projections) {
        const source = join(realHome, projection.sourceRelativePath)
        mkdirSync(dirname(source), { recursive: true })
        writeFileSync(source, `fixture:${projection.id}`)
      }

      const results = syncRuntimeHomeToolingBridge({
        runtimeHome,
        realHome,
        consent: enabledConsent(category.id),
      })

      for (const projection of projections) {
        const source = join(realHome, projection.sourceRelativePath)
        const target = join(runtimeHome, projection.runtimeDestination)
        assert.equal(projection.sourceClass, 'home-file')
        assert.equal(projection.accessMode, 'read-write-link')
        assert.equal(projection.cleanupRule, 'bridge-owned-link')
        assert.equal(readlinkSync(target), source)
        assert.equal(lstatSync(dirname(target)).isSymbolicLink(), false)
        assert.equal(
          results.find(({ projectionId }) => projectionId === projection.id)?.status,
          'linked',
        )
      }
    })
  })
}

test('runtime tooling bridge removes a legacy broad link without touching its host target', () => {
  withHomes('open-cowork-runtime-home-legacy-cleanup-', ({ realHome, runtimeHome }) => {
    mkdirSync(join(realHome, '.aws'), { recursive: true })
    writeFileSync(join(realHome, '.aws', 'credentials'), 'preserve-host-data')
    symlinkSync(join(realHome, '.aws'), join(runtimeHome, '.aws'), 'dir')

    syncRuntimeHomeToolingBridge({ runtimeHome, realHome })

    assert.equal(existsSync(join(runtimeHome, '.aws')), false)
    assert.equal(readFileSync(join(realHome, '.aws', 'credentials'), 'utf8'), 'preserve-host-data')
  })
})

test('runtime tooling bridge records ownership and removes stale or broken owned links idempotently', () => {
  withHomes('open-cowork-runtime-home-owned-cleanup-', ({ realHome, runtimeHome }) => {
    const source = join(realHome, '.gitconfig')
    const target = join(runtimeHome, '.gitconfig')
    writeFileSync(source, '[user]\n  email = test@example.com\n')

    syncRuntimeHomeToolingBridge({
      runtimeHome,
      realHome,
      consent: enabledConsent('sourceControl'),
    })
    assert.equal(readlinkSync(target), source)

    rmSync(source)
    syncRuntimeHomeToolingBridge({ runtimeHome, realHome })
    assert.throws(() => lstatSync(target))
    syncRuntimeHomeToolingBridge({ runtimeHome, realHome })
    assert.throws(() => lstatSync(target))
  })
})

test('runtime tooling bridge fails closed when its ownership manifest is lost', () => {
  withHomes('open-cowork-runtime-home-lost-manifest-', ({ realHome, runtimeHome }) => {
    const source = join(realHome, '.gitconfig')
    const target = join(runtimeHome, '.gitconfig')
    writeFileSync(source, '[user]\n  email = test@example.com\n')
    syncRuntimeHomeToolingBridge({
      runtimeHome,
      realHome,
      consent: enabledConsent('sourceControl'),
    })
    assert.equal(readlinkSync(target), source)

    rmSync(join(runtimeHome, '.open-cowork', 'tooling-bridge-v1.json'))
    syncRuntimeHomeToolingBridge({ runtimeHome, realHome })

    assert.throws(() => lstatSync(target))
    assert.equal(readFileSync(source, 'utf8'), '[user]\n  email = test@example.com\n')
  })
})

test('runtime tooling bridge rejects a forged manifest that tries to preserve a legacy broad link', () => {
  withHomes('open-cowork-runtime-home-forged-manifest-', ({ realHome, runtimeHome }) => {
    const hostSshDirectory = join(realHome, '.ssh')
    const runtimeSshDirectory = join(runtimeHome, '.ssh')
    mkdirSync(hostSshDirectory, { recursive: true })
    mkdirSync(join(runtimeHome, '.open-cowork'), { recursive: true })
    writeFileSync(join(hostSshDirectory, 'config'), 'Host example\n')
    writeFileSync(join(hostSshDirectory, 'id_ed25519'), 'preserve-private-key')
    symlinkSync(hostSshDirectory, runtimeSshDirectory, 'dir')

    // Reuse a currently active projection id while forging its paths to point
    // at the former directory-level bridge. The manifest lives in runtime home
    // and must never be trusted to redefine the fixed projection catalog.
    writeFileSync(
      join(runtimeHome, '.open-cowork', 'tooling-bridge-v1.json'),
      JSON.stringify({
        version: 1,
        entries: [{
          id: 'ssh-config',
          category: 'ssh',
          sourceRelativePath: '.ssh',
          runtimeDestination: '.ssh',
        }],
      }),
    )

    const results = syncRuntimeHomeToolingBridge({
      runtimeHome,
      realHome,
      consent: enabledConsent('ssh'),
    })

    assert.equal(lstatSync(runtimeSshDirectory).isSymbolicLink(), false)
    assert.equal(
      readlinkSync(join(runtimeSshDirectory, 'config')),
      join(hostSshDirectory, 'config'),
    )
    assert.equal(existsSync(join(runtimeSshDirectory, 'id_ed25519')), false)
    assert.equal(
      readFileSync(join(hostSshDirectory, 'id_ed25519'), 'utf8'),
      'preserve-private-key',
    )
    assert.equal(
      results.find(({ projectionId }) => projectionId === 'ssh-config')?.status,
      'linked',
    )
  })
})

test('runtime tooling bridge preserves user-created destination conflicts', () => {
  withHomes('open-cowork-runtime-home-user-conflict-', ({ realHome, runtimeHome }) => {
    const source = join(realHome, '.gitconfig')
    const target = join(runtimeHome, '.gitconfig')
    writeFileSync(source, '[user]\n  email = host@example.com\n')
    writeFileSync(target, '[user]\n  email = runtime@example.com\n')

    assert.throws(
      () => syncRuntimeHomeToolingBridge({
        runtimeHome,
        realHome,
        consent: enabledConsent('sourceControl'),
      }),
      /safely remove/,
    )
    assert.equal(readFileSync(target, 'utf8'), '[user]\n  email = runtime@example.com\n')

    assert.throws(
      () => syncRuntimeHomeToolingBridge({ runtimeHome, realHome }),
      /safely remove/,
    )
    assert.equal(readFileSync(target, 'utf8'), '[user]\n  email = runtime@example.com\n')
  })
})

test('runtime tooling bridge rolls back new grants when a later owned target conflicts', () => {
  withHomes('open-cowork-runtime-home-grant-rollback-', ({ realHome, runtimeHome }) => {
    const gitConfigSource = join(realHome, '.gitconfig')
    const gitConfigTarget = join(runtimeHome, '.gitconfig')
    const gitIgnoreSource = join(realHome, '.gitignore')
    const gitIgnoreTarget = join(runtimeHome, '.gitignore')
    writeFileSync(gitConfigSource, '[user]\n  email = host@example.com\n')
    writeFileSync(gitIgnoreSource, 'host-ignore\n')
    writeFileSync(gitIgnoreTarget, 'preserve-runtime-conflict\n')
    mkdirSync(join(runtimeHome, '.open-cowork'))
    writeFileSync(
      join(runtimeHome, '.open-cowork', 'tooling-bridge-v1.json'),
      JSON.stringify({
        version: 1,
        entries: [{
          id: 'git-ignore',
          category: 'sourceControl',
          sourceRelativePath: '.gitignore',
          runtimeDestination: '.gitignore',
        }],
      }),
    )

    assert.throws(
      () => syncRuntimeHomeToolingBridge({
        runtimeHome,
        realHome,
        consent: enabledConsent('sourceControl'),
      }),
      /safely grant/,
    )
    assert.equal(existsSync(gitConfigTarget), false)
    assert.equal(readFileSync(gitConfigSource, 'utf8'), '[user]\n  email = host@example.com\n')
    assert.equal(readFileSync(gitIgnoreTarget, 'utf8'), 'preserve-runtime-conflict\n')
  })
})

test('runtime tooling bridge blocks a disabled owned-target conflict without deleting it', () => {
  withHomes('open-cowork-runtime-home-disabled-conflict-', ({ realHome, runtimeHome }) => {
    const target = join(runtimeHome, '.gitconfig')
    writeFileSync(join(realHome, '.gitconfig'), '[user]\n  email = host@example.com\n')
    writeFileSync(target, '[user]\n  email = runtime@example.com\n')
    mkdirSync(join(runtimeHome, '.open-cowork'))
    writeFileSync(
      join(runtimeHome, '.open-cowork', 'tooling-bridge-v1.json'),
      JSON.stringify({
        version: 1,
        entries: [{
          id: 'git-config',
          category: 'sourceControl',
          sourceRelativePath: '.gitconfig',
          runtimeDestination: '.gitconfig',
        }],
      }),
    )

    assert.throws(
      () => syncRuntimeHomeToolingBridge({ runtimeHome, realHome }),
      /safely remove/,
    )
    assert.equal(readFileSync(target, 'utf8'), '[user]\n  email = runtime@example.com\n')
  })
})

test('runtime tooling bridge never follows a user-created destination parent symlink', () => {
  withHomes('open-cowork-runtime-home-parent-symlink-', ({ root, realHome, runtimeHome }) => {
    mkdirSync(join(realHome, '.aws'), { recursive: true })
    writeFileSync(join(realHome, '.aws', 'credentials'), 'host-credential')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'credentials'), 'outside-sentinel')
    symlinkSync(outside, join(runtimeHome, '.aws'), 'dir')

    assert.throws(
      () => syncRuntimeHomeToolingBridge({
        runtimeHome,
        realHome,
        consent: enabledConsent('aws'),
      }),
      /safely remove/,
    )
    assert.equal(readFileSync(join(outside, 'credentials'), 'utf8'), 'outside-sentinel')
    assert.equal(readFileSync(join(realHome, '.aws', 'credentials'), 'utf8'), 'host-credential')
  })
})

test('runtime tooling bridge rejects a symlinked runtime-home root', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-home-root-symlink-'))
  const realHome = join(root, 'real-home')
  const outside = join(root, 'outside')
  const runtimeHome = join(root, 'runtime-home')
  mkdirSync(realHome)
  mkdirSync(outside)
  writeFileSync(join(realHome, '.gitconfig'), '[user]\n  name = Host User\n')
  writeFileSync(join(outside, 'sentinel'), 'preserve-outside')
  symlinkSync(outside, runtimeHome, 'dir')

  try {
    assert.throws(
      () => syncRuntimeHomeToolingBridge({
        runtimeHome,
        realHome,
        consent: enabledConsent('sourceControl'),
      }),
      /root is not an owned directory/,
    )
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'preserve-outside')
    assert.equal(existsSync(join(outside, '.gitconfig')), false)
    assert.equal(existsSync(join(outside, '.open-cowork')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime tooling bridge rolls back newly created links when ownership persistence fails', () => {
  withHomes('open-cowork-runtime-home-manifest-failure-', ({ realHome, runtimeHome }) => {
    const source = join(realHome, '.gitconfig')
    const target = join(runtimeHome, '.gitconfig')
    writeFileSync(source, '[user]\n  email = host@example.com\n')
    const manifestPath = join(runtimeHome, '.open-cowork', 'tooling-bridge-v1.json')
    mkdirSync(manifestPath, { recursive: true })

    assert.throws(
      () => syncRuntimeHomeToolingBridge({
        runtimeHome,
        realHome,
        consent: enabledConsent('sourceControl'),
      }),
      /ownership record/,
    )
    assert.throws(() => lstatSync(target))
    assert.equal(readFileSync(source, 'utf8'), '[user]\n  email = host@example.com\n')
  })
})
