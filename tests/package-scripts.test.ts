import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rendererWorkspaceSourceAliases } from '../packages/app/vite.workspace-source-aliases.ts'
import {
  assertElectronWorkspaceSourceModule,
  electronWorkspaceSourceViteConfig,
} from '../apps/desktop/vite.electron-workspace-source-aliases.ts'

type PackageJson = {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
  engines?: Record<string, string>
  pnpm?: {
    auditConfig?: {
      ignoreCves?: string[]
      ignoreGhsas?: string[]
    }
  }
  scripts?: Record<string, string>
}

type KnipJson = {
  ignore?: string[]
  workspaces?: Record<string, {
    entry?: string[]
    project?: string[]
  }>
}

const repoRoot = new URL('../', import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson
const desktopPackageJson = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8')) as PackageJson
const appPackageJson = JSON.parse(readFileSync(new URL('../packages/app/package.json', import.meta.url), 'utf8')) as PackageJson
function parseJsonc<T>(source: string): T {
  return JSON.parse(
    source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n'),
  ) as T
}

const knipJson = parseJsonc<KnipJson>(readFileSync(new URL('../knip.jsonc', import.meta.url), 'utf8'))
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const docsWorkflow = readFileSync(new URL('../.github/workflows/docs.yml', import.meta.url), 'utf8')
const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const monthlyMaintenanceWorkflow = readFileSync(new URL('../.github/workflows/monthly-maintenance.yml', import.meta.url), 'utf8')
const weeklyGatewayWorkflow = readFileSync(new URL('../.github/workflows/weekly-gateway.yml', import.meta.url), 'utf8')
const dependabotConfig = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')
const npmrc = readFileSync(new URL('../.npmrc', import.meta.url), 'utf8')
const readmeDocs = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const contributingDocs = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8')
const gettingStartedDocs = readFileSync(new URL('../docs/getting-started.md', import.meta.url), 'utf8')
const firstContributionDocs = readFileSync(new URL('../docs/first-contribution.md', import.meta.url), 'utf8')
const securityModelDocs = readFileSync(new URL('../docs/security-model.md', import.meta.url), 'utf8')
const releaseChecklistDocs = readFileSync(new URL('../docs/release-checklist.md', import.meta.url), 'utf8')
const mkdocsConfig = readFileSync(new URL('../mkdocs.yml', import.meta.url), 'utf8')
const linuxNode22PerfBaseline = JSON.parse(readFileSync(new URL('../benchmarks/perf-baseline.linux-x64-node22.json', import.meta.url), 'utf8')) as {
  environment?: {
    platform?: string
    arch?: string
    node?: string
  }
}
const nvmrc = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim()
const packagingDocs = readFileSync(new URL('../docs/packaging-and-releases.md', import.meta.url), 'utf8')
const smokeHelpers = readFileSync(new URL('../apps/desktop/tests/smoke-helpers.ts', import.meta.url), 'utf8')

function requireScript(name: string, source: PackageJson = packageJson): string {
  const script = source.scripts?.[name]
  assert.equal(typeof script, 'string', `Missing package script: ${name}`)
  return script
}

function splitScriptSteps(script: string): string[] {
  return script.split('&&').map((step) => step.trim())
}

function workspacePackageJson(workspace: string): PackageJson {
  return JSON.parse(
    readFileSync(new URL(`../${workspace}/package.json`, import.meta.url), 'utf8'),
  ) as PackageJson
}

function sourceWorkspacePackageDirs(): string[] {
  const topLevelWorkspaces = ['apps', 'packages', 'mcps'].flatMap((scope) => {
    return readdirSync(new URL(`../${scope}/`, import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${scope}/${entry.name}`)
      .filter((workspace) => existsSync(new URL(`${workspace}/package.json`, repoRoot)))
      .filter((workspace) => existsSync(new URL(`${workspace}/src/`, repoRoot)))
  })
  const wikiPackageWorkspaces = readdirSync(new URL('../products/wiki/packages/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `products/wiki/packages/${entry.name}`)
    .filter((workspace) => existsSync(new URL(`${workspace}/package.json`, repoRoot)))

  return [
    ...topLevelWorkspaces,
    'products/gateway',
    'products/wiki',
    ...wikiPackageWorkspaces,
  ].sort()
}

function rootBuildWorkspacePackageDirs(): string[] {
  return ['apps', 'packages', 'mcps'].flatMap((scope) => {
    return readdirSync(new URL(`../${scope}/`, import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${scope}/${entry.name}`)
      .filter((workspace) => existsSync(new URL(`${workspace}/package.json`, repoRoot)))
  }).sort()
}

function knipConfigForWorkspace(workspace: string): KnipJson['workspaces'][string] | undefined {
  const workspaces = knipJson.workspaces || {}
  if (workspaces[workspace]) return workspaces[workspace]

  return Object.entries(workspaces).find(([pattern]) => {
    if (!pattern.endsWith('/*')) return false
    const prefix = pattern.slice(0, -1)
    return workspace.startsWith(prefix) && !workspace.slice(prefix.length).includes('/')
  })?.[1]
}

test('root node test scripts prepare generated shared artifacts before tests run', () => {
  assert.deepEqual(splitScriptSteps(requireScript('test:prepare')), [
    'pnpm design-tokens:build',
    'pnpm --recursive --filter "./packages/*" --filter "./mcps/*" --filter @open-cowork/channel-gateway --filter @open-cowork/standalone-gateway run build',
    'node scripts/ensure-electron-binary.mjs',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test')), [
    'pnpm test:prepare',
    'pnpm --recursive --filter "./packages/*" --filter "./mcps/*" --filter @open-cowork/channel-gateway --filter @open-cowork/standalone-gateway run test',
    'node scripts/run-node-tests.mjs',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:coverage:node')), [
    'pnpm test:prepare',
    'pnpm --recursive --filter "./packages/*" --filter "./mcps/*" --filter @open-cowork/channel-gateway --filter @open-cowork/standalone-gateway run test',
    'node scripts/run-node-tests.mjs --coverage',
    'node scripts/run-workspace-node-tests.mjs --coverage',
    'node scripts/coverage-summary.mjs --check --node-only --no-write',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:coverage')), [
    'pnpm test:coverage:node',
    'pnpm test:coverage:renderer',
    'node scripts/coverage-summary.mjs --check',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:windows-prepackage')), [
    'pnpm test:prepare',
    'node scripts/check-preload-channels.mjs',
    'node scripts/run-node-tests.mjs tests/artifact-index.test.ts tests/session-artifact-access.test.ts tests/ipc-handler-registration.test.ts tests/desktop-after-pack.test.ts tests/update-service.test.ts tests/update-check-version.test.ts tests/update-release-source.test.ts tests/release-windows-signing-mode.test.ts tests/runtime-environment.test.ts tests/packaged-executable-preflight.test.ts tests/windows-signing-targets.test.ts',
  ])

  assert.equal(requireScript('test:coverage:renderer'), 'pnpm --filter @open-cowork/app test:coverage:renderer')
})

test('workspace build, typecheck, and test scripts operate on their own package only', () => {
  for (const workspace of sourceWorkspacePackageDirs()) {
    const manifest = workspacePackageJson(workspace)
    for (const scriptName of ['build', 'typecheck', 'test']) {
      const script = manifest.scripts?.[scriptName]
      if (!script) continue
      for (const step of splitScriptSteps(script)) {
        assert.doesNotMatch(
          step,
          /^pnpm\b.*(?:--filter|--dir)\b.*\bbuild(?::[\w-]+)?\b/,
          `${manifest.name || workspace} ${scriptName} must not build a workspace dependency`,
        )
        if (scriptName === 'test') {
          assert.doesNotMatch(
            step,
            /^pnpm (?:run )?build(?:\s|$)/,
            `${manifest.name || workspace} test must consume root-prepared artifacts without rebuilding itself`,
          )
        }
      }
    }
    for (const lifecycleName of ['prebuild', 'pretypecheck', 'pretest']) {
      assert.doesNotMatch(
        manifest.scripts?.[lifecycleName] || '',
        /^pnpm\b/,
        `${manifest.name || workspace} ${lifecycleName} must not hide workspace orchestration`,
      )
    }
  }
})

test('scoped tests reject missing or stale workspace distribution artifacts', () => {
  const sourceTestWorkspaces = [
    'packages/gateway-channel',
    'packages/gateway-provider-cli',
    'packages/gateway-provider-discord',
    'packages/gateway-provider-email',
    'packages/gateway-provider-signal',
    'packages/gateway-provider-slack',
    'packages/gateway-provider-telegram',
    'packages/gateway-provider-webhook',
    'packages/gateway-provider-whatsapp',
    'packages/gateway-testing',
  ]
  const distributionTestWorkspaces = [
    'apps/channel-gateway',
    'apps/standalone-gateway',
    'mcps/agents',
    'mcps/charts',
    'mcps/knowledge',
    'mcps/semantic-ui',
    'mcps/skills',
    'mcps/workflows',
    'packages/cloud-client',
    'packages/ui',
  ]

  for (const workspace of sourceTestWorkspaces) {
    assert.equal(
      splitScriptSteps(requireScript('test', workspacePackageJson(workspace)))[0],
      'node ../../scripts/workspace-build-freshness.mjs',
      `${workspace} scoped tests must validate workspace dependency output freshness`,
    )
  }
  for (const workspace of distributionTestWorkspaces) {
    assert.equal(
      splitScriptSteps(requireScript('test', workspacePackageJson(workspace)))[0],
      'node ../../scripts/workspace-build-freshness.mjs --self',
      `${workspace} scoped tests must validate their own and dependency output freshness`,
    )
  }
  for (const scriptName of ['test:renderer', 'test:coverage:renderer']) {
    assert.equal(
      splitScriptSteps(requireScript(scriptName, appPackageJson))[0],
      'node ../../scripts/workspace-build-freshness.mjs',
      `packages/app ${scriptName} must validate workspace dependency output freshness`,
    )
  }
})

test('root build, typecheck, and test preparation each use one topological build pass', () => {
  assert.deepEqual(splitScriptSteps(requireScript('build')), [
    'pnpm design-tokens:build',
    'pnpm --recursive --filter "./packages/*" --filter "./mcps/*" --filter "./apps/*" run build',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('typecheck')), [
    'pnpm design-tokens:build',
    'pnpm --recursive --filter "./packages/*" run build',
    'pnpm --recursive --filter @open-cowork/app --filter @open-cowork/cloud-server --filter "./mcps/*" --filter "./apps/*" run typecheck',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('test:prepare')), [
    'pnpm design-tokens:build',
    'pnpm --recursive --filter "./packages/*" --filter "./mcps/*" --filter @open-cowork/channel-gateway --filter @open-cowork/standalone-gateway run build',
    'node scripts/ensure-electron-binary.mjs',
  ])
})

test('root pnpm filters are portable across POSIX and Windows script shells', () => {
  for (const [name, script] of Object.entries(packageJson.scripts || {})) {
    assert.doesNotMatch(
      script,
      /--filter\s+'[^']+'/,
      `${name} must not use POSIX-only single-quoted pnpm filters`,
    )
  }
})

test('pnpm topological execution invokes each dependency once and fails deterministically', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'open-cowork-pnpm-dag-'))
  const invocationLog = join(fixtureRoot, 'invocations.log')
  const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const writeManifest = (
    directory: string,
    name: string,
    dependencies: Record<string, string> = {},
  ) => {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name,
      private: true,
      scripts: {
        build: `node ../../record-build.mjs ${name}`,
      },
      dependencies,
    }))
  }
  const runBuild = (failPackage = '') => {
    const startedAt = Date.now()
    const result = spawnSync(
      pnpmExecutable,
      ['--dir', fixtureRoot, '--recursive', 'run', 'build'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          OPEN_COWORK_BUILD_INVOCATIONS: invocationLog,
          OPEN_COWORK_FAIL_BUILD: failPackage,
        },
        timeout: 10_000,
      },
    )
    return {
      ...result,
      elapsedMs: Date.now() - startedAt,
    }
  }

  try {
    writeFileSync(join(fixtureRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({
      name: 'topology-fixture',
      private: true,
    }))
    writeFileSync(
      join(fixtureRoot, 'record-build.mjs'),
      [
        "import { appendFileSync } from 'node:fs'",
        'const name = process.argv[2]',
        "appendFileSync(process.env.OPEN_COWORK_BUILD_INVOCATIONS, `${name}\\n`)",
        'if (process.env.OPEN_COWORK_FAIL_BUILD === name) process.exit(17)',
      ].join('\n'),
    )
    for (const name of ['shared', 'channel', 'app']) {
      const directory = join(fixtureRoot, 'packages', name)
      const parent = name === 'shared'
        ? {}
        : name === 'channel'
          ? { shared: 'workspace:*' }
          : { channel: 'workspace:*' }
      mkdirSync(directory, { recursive: true })
      writeManifest(directory, name, parent)
    }

    const success = runBuild()
    assert.equal(success.status, 0, `${success.stderr}\n${success.stdout}`)
    assert.ok(success.elapsedMs < 10_000, `topological fixture exceeded 10s: ${success.elapsedMs}ms`)
    assert.deepEqual(
      readFileSync(invocationLog, 'utf8').trim().split('\n'),
      ['shared', 'channel', 'app'],
    )
    t.diagnostic(`topological fixture: 3 unique package builds in ${success.elapsedMs}ms`)

    writeFileSync(invocationLog, '')
    const failure = runBuild('shared')
    assert.notEqual(failure.status, 0)
    assert.deepEqual(readFileSync(invocationLog, 'utf8').trim().split('\n'), ['shared'])
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('root build selection follows the real workspace DAG exactly once in a serialized dry run', (t) => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'open-cowork-real-build-graph-'))
  const invocationLog = join(evidenceRoot, 'invocations.log')
  const recorderPath = join(evidenceRoot, 'record-build.mjs')
  const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const buildWorkspaces = rootBuildWorkspacePackageDirs()
    .map((workspace) => ({ workspace, manifest: workspacePackageJson(workspace) }))
    .filter(({ manifest }) => typeof manifest.scripts?.build === 'string')
  const expectedNames = buildWorkspaces.map(({ manifest }) => manifest.name).filter((name): name is string => Boolean(name))
  const expectedNameSet = new Set(expectedNames)
  const buildDependenciesByName = new Map(
    buildWorkspaces.flatMap(({ manifest }) => {
      if (!manifest.name) return []
      const dependencies = Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })
        .filter(([, version]) => version.startsWith('workspace:'))
        .map(([name]) => name)
        .filter((name) => expectedNameSet.has(name))
      return [[manifest.name, dependencies] as const]
    }),
  )

  const runInstrumentedBuild = (failPackage = '') => spawnSync(
    pnpmExecutable,
    [
      '--dir',
      fileURLToPath(repoRoot),
      '--workspace-concurrency=1',
      '--recursive',
      '--filter',
      './packages/*',
      '--filter',
      './mcps/*',
      '--filter',
      './apps/*',
      'exec',
      process.execPath,
      recorderPath,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        OPEN_COWORK_BUILD_INVOCATIONS: invocationLog,
        OPEN_COWORK_FAIL_BUILD: failPackage,
      },
      timeout: 20_000,
    },
  )
  const readInvocations = () => {
    const source = readFileSync(invocationLog, 'utf8').trim()
    return source ? source.split('\n') : []
  }
  try {
    writeFileSync(
      recorderPath,
      [
        "import { appendFileSync, readFileSync } from 'node:fs'",
        "const manifest = JSON.parse(readFileSync('package.json', 'utf8'))",
        "if (typeof manifest.scripts?.build !== 'string') process.exit(0)",
        'const name = manifest.name',
        "appendFileSync(process.env.OPEN_COWORK_BUILD_INVOCATIONS, `${name}\\n`)",
        'if (process.env.OPEN_COWORK_FAIL_BUILD === name) process.exit(17)',
      ].join('\n'),
    )

    writeFileSync(invocationLog, '')
    const clean = runInstrumentedBuild()
    assert.equal(clean.status, 0, `${clean.stderr}\n${clean.stdout}`)
    const cleanInvocations = readInvocations()
    assert.equal(new Set(cleanInvocations).size, cleanInvocations.length, 'each real build workspace must execute once')
    assert.deepEqual([...cleanInvocations].sort(), [...expectedNames].sort())

    const buildIndex = new Map(cleanInvocations.map((name, index) => [name, index]))
    for (const { manifest } of buildWorkspaces) {
      const packageIndex = buildIndex.get(manifest.name || '')
      const workspaceDependencies = buildDependenciesByName.get(manifest.name || '') || []
      for (const dependency of workspaceDependencies) {
        assert.ok(
          buildIndex.get(dependency)! < packageIndex!,
          `${dependency} must build before ${manifest.name}`,
        )
      }
    }

    const failureTarget = cleanInvocations[0]!
    const transitiveDependents = new Set<string>()
    let discoveredDependent = true
    while (discoveredDependent) {
      discoveredDependent = false
      for (const [name, dependencies] of buildDependenciesByName) {
        if (
          name !== failureTarget
          && !transitiveDependents.has(name)
          && dependencies.some((dependency) => (
            dependency === failureTarget || transitiveDependents.has(dependency)
          ))
        ) {
          transitiveDependents.add(name)
          discoveredDependent = true
        }
      }
    }
    const failureRuns = Array.from({ length: 2 }, () => {
      writeFileSync(invocationLog, '')
      const failure = runInstrumentedBuild(failureTarget)
      return {
        status: failure.status,
        invocations: readInvocations(),
      }
    })
    for (const failure of failureRuns) {
      assert.notEqual(failure.status, 0)
      assert.equal(
        failure.invocations.filter((name) => name === failureTarget).length,
        1,
        'the failed workspace must execute exactly once',
      )
      assert.equal(
        new Set(failure.invocations).size,
        failure.invocations.length,
        'failure handling must not execute a workspace more than once',
      )
      assert.deepEqual(
        failure.invocations.filter((name) => transitiveDependents.has(name)),
        [],
        'a workspace whose dependency failed must never start',
      )
      assert.deepEqual(
        failure.invocations.filter((name) => !expectedNameSet.has(name)),
        [],
        'failure handling must not escape the selected build workspace set',
      )
    }
    assert.equal(failureRuns[1]?.status, failureRuns[0]?.status, 'root topology failure status must be deterministic')

    // pnpm 10.32.1 queues every workspace in a topological chunk through its
    // concurrency limiter. When one command rejects, an already-queued independent
    // workspace may start before that rejection unwinds. The safety contract is
    // therefore dependency fail-fast, not cancellation of unrelated work.
    t.diagnostic(
      `serialized real-graph dry run: ${cleanInvocations.length} build workspaces, dependency fail-fast at ${failureTarget}`,
    )
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true })
  }
})

