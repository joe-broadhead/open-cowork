import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pruneCloudRuntime } from '../scripts/cloud-runtime-prune-core.mjs'

function writeFixtureFile(root: string, path: string, content = `${path}\n`) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function writeFixturePackage(
  root: string,
  path: string,
  name: string,
  dependencies: Record<string, string> = {},
) {
  writeFixtureFile(root, `${path}/package.json`, `${JSON.stringify({
    name,
    private: true,
    dependencies,
  }, null, 2)}\n`)
  writeFixtureFile(root, `${path}/dist/index.js`, `export const packageName = ${JSON.stringify(name)}\n`)
}

function createPruneFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'open-cowork-cloud-prune-'))
  const outDir = join(repoRoot, '.runtime')
  writeFixtureFile(repoRoot, 'package.json', `${JSON.stringify({
    name: 'fixture',
    private: true,
    dependencies: {
      '@fixture/runtime': 'workspace:*',
      'fixture-external': '1.0.0',
      'fixture-runtime-cli': '1.0.0',
    },
  }, null, 2)}\n`)
  writeFixtureFile(repoRoot, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  writeFixtureFile(repoRoot, 'pnpm-workspace.yaml', [
    'packages:',
    '  - apps/*',
    '  - mcps/*',
    '  - packages/*',
    '',
  ].join('\n'))
  writeFixtureFile(repoRoot, '.npmrc', 'engine-strict=true\n')
  writeFixtureFile(repoRoot, 'open-cowork.config.schema.json', '{}\n')
  writeFixtureFile(repoRoot, 'LICENSE', 'fixture license\n')
  writeFixtureFile(repoRoot, 'THIRD_PARTY_NOTICES.md', '# Notices\n')
  writeFixtureFile(repoRoot, 'THIRD_PARTY_LICENSES/fixture/LICENSE', 'dependency license\n')
  writeFixtureFile(repoRoot, 'open-cowork.config.json', `${JSON.stringify({
    tools: [
      { id: 'fixture-tool', namespace: 'fixture-tool' },
      { id: 'external-tool', namespace: 'external-tool' },
    ],
    mcps: [
      { name: 'fixture-tool', type: 'local', packageName: 'fixture-tool' },
      {
        name: 'external-tool',
        type: 'local',
        command: ['external-tool', 'serve'],
      },
    ],
    skills: [
      { sourceName: 'fixture-skill' },
      { sourceName: 'external-tool-skill', toolIds: ['external-tool'] },
    ],
    cloud: {
      defaultProfile: 'full',
      profiles: {
        full: {
          tools: ['fixture-tool', 'external-tool'],
          mcps: ['fixture-tool', 'external-tool'],
        },
      },
    },
  }, null, 2)}\n`)

  writeFixturePackage(repoRoot, 'packages/runtime', '@fixture/runtime', {
    '@fixture/shared': 'workspace:*',
  })
  writeFixtureFile(repoRoot, 'packages/runtime-source/package.json', `${JSON.stringify({
    name: '@fixture/runtime-source',
    private: true,
    dependencies: {
      '@fixture/runtime': 'workspace:*',
    },
  }, null, 2)}\n`)
  writeFixturePackage(repoRoot, 'packages/shared', '@fixture/shared')
  writeFixturePackage(repoRoot, 'packages/unrelated', '@fixture/unrelated')
  writeFixtureFile(repoRoot, 'packages/unrelated/dist/large-unused.js', 'x'.repeat(32_000))
  writeFixturePackage(repoRoot, 'mcps/fixture-tool', '@fixture/mcp-fixture-tool', {
    '@fixture/shared': 'workspace:*',
  })

  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs')
  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud-migrate.mjs')
  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/mcp-knowledge.mjs')
  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/browser-renderer/browser.html')
  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/browser-renderer/chart-frame.html')
  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/browser-renderer/assets/app.js')
  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/stale-bundle.mjs')
  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs.map', '{"sourcesContent":["secret source"]}\n')
  writeFixtureFile(repoRoot, 'apps/desktop/dist/cloud/cloud-runtime-workspaces.json', `${JSON.stringify({
    schemaVersion: 3,
    bundledSourceWorkspaces: ['packages/runtime-source'],
    externalPackages: ['@fixture/runtime', 'fixture-external'],
    runtimePackages: ['fixture-runtime-cli'],
    runtimeAssets: [
      'browser-renderer/assets/app.js',
      'browser-renderer/browser.html',
      'browser-renderer/chart-frame.html',
      'mcp-knowledge.mjs',
      'open-cowork-cloud-migrate.mjs',
      'open-cowork-cloud.mjs',
    ],
  }, null, 2)}\n`)
  writeFixtureFile(repoRoot, 'apps/desktop/dist/main/unrelated-desktop.js')
  writeFixtureFile(repoRoot, 'apps/desktop/runtime-config/AGENTS.md', '# Runtime agent\n')
  writeFixtureFile(repoRoot, 'skills/fixture-skill/SKILL.md', '# Fixture skill\n')
  writeFixtureFile(repoRoot, 'skills/external-tool-skill/SKILL.md', '# External tool skill\n')
  writeFixtureFile(repoRoot, 'skills/unconfigured-skill/SKILL.md', '# Unconfigured\n')

  return { repoRoot, outDir }
}

