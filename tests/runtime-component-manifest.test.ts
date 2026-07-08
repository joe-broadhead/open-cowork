import { buildRuntimeComponentManifest, buildRuntimeComponentVerificationReport, formatRuntimeComponentVerificationFailure, runtimeComponentDevelopmentOverrideFromEnv, runtimeComponentVerificationIsEnforced, verifyRuntimeComponentManifest, writeRuntimeComponentManifest } from '@open-cowork/runtime-host/runtime-component-manifest'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RUNTIME_COMPONENT_MANIFEST_FORMAT, type RuntimeComponentManifest } from '../packages/shared/src/runtime.ts'
function manifest(overrides: Partial<RuntimeComponentManifest> = {}): RuntimeComponentManifest {
  return {
    format: RUNTIME_COMPONENT_MANIFEST_FORMAT,
    generatedAt: '2026-06-02T00:00:00.000Z',
    components: [{
      id: 'opencode-cli',
      kind: 'opencode-cli',
      version: '1.15.5',
      upstreamVersion: '1.15.5',
      platform: 'darwin',
      arch: 'arm64',
      path: '/Users/alice/private/open-cowork/opencode',
      sha256: `sha256:${'a'.repeat(64)}`,
      observedSha256: `${'a'.repeat(64)}`,
      sourcePolicy: 'bundled',
      compatibilityStatus: 'supported',
      requiredCapabilities: ['sessions', 'permissions', 'questions'],
    }],
    ...overrides,
  }
}

test('runtime component manifest verification passes with matching hash evidence', () => {
  const report = verifyRuntimeComponentManifest({
    manifest: manifest(),
    now: () => new Date('2026-06-02T01:00:00.000Z'),
  })

  assert.equal(report.ok, true)
  assert.equal(report.checkedAt, '2026-06-02T01:00:00.000Z')
  assert.equal(report.issues.length, 0)
  assert.equal(report.components[0]?.path?.includes('/Users/alice/private'), false)
  assert.equal(report.components[0]?.path?.includes('/Users/[REDACTED_HOME]'), true)
  assert.equal(report.components[0]?.signature, undefined)
})

test('runtime component manifest verification fails closed without release evidence', () => {
  const report = verifyRuntimeComponentManifest({
    manifest: manifest({
      components: [{
        id: 'helper',
        kind: 'helper-sidecar',
        version: '1.0.0',
        path: '/opt/open-cowork/helper',
        sourcePolicy: 'managed',
        compatibilityStatus: 'supported',
      }],
    }),
  })

  assert.equal(report.ok, false)
  assert.equal(report.issues.some((issue) => issue.code === 'component_provenance_missing'), true)
})

test('runtime component manifest verification reports invalid and mismatched hashes', () => {
  const report = verifyRuntimeComponentManifest({
    manifest: manifest({
      components: [{
        id: 'worker-image',
        kind: 'worker-image',
        version: '2026.06.02',
        url: 'oci://registry.example.com/open-cowork/worker:2026.06.02',
        sha256: `sha256:${'b'.repeat(64)}`,
        observedSha256: `sha256:${'c'.repeat(64)}`,
        sourcePolicy: 'managed',
        compatibilityStatus: 'supported',
      }],
    }),
  })

  assert.equal(report.ok, false)
  assert.equal(report.issues.some((issue) => issue.code === 'component_hash_mismatch'), true)
})

test('runtime component manifest development override bypasses missing provenance but not blocked compatibility', () => {
  const report = verifyRuntimeComponentManifest({
    developmentOverride: {
      enabled: true,
      reason: 'local unsigned helper while release signatures are generated',
    },
    manifest: manifest({
      components: [
        {
          id: 'unsigned-helper',
          kind: 'helper-sidecar',
          version: '1.0.0',
          path: '/opt/open-cowork/helper',
          sourcePolicy: 'development',
          compatibilityStatus: 'supported',
        },
        {
          id: 'blocked-helper',
          kind: 'helper-sidecar',
          version: '1.0.0',
          path: '/opt/open-cowork/blocked-helper',
          sourcePolicy: 'development',
          compatibilityStatus: 'blocked',
        },
      ],
    }),
  })

  assert.equal(report.developmentOverride, true)
  assert.equal(report.issues.some((issue) => issue.code === 'component_provenance_missing'), false)
  assert.equal(report.ok, false)
  assert.equal(report.issues.some((issue) => issue.code === 'component_compatibility_blocked'), true)
})