test('root lint script runs all release gate checks', () => {
  assert.deepEqual(splitScriptSteps(requireScript('lint')), [
    'eslint . --max-warnings 0',
    'pnpm design-tokens:check',
    'node scripts/lint.mjs',
    'node scripts/check-design-token-usage.mjs',
    'node scripts/check-import-cycles.mjs',
    'node scripts/build-docs-mermaid-vendor.mjs --check',
    'node scripts/check-preload-channels.mjs',
    'node scripts/check-shared-dist.mjs',
    'pnpm lint:dead-code',
    'pnpm boundaries:check',
  ])
  assert.equal(requireScript('docs:vendor:build'), 'node scripts/build-docs-mermaid-vendor.mjs')
  assert.equal(requireScript('docs:vendor:check'), 'node scripts/build-docs-mermaid-vendor.mjs --check')
  assert.match(requireScript('docs:build'), /node scripts\/docs-build\.mjs build/)
})

test('dead-code gate covers every source workspace package', () => {
  assert.equal(
    requireScript('lint:dead-code'),
    'knip --config knip.jsonc --production --files --exports',
  )
  assert.equal(
    requireScript('dead-code:report'),
    'node scripts/dead-code-report.mjs',
  )
  assert.equal(
    requireScript('knip', workspacePackageJson('products/gateway')),
    'knip --directory ../.. --config knip.jsonc --workspace products/gateway --production --files --exports',
  )
  assert.equal(
    requireScript('check:dead-code', workspacePackageJson('products/wiki')),
    "knip --directory ../.. --config knip.jsonc --workspace products/wiki --workspace 'products/wiki/packages/*' --production --files --exports",
  )
  assert.equal(existsSync(new URL('../products/gateway/knip.json', import.meta.url)), false)
  assert.equal(existsSync(new URL('../products/wiki/knip.json', import.meta.url)), false)

  const workspaces = knipJson.workspaces || {}
  const expected = sourceWorkspacePackageDirs()
  const missing = expected.filter((workspace) => !knipConfigForWorkspace(workspace))

  assert.deepEqual(missing, [], `knip.jsonc must cover every source workspace package: ${missing.join(', ')}`)

  for (const workspace of expected) {
    const config = knipConfigForWorkspace(workspace)
    assert.ok(config?.entry?.length, `knip workspace ${workspace} must declare entry files`)
    assert.ok(config?.project?.length, `knip workspace ${workspace} must declare project files`)
  }

  assert.equal(
    workspaces['.']?.entry?.some((entry) => entry === 'scripts/*.mjs' || entry === 'scripts/**/*.ts'),
    false,
    'root scripts must be discovered from real package/CI callers instead of catch-all entries',
  )
  assert.equal(
    knipJson.ignore?.some((pattern) => pattern.startsWith('products/gateway') || pattern.startsWith('products/wiki')),
    false,
    'the canonical inventory must not exclude Gateway or Wiki',
  )

  const expectedExternalEntrypoints: Record<string, string[]> = {
    '.': [
      'scripts/compose-config-schema.mjs',
      'scripts/desktop-after-sign.mjs',
      'scripts/prune-cloud-runtime.mjs',
      'scripts/prune-gateway-runtime.mjs',
    ],
    'apps/desktop': ['src/**/*.test.ts'],
    'products/gateway': [
      'scripts/docker-auth-smoke.mjs',
      'scripts/docker-compose-auth-smoke.mjs',
    ],
    'products/wiki': ['scripts/openwiki-packaged-cli-smoke.mjs'],
    'products/wiki/packages/*': ['test/**/*.test.ts'],
  }
  for (const [workspace, entries] of Object.entries(expectedExternalEntrypoints)) {
    for (const entry of entries) {
      assert.ok(
        workspaces[workspace]?.entry?.includes(entry),
        `knip workspace ${workspace} must model the real external entry ${entry}`,
      )
    }
  }
})