test('cloud runtime prune follows the production workspace graph and explicit dynamic assets', () => {
  const fixture = createPruneFixture()
  try {
    const first = pruneCloudRuntime(fixture)
    const firstManifest = readFileSync(join(fixture.outDir, 'cloud-runtime-manifest.json'), 'utf8')

    assert.deepEqual(first.productionWorkspaces, [
      'mcps/fixture-tool',
      'packages/runtime',
      'packages/shared',
    ])
    assert.deepEqual(first.bundleSourceWorkspaces, ['packages/runtime-source'])
    assert.deepEqual(first.externalPackages, ['@fixture/runtime', 'fixture-external'])
    assert.deepEqual(first.runtimePackages, ['fixture-runtime-cli'])
    assert.deepEqual(first.dynamicAssets.mcpWorkspaces, ['mcps/fixture-tool'])
    assert.deepEqual(first.dynamicAssets.skills, ['skills/fixture-skill'])
    const productionConfig = JSON.parse(
      readFileSync(join(fixture.outDir, 'open-cowork.config.json'), 'utf8'),
    )
    assert.deepEqual(productionConfig.mcps.map((mcp: { name: string }) => mcp.name), ['fixture-tool'])
    assert.deepEqual(productionConfig.tools.map((tool: { id: string }) => tool.id), ['fixture-tool'])
    assert.deepEqual(
      productionConfig.skills.map((skill: { sourceName: string }) => skill.sourceName),
      ['fixture-skill'],
    )
    assert.deepEqual(productionConfig.cloud.profiles.full.mcps, ['fixture-tool'])
    assert.deepEqual(productionConfig.cloud.profiles.full.tools, ['fixture-tool'])

    assert.equal(existsSync(join(fixture.outDir, 'packages/runtime/dist/index.js')), true)
    assert.equal(existsSync(join(fixture.outDir, 'packages/shared/dist/index.js')), true)
    assert.equal(existsSync(join(fixture.outDir, 'mcps/fixture-tool/dist/index.js')), true)
    assert.equal(existsSync(join(fixture.outDir, 'packages/runtime-source')), false)
    assert.equal(existsSync(join(fixture.outDir, 'packages/unrelated')), false)
    assert.equal(existsSync(join(fixture.outDir, 'apps/desktop/dist/main')), false)
    assert.equal(existsSync(join(fixture.outDir, 'apps/desktop/dist/cloud/stale-bundle.mjs')), false)
    assert.equal(existsSync(join(fixture.outDir, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs.map')), false)
    assert.equal(existsSync(join(fixture.outDir, 'apps/desktop/dist/cloud/browser-renderer/chart-frame.html')), true)
    assert.equal(existsSync(join(fixture.outDir, 'skills/unconfigured-skill')), false)
    assert.equal(existsSync(join(fixture.outDir, 'apps/desktop/runtime-config/AGENTS.md')), true)
    assert.equal(existsSync(join(fixture.outDir, 'THIRD_PARTY_NOTICES.md')), true)
    assert.equal(existsSync(join(fixture.outDir, 'THIRD_PARTY_LICENSES/fixture/LICENSE')), true)
    assert.ok(first.comparison.savedBytes > 0)
    assert.ok(first.comparison.savedPercent > 0)

    const second = pruneCloudRuntime(fixture)
    const secondManifest = readFileSync(join(fixture.outDir, 'cloud-runtime-manifest.json'), 'utf8')
    assert.deepEqual(second, first)
    assert.equal(secondManifest, firstManifest)
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true })
  }
})

test('cloud runtime prune fails before replacing output when a declared runtime artifact is missing', () => {
  const fixture = createPruneFixture()
  try {
    mkdirSync(fixture.outDir, { recursive: true })
    writeFixtureFile(fixture.outDir, 'sentinel.txt', 'preserve me\n')
    rmSync(join(fixture.repoRoot, 'mcps/fixture-tool/dist'), { recursive: true, force: true })

    assert.throws(
      () => pruneCloudRuntime(fixture),
      /CLOUD_RUNTIME_ARTIFACT_MISSING.*mcps\/fixture-tool\/dist/,
    )
    assert.equal(readFileSync(join(fixture.outDir, 'sentinel.txt'), 'utf8'), 'preserve me\n')
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true })
  }
})

test('cloud runtime prune requires every external package at the root production resolution boundary', () => {
  const fixture = createPruneFixture()
  try {
    const manifestPath = join(fixture.repoRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    delete manifest.dependencies['fixture-external']
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    mkdirSync(fixture.outDir, { recursive: true })
    writeFixtureFile(fixture.outDir, 'sentinel.txt', 'preserve me\n')

    assert.throws(
      () => pruneCloudRuntime(fixture),
      /CLOUD_RUNTIME_EXTERNAL_DEPENDENCY_MISSING.*fixture-external/,
    )
    assert.equal(readFileSync(join(fixture.outDir, 'sentinel.txt'), 'utf8'), 'preserve me\n')
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true })
  }
})