test('runtime component manifest builder records observed component versions and hashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-components-'))
  const cliPath = join(dir, 'opencode')
  const sdkPath = join(dir, 'sdk-package.json')
  const workflowPath = join(dir, 'workflow.js')
  const agentPath = join(dir, 'agent.js')
  const semanticPath = join(dir, 'semantic.js')

  try {
    writeFileSync(cliPath, 'opencode-binary')
    writeFileSync(sdkPath, JSON.stringify({ version: '2.3.4' }))
    writeFileSync(workflowPath, 'workflow')
    writeFileSync(agentPath, 'agent')
    writeFileSync(semanticPath, 'semantic')

    const observedManifest = await buildRuntimeComponentManifest({
      componentPaths: {
        'opencode-cli': cliPath,
        'opencode-sdk': sdkPath,
        'workflow-mcp': workflowPath,
        'agent-tool-mcp': agentPath,
        'semantic-ui-mcp': semanticPath,
      },
      componentVersions: {
        'opencode-cli': 'opencode 1.15.5',
        'opencode-sdk': '2.3.4',
        'workflow-mcp': '0.0.0',
        'agent-tool-mcp': '0.0.0',
        'semantic-ui-mcp': '0.0.0',
      },
      generatedAt: '2026-06-02T00:00:00.000Z',
      isPackaged: false,
    })

    const cli = observedManifest.components.find((component) => component.id === 'opencode-cli')
    assert.equal(cli?.version, '1.15.5')
    assert.equal(cli?.observedVersion, '1.15.5')
    assert.equal(cli?.sourcePolicy, 'development')
    assert.equal(cli?.observedSha256, createHash('sha256').update('opencode-binary').digest('hex'))
    assert.equal(observedManifest.components.some((component) => component.id === 'semantic-ui-mcp'), true)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('runtime component manifest builder does not hash symlinked component paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-components-'))
  const targetPath = join(dir, 'target-opencode')
  const symlinkPath = join(dir, 'opencode-link')

  try {
    writeFileSync(targetPath, 'opencode-binary')
    symlinkSync(targetPath, symlinkPath)

    const observedManifest = await buildRuntimeComponentManifest({
      componentPaths: {
        'opencode-cli': symlinkPath,
      },
      componentVersions: {
        'opencode-cli': 'opencode 1.15.5',
      },
      generatedAt: '2026-06-02T00:00:00.000Z',
      isPackaged: false,
    })

    const cli = observedManifest.components.find((component) => component.id === 'opencode-cli')
    assert.equal(cli?.observedSha256, undefined)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('runtime component verification merges expected manifests with observed hashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-components-'))
  const cliPath = join(dir, 'opencode')
  const manifestPath = join(dir, 'runtime-components.manifest.json')

  try {
    writeFileSync(cliPath, 'observed-opencode')
    writeFileSync(manifestPath, `${JSON.stringify(manifest({
      components: [{
        id: 'opencode-cli',
        kind: 'opencode-cli',
        version: '1.15.5',
        path: cliPath,
        sha256: `sha256:${'b'.repeat(64)}`,
        sourcePolicy: 'bundled',
        compatibilityStatus: 'supported',
      }],
    }), null, 2)}\n`)

    const report = await buildRuntimeComponentVerificationReport({
      componentPaths: { 'opencode-cli': cliPath },
      componentVersions: { 'opencode-cli': '1.15.5' },
      manifestPath,
      now: () => new Date('2026-06-02T01:00:00.000Z'),
    })

    assert.equal(report.ok, false)
    assert.equal(report.issues.some((issue) => issue.code === 'component_hash_mismatch'), true)
    assert.match(formatRuntimeComponentVerificationFailure(report), /opencode-cli:component_hash_mismatch/)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('runtime component verification reports missing packaged manifests with observed evidence', async () => {
  const report = await buildRuntimeComponentVerificationReport({
    componentVersions: {
      'opencode-cli': '1.15.5',
      'opencode-sdk': '2.3.4',
      'workflow-mcp': '0.0.0',
      'agent-tool-mcp': '0.0.0',
      'semantic-ui-mcp': '0.0.0',
    },
    isPackaged: true,
    manifestPath: '/definitely/missing/runtime-components.manifest.json',
  })

  assert.equal(report.ok, false)
  assert.equal(report.issues.some((issue) => issue.code === 'component_manifest_missing'), true)
  assert.equal(report.components.length > 0, true)
  assert.equal(runtimeComponentVerificationIsEnforced({ isPackaged: true }), true)
  assert.equal(runtimeComponentVerificationIsEnforced({ isPackaged: false }), false)
  assert.equal(runtimeComponentVerificationIsEnforced({ isPackaged: false, env: { OPEN_COWORK_RUNTIME_COMPONENT_ENFORCE: '1' } }), true)
})

test('runtime component development override is explicit and reason-bearing', () => {
  assert.equal(runtimeComponentDevelopmentOverrideFromEnv({}), undefined)
  assert.deepEqual(
    runtimeComponentDevelopmentOverrideFromEnv({
      OPEN_COWORK_RUNTIME_COMPONENT_DEV_OVERRIDE_REASON: 'unsigned local component build',
    }),
    { enabled: true, reason: 'unsigned local component build' },
  )
})

const NULL_COMPONENT_PATHS = {
  'opencode-cli': null,
  'opencode-sdk': null,
  'workflow-mcp': null,
  'agent-tool-mcp': null,
  'semantic-ui-mcp': null,
} as const
const COMPONENT_VERSIONS = {
  'opencode-cli': '1.15.5',
  'opencode-sdk': '2.3.4',
  'workflow-mcp': '0.0.0',
  'agent-tool-mcp': '0.0.0',
  'semantic-ui-mcp': '0.0.0',
} as const

test('writeRuntimeComponentManifest pins the build-time hash and catches post-signing tamper (#907)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-manifest-'))
  const cliPath = join(dir, 'opencode')
  const manifestPath = join(dir, 'runtime-components.manifest.json')
  try {
    writeFileSync(cliPath, 'trusted-opencode-bytes')
    const expectedSha = createHash('sha256').update('trusted-opencode-bytes').digest('hex')

    const written = await writeRuntimeComponentManifest(manifestPath, {
      componentPaths: { ...NULL_COMPONENT_PATHS, 'opencode-cli': cliPath },
      componentVersions: COMPONENT_VERSIONS,
      isPackaged: true,
    })
    // The trusted manifest pins the authoritative sha256 (not an observed-evidence field).
    const cli = written.components.find((component) => component.id === 'opencode-cli')
    assert.equal(cli?.sha256, expectedSha)
    assert.equal(cli?.observedSha256, undefined)

    // Untouched binary verifies clean (no hash mismatch).
    const clean = await buildRuntimeComponentVerificationReport({
      componentPaths: { ...NULL_COMPONENT_PATHS, 'opencode-cli': cliPath },
      componentVersions: COMPONENT_VERSIONS,
      manifestPath,
      isPackaged: true,
    })
    assert.equal(clean.issues.some((issue) => issue.code === 'component_hash_mismatch'), false)

    // A post-signing modification is caught and fails closed.
    writeFileSync(cliPath, 'tampered-opencode-bytes')
    const tampered = await buildRuntimeComponentVerificationReport({
      componentPaths: { ...NULL_COMPONENT_PATHS, 'opencode-cli': cliPath },
      componentVersions: COMPONENT_VERSIONS,
      manifestPath,
      isPackaged: true,
    })
    assert.equal(tampered.ok, false)
    assert.equal(tampered.issues.some((issue) => issue.code === 'component_hash_mismatch'), true)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('development override is honored in local dev but ignored in packaged builds (#907)', async () => {
  const base = {
    componentPaths: NULL_COMPONENT_PATHS,
    componentVersions: COMPONENT_VERSIONS,
    env: { OPEN_COWORK_RUNTIME_COMPONENT_DEV_OVERRIDE_REASON: 'unsigned local component build' },
    manifestPath: '/definitely/missing/runtime-components.manifest.json',
  }
  // Unpackaged local dev: the env override applies.
  const dev = await buildRuntimeComponentVerificationReport({ ...base, isPackaged: false })
  assert.equal(dev.developmentOverride, true)
  // Packaged: the same env override cannot defeat the integrity anchor.
  const packaged = await buildRuntimeComponentVerificationReport({ ...base, isPackaged: true })
  assert.equal(packaged.developmentOverride, false)
})