test('dead-code report detects an intentionally unused file and emits JSON directly', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/dead-code-report.mjs', '--verify-probe'],
    {
      cwd: fileURLToPath(repoRoot),
      encoding: 'utf8',
      timeout: 15_000,
    },
  )

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.deepEqual(JSON.parse(result.stdout), {
    probeDetected: true,
    schemaVersion: 1,
  })
})

test('dead-code report is byte-stable across repeated full inventories', () => {
  const runReport = () => spawnSync(
    process.execPath,
    ['scripts/dead-code-report.mjs'],
    {
      cwd: fileURLToPath(repoRoot),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15_000,
    },
  )
  const first = runReport()
  const second = runReport()

  assert.equal(first.signal, null, first.stderr)
  assert.equal(second.signal, null, second.stderr)
  assert.equal(first.status, second.status)
  assert.equal(first.stderr, second.stderr)
  assert.equal(first.stdout, second.stdout)
  assert.equal(JSON.parse(first.stdout).schemaVersion, 1)
})

test('contributor setup docs and dependency update governance match enforced engines', () => {
  assert.equal(nvmrc, '22.23.1')
  assert.equal(packageJson.packageManager, 'pnpm@10.32.1')
  assert.equal(packageJson.engines?.node, '>=22.22.3')
  assert.equal(packageJson.engines?.pnpm, '10.32.1')
  // The benchmark metadata records the environment that actually generated the
  // numbers. It intentionally exercises the supported Node floor; .nvmrc is the
  // newer reviewed patch used by contributors and CI within the same LTS line.
  assert.deepEqual(linuxNode22PerfBaseline.environment, {
    platform: 'linux',
    arch: 'x64',
    node: 'v22.13.0',
  })
  assert.match(npmrc, /^engine-strict=true$/m)
  assert.match(contributingDocs, /Node monorepo floor \*\*`>=22\.22\.3`\*\*/)
  assert.doesNotMatch(contributingDocs, /Node `>=22`[^.]/)
  for (const docs of [readmeDocs, contributingDocs, gettingStartedDocs, firstContributionDocs]) {
    assert.match(docs, /exact version pinned in .*`\.nvmrc`/i)
    assert.match(docs, /pnpm `10\.32\.1`/)
    assert.doesNotMatch(docs, /pnpm `>= ?10`/)
  }
  assert.match(readmeDocs, /\[!\[pnpm 10\.32\.1\]/)
  assert.doesNotMatch(readmeDocs, /\[!\[pnpm 10\+\]/)
  for (const workflow of [ciWorkflow, docsWorkflow, releaseWorkflow, monthlyMaintenanceWorkflow, weeklyGatewayWorkflow]) {
    assert.match(workflow, /version: 10\.32\.1/)
  }

  for (const directory of [
    '/docker/open-cowork-cloud',
    '/docker/open-cowork-gateway',
  ]) {
    assert.match(dependabotConfig, new RegExp(`package-ecosystem: "docker"[\\s\\S]*directory: "${directory}"`))
  }
})

test('pnpm audit policy is explicit and wired through repository scripts', () => {
  assert.equal(requireScript('audit:prod'), 'node scripts/pnpm-audit.mjs --prod --audit-level moderate')
  assert.equal(requireScript('audit:full'), 'node scripts/pnpm-audit.mjs --audit-level high')
  assert.deepEqual(packageJson.pnpm?.auditConfig?.ignoreCves, [])
  // Security pins live in pnpm-workspace.yaml overrides (no temporary GHSA ignores).
  assert.deepEqual(packageJson.pnpm?.auditConfig?.ignoreGhsas, [])
  assert.match(ciWorkflow, /run: pnpm audit:prod/)
  assert.match(ciWorkflow, /run: pnpm audit:full/)
  assert.match(releaseWorkflow, /run: pnpm audit:prod/)
  assert.match(releaseWorkflow, /run: pnpm audit:full/)
  assert.match(monthlyMaintenanceWorkflow, /run: pnpm audit:prod/)
  assert.doesNotMatch(ciWorkflow, /pnpm audit --/)
  assert.doesNotMatch(releaseWorkflow, /pnpm audit --/)
  assert.match(securityModelDocs, /pnpm audit:prod/)
  assert.match(securityModelDocs, /scripts\/pnpm-audit\.mjs/)
  assert.match(securityModelDocs, /pnpm\.auditConfig\.ignoreCves/)
  assert.match(releaseChecklistDocs, /pnpm audit:prod/)
  assert.match(releaseChecklistDocs, /pnpm audit:full/)
})

test('published docs do not include superseded audit reports', () => {
  for (const path of [
    'docs/production-readiness-audit.md',
    'docs/repo-deep-audit-2026-06.md',
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} must remain quarantined outside published docs`)
  }
  assert.doesNotMatch(mkdocsConfig, /production-readiness-audit|repo-deep-audit-2026-06/)
})

test('production license compatibility gate is wired as a script and CI step', () => {
  assert.equal(requireScript('notices'), 'node scripts/generate-third-party-notices.mjs')
  assert.equal(requireScript('license:check'), 'node scripts/check-license-compatibility.mjs')
  assert.ok(
    existsSync(new URL('../scripts/check-license-compatibility.mjs', import.meta.url)),
    'the copyleft license gate script must exist',
  )
  assert.match(ciWorkflow, /pnpm license:check/, 'CI must run the copyleft license compatibility gate')
})

test('root deployment scripts expose provider smoke gates', () => {
  assert.equal(requireScript('deploy:validate'), 'node scripts/validate-deployment-configs.mjs')
  assert.equal(requireScript('deploy:smoke'), 'node scripts/smoke-deployment.mjs')
  assert.equal(requireScript('deploy:smoke:strict'), 'node scripts/strict-deployment-smoke.mjs')
  assert.deepEqual(splitScriptSteps(requireScript('deploy:desktop:smoke')), [
    'pnpm build:shared',
    'node --no-warnings --experimental-strip-types scripts/desktop-cloud-sync-smoke.mjs',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('deploy:gateway:smoke')), [
    'pnpm build:gateway',
    'node scripts/gateway-cloud-smoke.mjs',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('deploy:standalone-gateway:smoke')), [
    'pnpm build:standalone-gateway',
    'node apps/standalone-gateway/dist/main.js smoke',
  ])
  assert.equal(requireScript('deploy:standalone-gateway:validate'), 'node scripts/validate-standalone-gateway.mjs')
  assert.deepEqual(splitScriptSteps(requireScript('deploy:continuation:smoke')), [
    'pnpm build:gateway',
    'pnpm build:shared',
    'node --no-warnings --experimental-strip-types scripts/cloud-continuation-smoke.mjs',
  ])
  assert.equal(requireScript('deploy:gcp:preflight'), 'node scripts/gcp-reference-preflight.mjs')
  assert.equal(requireScript('deploy:gcp:smoke'), 'node scripts/gcp-reference-smoke.mjs')
  assert.equal(requireScript('deploy:load:plan'), 'node scripts/launch-readiness.mjs --mode plan')
  assert.equal(requireScript('deploy:load'), 'node scripts/launch-readiness.mjs --mode load')
  assert.equal(requireScript('deploy:soak'), 'node scripts/launch-readiness.mjs --mode soak')
  assert.equal(requireScript('deploy:launch:validate'), 'node scripts/validate-launch-readiness.mjs')
  assert.equal(requireScript('deploy:launch:evidence:validate'), 'node scripts/validate-launch-evidence-manifest.mjs')
  assert.equal(requireScript('deploy:promotion:validate'), 'node scripts/validate-release-promotion.mjs')
  assert.equal(requireScript('deploy:private-beta:validate'), 'node scripts/validate-private-beta-package.mjs')
  assert.equal(
    requireScript('ops:validate'),
    'node --no-warnings --experimental-strip-types scripts/check-opencode-compatibility.ts && node scripts/validate-ops-readiness.mjs && node scripts/validate-release-gates.mjs',
  )
  assert.equal(requireScript('release:gates:validate'), 'node scripts/validate-release-gates.mjs')
  assert.equal(
    requireScript('cloud:dev'),
    'node --no-warnings --experimental-strip-types scripts/open-cowork-cloud.ts --development-process',
  )
  assert.equal(requireScript('proof:opencode:compatibility'), 'node --no-warnings --experimental-strip-types scripts/check-opencode-compatibility.ts')
})

test('root package exposes the bounded desktop development renderer smoke', () => {
  assert.equal(
    requireScript('dev:desktop:smoke'),
    'node scripts/desktop-dev-renderer-smoke.mjs',
  )
})

test('desktop and Cloud browser Vite compose renderer workspaces from source', () => {
  const aliases = rendererWorkspaceSourceAliases(fileURLToPath(repoRoot))
  assert.deepEqual(
    aliases.map(({ find, replacement }) => [find.source, replacement]),
    [
      ['^@open-cowork\\/ui\\/primitive-gallery$', fileURLToPath(new URL('../packages/ui/src/PrimitiveGallery.tsx', import.meta.url))],
      ['^@open-cowork\\/ui$', fileURLToPath(new URL('../packages/ui/src/index.ts', import.meta.url))],
      ['^@open-cowork\\/shared$', fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url))],
    ],
  )
  for (const { replacement } of aliases) {
    assert.equal(existsSync(replacement), true, `source alias target must exist: ${replacement}`)
    assert.doesNotMatch(replacement, /[/\\]dist[/\\]/)
  }

  const desktopViteConfig = readFileSync(new URL('../apps/desktop/vite.config.ts', import.meta.url), 'utf8')
  const browserViteConfig = readFileSync(new URL('../packages/app/vite.config.browser.ts', import.meta.url), 'utf8')
  assert.match(desktopViteConfig, /\.\.\.rendererWorkspaceSourceAliases\(repoRoot\)/)
  assert.match(browserViteConfig, /\.\.\.rendererWorkspaceSourceAliases\(repoRoot\)/)
})

test('desktop Electron development resolves workspace packages from source without changing production resolution', () => {
  const serveConfig = electronWorkspaceSourceViteConfig(fileURLToPath(repoRoot), 'serve')
  const buildConfig = electronWorkspaceSourceViteConfig(fileURLToPath(repoRoot), 'build')
  const aliases = serveConfig.resolve?.alias || []
  const representativeImports = [
    '@open-cowork/cloud-client',
    '@open-cowork/cloud-client/domains/sessions',
    '@open-cowork/cloud-server/session-service',
    '@open-cowork/runtime-host',
    '@open-cowork/runtime-host/thread-index/thread-index-service',
    '@open-cowork/shared',
    '@open-cowork/shared/ipc-security-errors',
    '@open-cowork/shared/node',
  ]

  for (const specifier of representativeImports) {
    const alias = aliases.find(({ find }) => find.test(specifier))
    assert.ok(alias, `missing development source alias for ${specifier}`)
    const replacement = specifier.replace(alias.find, alias.replacement)
    assert.equal(existsSync(replacement), true, `source alias target must exist: ${replacement}`)
    assert.doesNotMatch(replacement, /[/\\]dist[/\\]/)
  }

  assert.deepEqual(buildConfig, {}, 'production Electron builds must continue to use package exports')
  assert.doesNotThrow(() => {
    assertElectronWorkspaceSourceModule(
      fileURLToPath(repoRoot),
      fileURLToPath(new URL('../packages/runtime-host/src/runtime.ts', import.meta.url)),
    )
  })
  assert.throws(
    () => assertElectronWorkspaceSourceModule(
      fileURLToPath(repoRoot),
      fileURLToPath(new URL('../packages/runtime-host/dist/runtime.js', import.meta.url)),
    ),
    /ignored dist artifact/,
  )
  const desktopViteConfig = readFileSync(new URL('../apps/desktop/vite.config.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(
    desktopViteConfig,
    /OPEN_COWORK_RENDERER_SMOKE/,
    'desktop Vite must not expose an unowned alternate plugin topology',
  )
})

test('root build and dist scripts preserve release build prerequisites', () => {
  assert.equal(
    requireScript('build:desktop'),
    'pnpm design-tokens:build && pnpm --filter "@open-cowork/desktop..." run build',
  )
  assert.equal(
    requireScript('build:mcps'),
    'pnpm --recursive --filter "@open-cowork/mcp-*..." run build',
  )
  assert.equal(
    requireScript('build:packages'),
    'pnpm --recursive --filter "./packages/*" run build',
  )
  assert.equal(
    requireScript('build:gateway'),
    'pnpm --filter "@open-cowork/channel-gateway..." run build',
  )
  assert.equal(
    requireScript('build:standalone-gateway'),
    'pnpm --filter "@open-cowork/standalone-gateway..." run build',
  )

  assert.deepEqual(splitScriptSteps(requireScript('build')), [
    'pnpm design-tokens:build',
    'pnpm --recursive --filter "./packages/*" --filter "./mcps/*" --filter "./apps/*" run build',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('dist')), [
    'pnpm build',
    'pnpm --filter @open-cowork/desktop dist',
  ])
})

test('desktop package scripts own only desktop work', () => {
  for (const removedScript of [
    'tokens:build',
    'ui:build',
    'deps:build',
    'predev',
    'prebuild',
    'pretypecheck',
  ]) {
    assert.equal(desktopPackageJson.scripts?.[removedScript], undefined)
  }
  assert.equal(requireScript('dev', desktopPackageJson), 'vite')
  assert.equal(requireScript('build', desktopPackageJson), 'vite build')
  assert.equal(
    requireScript('typecheck', desktopPackageJson),
    'tsc -p tsconfig.main.json --noEmit && tsc -p tsconfig.preload.json --noEmit',
  )
})

test('shared renderer package owns the renderer test + browser build scripts', () => {
  // The unified renderer now lives in @open-cowork/app, consumed by both the
  // Electron build and the cloud browser build. Its vitest + browser-build
  // scripts moved here from the desktop package.
  assert.equal(
    requireScript('test:renderer', appPackageJson),
    'node ../../scripts/workspace-build-freshness.mjs && vitest run --config vitest.renderer.config.ts',
  )
  assert.equal(
    requireScript('test:coverage:renderer', appPackageJson),
    'node ../../scripts/workspace-build-freshness.mjs && vitest run --config vitest.renderer.config.ts --coverage',
  )
  assert.equal(requireScript('build:browser', appPackageJson), 'vite build --config vite.config.browser.ts')
  assert.equal(requireScript('typecheck', appPackageJson), 'tsc --noEmit')
})

test('root typecheck script covers package, MCP, gateway, and desktop surfaces', () => {
  assert.deepEqual(splitScriptSteps(requireScript('typecheck')), [
    'pnpm design-tokens:build',
    'pnpm --recursive --filter "./packages/*" run build',
    'pnpm --recursive --filter @open-cowork/app --filter @open-cowork/cloud-server --filter "./mcps/*" --filter "./apps/*" run typecheck',
  ])

  assert.equal(
    requireScript('typecheck:cloud-server'),
    'pnpm --filter "@open-cowork/cloud-server^..." run build && pnpm --filter @open-cowork/cloud-server run typecheck',
  )
  assert.equal(
    requireScript('typecheck:mcps'),
    'pnpm --filter "@open-cowork/mcp-*^..." run build && pnpm --recursive --filter "./mcps/*" run typecheck',
  )
  assert.equal(
    requireScript('typecheck:gateway'),
    'pnpm --filter "@open-cowork/channel-gateway^..." run build && pnpm --filter @open-cowork/channel-gateway run typecheck',
  )
  assert.equal(
    requireScript('typecheck:standalone-gateway'),
    'pnpm --filter "@open-cowork/standalone-gateway^..." run build && pnpm --filter @open-cowork/standalone-gateway run typecheck',
  )
})

test('packaged e2e script fails before smoke discovery without a packaged executable', () => {
  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged')), [
    'pnpm --filter @open-cowork/desktop test:e2e:packaged',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged:optional')), [
    'pnpm --filter @open-cowork/desktop test:e2e:packaged:optional',
  ])

  // The packaged-executable guard must stay first so a missing packaged build
  // fails fast, before the harness dependencies (shared + runtime-host, needed
  // by smoke-helpers) are rebuilt and smoke discovery begins.
  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged', desktopPackageJson)), [
    'node ../../scripts/require-packaged-executable.mjs',
    'pnpm --dir ../.. build:shared',
    'pnpm --dir ../.. --filter @open-cowork/runtime-host build',
    'node ../../scripts/run-desktop-smoke-tests.mjs --pattern "tests/*.packaged.test.ts" --timeout=240000 --retries=1',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged:optional', desktopPackageJson)), [
    'pnpm --dir ../.. build:shared',
    'pnpm --dir ../.. --filter @open-cowork/runtime-host build',
    'node ../../scripts/run-desktop-smoke-tests.mjs --pattern "tests/*.packaged.test.ts" --timeout=240000 --retries=1',
  ])

  for (const expectedCall of [
    'waitForCdp(port, appShellTimeoutMs)',
    'waitForCdpPage(browser, appShellTimeoutMs)',
    'waitForCdpAppPage(browser, appShellTimeoutMs)',
  ]) {
    const matches = [...smokeHelpers.matchAll(new RegExp(expectedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
    assert.equal(
      matches.length,
      2,
      `both packaged CDP launch paths must honor the packaged launch timeout via ${expectedCall}`,
    )
  }

  assert.match(
    smokeHelpers,
    /export async function launchPackagedLinuxProbe/,
    'Linux packaged smoke must use the E2E ready-file probe for preload and persistence contracts',
  )
  assert.match(
    smokeHelpers,
    /OPEN_COWORK_E2E_READY_FILE: readyFile/,
    'packaged probe launch must pass an isolated ready file into the packaged process',
  )
  assert.match(
    smokeHelpers,
    /OPEN_COWORK_RUNTIME_COMPONENT_DEV_OVERRIDE_REASON/,
    'direct desktop smoke must use an explicit runtime component development override',
  )
  assert.match(
    smokeHelpers,
    /export async function assertRuntimeComponentProvenance/,
    'desktop smoke helpers must expose a runtime component provenance assertion',
  )
})

test('channel protocol inventory and private-beta campaign path scripts are wired (JOE-994 / JOE-993)', () => {
  assert.equal(requireScript('channels:protocol:inventory'), 'node scripts/check-channel-protocol-inventory.mjs')
  assert.match(requireScript('boundaries:check'), /check-channel-protocol-inventory\.mjs/)
  assert.equal(requireScript('deploy:private-beta:validate'), 'node scripts/validate-private-beta-package.mjs')
  assert.ok(existsSync(new URL('../docs/product-channel-protocol-unification.md', import.meta.url)))
  assert.ok(existsSync(new URL('../deploy/private-beta/private-campaign-evidence-checklist.md', import.meta.url)))
})

test('weekly gateway matrix and dual-channel PR checklist are wired (JOE-969 / JOE-932)', () => {
  assert.match(weeklyGatewayWorkflow, /pnpm test:gateway/)
  assert.match(weeklyGatewayWorkflow, /cron: "17 4 \* \* 1"/)
  assert.match(weeklyGatewayWorkflow, /Weekly gateway matrix red/)
  assert.match(weeklyGatewayWorkflow, /workflow_dispatch/)
  assert.match(ciWorkflow, /check-dual-channel-pr-checklist\.mjs/)
  assert.match(ciWorkflow, /OPEN_COWORK_PR_BODY/)
  assert.match(securityModelDocs, /weekly-gateway\.yml/)
  assert.match(securityModelDocs, /JOE-969/)
  assert.match(securityModelDocs, /revalidated 2026-07-23 \/ JOE-962/)
  assert.match(securityModelDocs, /reaffirmed 2026-07-23 \/ JOE-946/)
})

test('ci and release workflows use canonical release gate scripts', () => {
  const ciDocsJob = ciWorkflow.match(/\n {2}docs:\n[\s\S]*?\n {2}coverage:/)?.[0] || ''
  assert.notEqual(ciDocsJob, '', 'CI workflow must contain a docs job')
  assert.match(ciDocsJob, /pnpm install --frozen-lockfile/, 'CI docs job must install the locked dependency graph')
  assert.match(ciDocsJob, /pnpm docs:build/, 'CI docs job must use pnpm docs:build')

  for (const command of [
    'pnpm lint',
    'pnpm test',
    'pnpm test:live-scenarios',
    'pnpm test:cloud-continuation',
    'pnpm test:renderer',
    'pnpm typecheck',
    'pnpm perf:check',
    'pnpm build',
    'pnpm docs:build',
    'pnpm deploy:validate -- --require-tools',
    'pnpm deploy:launch:validate',
    'pnpm deploy:launch:evidence:validate',
    'pnpm deploy:promotion:validate -- --tier local-self-host-beta',
    'pnpm deploy:private-beta:validate',
    'pnpm deploy:standalone-gateway:validate',
    'pnpm ops:validate',
    'pnpm test:windows-prepackage',
    'node scripts/find-linux-packaged-executable.mjs',
    'node scripts/find-windows-packaged-executable.mjs',
    'pnpm proof:cloud:opencode-portability --json',
    'pnpm proof:sandbox:opencode-session -- --json',
    'pnpm audit:prod',
    'pnpm audit:full',
    'pnpm license:check',
    'pnpm lint:dead-code',
  ]) {
    assert.match(ciWorkflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `CI must run ${command}`)
  }

  for (const command of [
    'pnpm install --frozen-lockfile',
    'pnpm docs:build',
  ]) {
    assert.match(docsWorkflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `docs workflow must run ${command}`)
  }
  assert.doesNotMatch(docsWorkflow, /mkdocs build --strict/, 'docs workflow must use pnpm docs:build so vendor gates run before Pages deploy')

  for (const command of [
    'pnpm lint',
    'pnpm typecheck',
    'pnpm test',
    'pnpm test:live-scenarios',
    'pnpm test:cloud-continuation',
    'pnpm test:renderer',
    'pnpm perf:check',
    'pnpm docs:build',
    'pnpm deploy:validate -- --require-tools',
    'pnpm deploy:launch:validate',
    'pnpm deploy:launch:evidence:validate',
    'pnpm deploy:promotion:validate -- --tier "${OPEN_COWORK_RELEASE_CLAIM_TIER}"',
    'pnpm deploy:private-beta:validate',
    'pnpm deploy:standalone-gateway:validate',
    'pnpm ops:validate',
    'pnpm --dir apps/desktop test:e2e:packaged',
    'xvfb-run -a pnpm --dir apps/desktop test:e2e:packaged',
    'node scripts/find-linux-packaged-executable.mjs',
    'node scripts/windows-signing-targets.mjs',
    'pnpm proof:sandbox:opencode-session -- --json',
    'pnpm audit:prod',
    'pnpm audit:full',
    'pnpm lint:dead-code',
    'node scripts/verify-release-tag-signature.mjs',
    'node scripts/verify-release-artifact-matrix.mjs',
    'node scripts/verify-release-actor.mjs',
    'node scripts/verify-release-checks.mjs',
  ]) {
    assert.match(releaseWorkflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `release workflow must run ${command}`)
  }

  for (const evidence of [
    'Generate CycloneDX SBOM',
    'Generate SPDX SBOM',
    'Validate SBOMs',
    'THIRD_PARTY_NOTICES.md',
    'SHA256SUMS.txt',
    'SHA256SUMS.txt.asc',
    'open-cowork-cloud.image.sbom.cdx.json',
    'open-cowork-cloud.image.scan.grype.json',
    'open-cowork-cloud.image.cosign-verify.json',
    'open-cowork-gateway.image.sbom.cdx.json',
    'open-cowork-gateway.image.scan.grype.json',
    'open-cowork-gateway.image.cosign-verify.json',
    'release-oci-supply-chain',
    "jq -er '.versionTag'",
    'version_tag_digest',
  ]) {
    assert.match(releaseWorkflow, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `release workflow must preserve ${evidence}`)
  }

  assert.match(
    releaseWorkflow,
    / {2}release-policy:\n[\s\S]*? {4}steps:\n {6}- uses: actions\/checkout@[0-9a-f]{40}[\s\S]*? {6}- name: Verify release artifacts\n[\s\S]*?node scripts\/verify-release-artifact-matrix\.mjs/,
    'release-policy must checkout source before running the repository release artifact matrix script',
  )

  const publishJobIndex = releaseWorkflow.indexOf('\n  publish:')
  const finalTagIndex = releaseWorkflow.indexOf('name: Publish final OCI release tags')
  const releaseArtifactValidationIndex = releaseWorkflow.indexOf('name: Verify OCI supply-chain release artifacts')
  const githubReleaseIndex = releaseWorkflow.indexOf('name: Publish GitHub Release')
  assert.ok(publishJobIndex > 0, 'release workflow must define a final publish job')
  assert.ok(finalTagIndex > publishJobIndex, 'release workflow must publish final OCI tags from the final publish job')
  assert.ok(finalTagIndex > releaseArtifactValidationIndex, 'release workflow must validate release artifacts before final OCI tag promotion')
  assert.ok(finalTagIndex < githubReleaseIndex, 'release workflow must promote final OCI tags before GitHub Release creation')

  assert.match(packagingDocs, /gh attestation verify "oci:\/\/\$\{digest_ref\}"/)
  assert.match(packagingDocs, /--predicate-type https:\/\/cyclonedx\.org\/bom/)
})