test('cloud runtime prune requires every executable runtime package at the root production resolution boundary', () => {
  const fixture = createPruneFixture()
  try {
    const manifestPath = join(fixture.repoRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    delete manifest.dependencies['fixture-runtime-cli']
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    mkdirSync(fixture.outDir, { recursive: true })
    writeFixtureFile(fixture.outDir, 'sentinel.txt', 'preserve me\n')

    assert.throws(
      () => pruneCloudRuntime(fixture),
      /CLOUD_RUNTIME_EXTERNAL_DEPENDENCY_MISSING.*fixture-runtime-cli/,
    )
    assert.equal(readFileSync(join(fixture.outDir, 'sentinel.txt'), 'utf8',), 'preserve me\n')
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true })
  }
})

test('cloud runtime prune rejects an explicitly enabled unsupported bare MCP before replacing output', () => {
  const fixture = createPruneFixture()
  try {
    const configPath = join(fixture.repoRoot, 'open-cowork.config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.cloud = {
      defaultProfile: 'full',
      profiles: {
        full: {
          mcps: ['fixture-tool'],
        },
        'unsafe-local': {
          mcps: ['fixture-tool', 'external-tool'],
          runtime: {
            allowedLocalMcpNames: ['external-tool'],
          },
        },
      },
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    mkdirSync(fixture.outDir, { recursive: true })
    writeFixtureFile(fixture.outDir, 'sentinel.txt', 'preserve me\n')

    assert.throws(
      () => pruneCloudRuntime(fixture),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'CLOUD_RUNTIME_BARE_MCP_COMMAND_UNSUPPORTED'
        && 'path' in error
        && error.path === 'open-cowork.config.json.mcps[1].command'
      ),
    )
    assert.equal(readFileSync(join(fixture.outDir, 'sentinel.txt'), 'utf8'), 'preserve me\n')
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true })
  }
})

test('cloud runtime prune rejects an enabled command launcher even when packageName is present', () => {
  for (const packageName of ['fixture-tool', '   ']) {
    const fixture = createPruneFixture()
    try {
      const configPath = join(fixture.repoRoot, 'open-cowork.config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      config.mcps[1].packageName = packageName
      config.cloud.profiles['unsafe-local'] = {
        mcps: ['external-tool'],
        runtime: {
          allowedLocalMcpNames: ['external-tool'],
        },
      }
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

      assert.throws(
        () => pruneCloudRuntime(fixture),
        (error: unknown) => (
          error instanceof Error
          && 'code' in error
          && error.code === 'CLOUD_RUNTIME_BARE_MCP_COMMAND_UNSUPPORTED'
          && 'path' in error
          && error.path === 'open-cowork.config.json.mcps[1].command'
        ),
      )
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
  }
})

test('cloud runtime prune rejects unsafe configured skill paths', () => {
  const fixture = createPruneFixture()
  try {
    const configPath = join(fixture.repoRoot, 'open-cowork.config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.skills = [{ sourceName: '../THIRD_PARTY_LICENSES' }]
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    assert.throws(
      () => pruneCloudRuntime(fixture),
      /CLOUD_RUNTIME_DYNAMIC_ASSET_NAME_INVALID/,
    )
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true })
  }
})

test('cloud runtime prune rejects symlinks inside configured skill assets', {
  skip: process.platform === 'win32',
}, () => {
  const fixture = createPruneFixture()
  try {
    symlinkSync(
      join(fixture.repoRoot, 'THIRD_PARTY_NOTICES.md'),
      join(fixture.repoRoot, 'skills/fixture-skill/notices-link'),
    )
    assert.throws(
      () => pruneCloudRuntime(fixture),
      /CLOUD_RUNTIME_DYNAMIC_ASSET_SYMLINK.*skills\/fixture-skill\/notices-link/,
    )
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true })
  }
})

test('cloud runtime prune rejects symlinks across every copied payload tree before replacing output', {
  skip: process.platform === 'win32',
}, () => {
  for (const path of [
    'THIRD_PARTY_LICENSES/fixture/notices-link',
    'packages/runtime/dist/notices-link',
  ]) {
    const fixture = createPruneFixture()
    try {
      mkdirSync(fixture.outDir, { recursive: true })
      writeFixtureFile(fixture.outDir, 'sentinel.txt', 'preserve me\n')
      symlinkSync(
        join(fixture.repoRoot, 'THIRD_PARTY_NOTICES.md'),
        join(fixture.repoRoot, path),
      )

      assert.throws(
        () => pruneCloudRuntime(fixture),
        new RegExp(`CLOUD_RUNTIME_PAYLOAD_SYMLINK.*${path.replaceAll('/', '\\/')}`),
      )
      assert.equal(readFileSync(join(fixture.outDir, 'sentinel.txt'), 'utf8'), 'preserve me\n')
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
  }
})
