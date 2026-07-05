import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

type PackageJson = {
  engines?: Record<string, string>
  scripts?: Record<string, string>
}

type KnipJson = {
  workspaces?: Record<string, {
    entry?: string[]
    project?: string[]
  }>
}

const repoRoot = new URL('../', import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson
const desktopPackageJson = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8')) as PackageJson
const appPackageJson = JSON.parse(readFileSync(new URL('../packages/app/package.json', import.meta.url), 'utf8')) as PackageJson
const knipJson = JSON.parse(readFileSync(new URL('../knip.json', import.meta.url), 'utf8')) as KnipJson
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const docsWorkflow = readFileSync(new URL('../.github/workflows/docs.yml', import.meta.url), 'utf8')
const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const dependabotConfig = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')
const contributingDocs = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8')
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

function sourceWorkspacePackageDirs(): string[] {
  return ['apps', 'packages', 'mcps'].flatMap((scope) => {
    return readdirSync(new URL(`../${scope}/`, import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${scope}/${entry.name}`)
      .filter((workspace) => existsSync(new URL(`${workspace}/package.json`, repoRoot)))
      .filter((workspace) => existsSync(new URL(`${workspace}/src/`, repoRoot)))
  }).sort()
}

test('root node test scripts prepare generated shared artifacts before tests run', () => {
  assert.deepEqual(splitScriptSteps(requireScript('test:prepare')), [
    'pnpm build:shared',
    'pnpm --filter @open-cowork/runtime-host build',
    'pnpm design-tokens:build',
    'node scripts/ensure-electron-binary.mjs',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test')), [
    'pnpm test:prepare',
    'pnpm --workspace-concurrency=1 --filter=./packages/* test',
    'pnpm --filter=./mcps/* test',
    'pnpm --filter @open-cowork/gateway test',
    'pnpm --filter @open-cowork/standalone-gateway test',
    'node scripts/run-node-tests.mjs',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:coverage:node')), [
    'pnpm test:prepare',
    'pnpm --workspace-concurrency=1 --filter=./packages/* test',
    'pnpm --filter=./mcps/* test',
    'pnpm --filter @open-cowork/gateway test',
    'pnpm --filter @open-cowork/standalone-gateway test',
    'node scripts/run-node-tests.mjs --coverage',
    'node scripts/run-workspace-node-tests.mjs --coverage',
    'node scripts/coverage-summary.mjs --check --node-only --no-write',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:coverage')), [
    'pnpm test:coverage:node',
    'pnpm test:coverage:renderer',
    'node scripts/coverage-summary.mjs --check',
  ])

  assert.equal(requireScript('test:coverage:renderer'), 'pnpm --filter @open-cowork/app test:coverage:renderer')
})

test('root lint script runs all release gate checks', () => {
  assert.deepEqual(splitScriptSteps(requireScript('lint')), [
    'eslint . --max-warnings 0',
    'pnpm design-tokens:check',
    'node scripts/lint.mjs',
    'node scripts/build-docs-mermaid-vendor.mjs --check',
    'node scripts/check-preload-channels.mjs',
    'node scripts/check-shared-dist.mjs',
  ])
  assert.equal(requireScript('docs:vendor:build'), 'node scripts/build-docs-mermaid-vendor.mjs')
  assert.equal(requireScript('docs:vendor:check'), 'node scripts/build-docs-mermaid-vendor.mjs --check')
  assert.match(requireScript('docs:build'), /node scripts\/docs-build\.mjs build/)
})

test('dead-code gate covers every source workspace package', () => {
  const workspaces = knipJson.workspaces || {}
  const expected = sourceWorkspacePackageDirs()
  const missing = expected.filter((workspace) => !workspaces[workspace])

  assert.deepEqual(missing, [], `knip.json must cover every source workspace package: ${missing.join(', ')}`)

  for (const workspace of expected) {
    const config = workspaces[workspace]
    assert.ok(config?.entry?.length, `knip workspace ${workspace} must declare entry files`)
    assert.ok(config?.project?.length, `knip workspace ${workspace} must declare project files`)
  }
})

test('contributor setup docs and dependency update governance match enforced engines', () => {
  assert.equal(nvmrc, '22.12.0')
  assert.equal(packageJson.engines?.node, '>=22.12')
  assert.match(contributingDocs, /Node `>=22\.12`/)
  assert.doesNotMatch(contributingDocs, /Node `>=22`[^.]/)

  for (const directory of [
    '/docker/open-cowork-cloud',
    '/docker/open-cowork-gateway',
  ]) {
    assert.match(dependabotConfig, new RegExp(`package-ecosystem: "docker"[\\s\\S]*directory: "${directory}"`))
  }
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
  assert.equal(requireScript('proof:opencode:compatibility'), 'node --no-warnings --experimental-strip-types scripts/check-opencode-compatibility.ts')
})

test('root build and dist scripts preserve release build prerequisites', () => {
  assert.equal(requireScript('build:desktop'), 'pnpm --filter @open-cowork/desktop build')
  assert.equal(requireScript('build:mcps'), 'pnpm --filter=./mcps/* build')
  assert.equal(requireScript('build:packages'), 'pnpm --workspace-concurrency=1 --filter=./packages/* build')
  assert.equal(requireScript('build:gateway'), 'pnpm --filter @open-cowork/gateway build')
  assert.equal(requireScript('build:standalone-gateway'), 'pnpm --filter @open-cowork/standalone-gateway build')

  assert.deepEqual(splitScriptSteps(requireScript('build')), [
    'pnpm build:packages',
    'pnpm design-tokens:build',
    'pnpm build:mcps',
    'pnpm build:gateway',
    'pnpm build:standalone-gateway',
    'pnpm --filter @open-cowork/desktop build',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('dist')), [
    'pnpm build',
    'pnpm --filter @open-cowork/desktop dist',
  ])
})

test('desktop direct scripts prepare generated tokens and shared UI artifacts', () => {
  assert.equal(requireScript('ui:build', desktopPackageJson), 'pnpm --filter @open-cowork/ui build')
  assert.deepEqual(splitScriptSteps(requireScript('deps:build', desktopPackageJson)), [
    'pnpm tokens:build',
    'pnpm ui:build',
  ])
  assert.equal(requireScript('predev', desktopPackageJson), 'pnpm deps:build')
  assert.equal(requireScript('prebuild', desktopPackageJson), 'pnpm deps:build')
  assert.equal(requireScript('pretypecheck', desktopPackageJson), 'pnpm deps:build')
})

test('shared renderer package owns the renderer test + browser build scripts', () => {
  // The unified renderer now lives in @open-cowork/app, consumed by both the
  // Electron build and the cloud browser build. Its vitest + browser-build
  // scripts moved here from the desktop package.
  assert.equal(requireScript('test:renderer', appPackageJson), 'vitest run --config vitest.renderer.config.ts')
  assert.equal(requireScript('test:coverage:renderer', appPackageJson), 'vitest run --config vitest.renderer.config.ts --coverage')
  assert.equal(requireScript('build:browser', appPackageJson), 'vite build --config vite.config.browser.ts')
  assert.equal(requireScript('typecheck', appPackageJson), 'tsc --noEmit')
})

test('root typecheck script covers package, MCP, gateway, and desktop surfaces', () => {
  assert.deepEqual(splitScriptSteps(requireScript('typecheck')), [
    'pnpm build:packages',
    'pnpm design-tokens:build',
    'pnpm typecheck:cloud-server',
    'pnpm typecheck:mcps',
    'pnpm typecheck:gateway',
    'pnpm typecheck:standalone-gateway',
    'pnpm --filter @open-cowork/desktop build:electron',
    'pnpm --filter @open-cowork/desktop typecheck',
  ])

  assert.equal(requireScript('typecheck:cloud-server'), 'pnpm --filter @open-cowork/cloud-server typecheck')
  assert.equal(requireScript('typecheck:mcps'), 'pnpm --filter=./mcps/* typecheck')
  assert.equal(requireScript('typecheck:gateway'), 'pnpm --filter @open-cowork/gateway typecheck')
  assert.equal(requireScript('typecheck:standalone-gateway'), 'pnpm --filter @open-cowork/standalone-gateway typecheck')
})

test('packaged e2e script fails before smoke discovery without a packaged executable', () => {
  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged')), [
    'pnpm --filter @open-cowork/desktop test:e2e:packaged',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged:optional')), [
    'pnpm --filter @open-cowork/desktop test:e2e:packaged:optional',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged', desktopPackageJson)), [
    'node ../../scripts/require-packaged-executable.mjs',
    'node ../../scripts/run-desktop-smoke-tests.mjs --pattern "tests/*.packaged.test.ts" --timeout=240000 --retries=1',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged:optional', desktopPackageJson)), [
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
    'node scripts/find-linux-packaged-executable.mjs',
    'pnpm proof:cloud:opencode-portability --json',
    'pnpm proof:sandbox:opencode-session -- --json',
    'pnpm audit --prod --audit-level moderate',
    'pnpm audit --audit-level high',
    'pnpm license:check',
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
    'pnpm proof:sandbox:opencode-session -- --json',
    'pnpm audit --prod --audit-level moderate',
    'pnpm audit --audit-level high',
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
