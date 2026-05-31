import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

type PackageJson = {
  scripts?: Record<string, string>
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson
const desktopPackageJson = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8')) as PackageJson
const websitePackageJson = JSON.parse(readFileSync(new URL('../apps/website/package.json', import.meta.url), 'utf8')) as PackageJson
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const packagingDocs = readFileSync(new URL('../docs/packaging-and-releases.md', import.meta.url), 'utf8')

function requireScript(name: string, source: PackageJson = packageJson): string {
  const script = source.scripts?.[name]
  assert.equal(typeof script, 'string', `Missing package script: ${name}`)
  return script
}

function splitScriptSteps(script: string): string[] {
  return script.split('&&').map((step) => step.trim())
}

test('root node test scripts prepare generated shared artifacts before tests run', () => {
  assert.deepEqual(splitScriptSteps(requireScript('test:prepare')), [
    'pnpm build:shared',
    'node scripts/ensure-electron-binary.mjs',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test')), [
    'pnpm test:prepare',
    'pnpm --filter=./packages/* test',
    'pnpm --filter=./mcps/* test',
    'pnpm --filter @open-cowork/gateway test',
    'pnpm --filter @open-cowork/website test',
    'node scripts/run-node-tests.mjs',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:coverage:node')), [
    'pnpm test:prepare',
    'pnpm --filter=./packages/* test',
    'pnpm --filter=./mcps/* test',
    'pnpm --filter @open-cowork/gateway test',
    'node scripts/run-node-tests.mjs --coverage',
    'node scripts/coverage-summary.mjs --check --node-only --no-write',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:coverage')), [
    'pnpm test:coverage:node',
    'pnpm test:coverage:renderer',
    'node scripts/coverage-summary.mjs --check',
  ])

  assert.equal(requireScript('test:coverage:renderer'), 'pnpm --filter @open-cowork/desktop test:coverage:renderer')

  assert.deepEqual(splitScriptSteps(requireScript('test:cloud-web')), [
    'pnpm build:shared',
    'pnpm --filter @open-cowork/website test:browser:run',
    'pnpm --filter @open-cowork/website test:a11y:run',
    'pnpm --filter @open-cowork/website perf:check:run',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('test:browser', websitePackageJson)), [
    'pnpm --filter @open-cowork/shared build',
    'pnpm run test:browser:run',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('test:a11y', websitePackageJson)), [
    'pnpm --filter @open-cowork/shared build',
    'pnpm run test:a11y:run',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('perf:check', websitePackageJson)), [
    'pnpm --filter @open-cowork/shared build',
    'pnpm run perf:check:run',
  ])
  assert.equal(requireScript('test:browser:run', websitePackageJson), 'node --no-warnings --experimental-strip-types --test src/browser-e2e.test.ts')
  assert.equal(requireScript('test:a11y:run', websitePackageJson), 'node --no-warnings --experimental-strip-types --test src/accessibility.test.ts')
  assert.equal(requireScript('perf:check:run', websitePackageJson), 'node --no-warnings --experimental-strip-types --test src/performance.test.ts')
})

test('root lint script runs all release gate checks', () => {
  assert.deepEqual(splitScriptSteps(requireScript('lint')), [
    'eslint . --max-warnings 0',
    'node scripts/lint.mjs',
    'node scripts/check-preload-channels.mjs',
    'node scripts/check-shared-dist.mjs',
  ])
})

test('root deployment scripts expose provider smoke gates', () => {
  assert.equal(requireScript('deploy:validate'), 'node scripts/validate-deployment-configs.mjs')
  assert.equal(requireScript('deploy:smoke'), 'node scripts/smoke-deployment.mjs')
  assert.deepEqual(splitScriptSteps(requireScript('deploy:desktop:smoke')), [
    'pnpm build:shared',
    'node --no-warnings --experimental-strip-types scripts/desktop-cloud-sync-smoke.mjs',
  ])
  assert.deepEqual(splitScriptSteps(requireScript('deploy:gateway:smoke')), [
    'pnpm build:gateway',
    'node scripts/gateway-cloud-smoke.mjs',
  ])
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
  assert.equal(requireScript('deploy:private-beta:validate'), 'node scripts/validate-private-beta-package.mjs')
  assert.equal(requireScript('ops:validate'), 'node scripts/validate-ops-readiness.mjs')
})

test('root build and dist scripts preserve release build prerequisites', () => {
  assert.equal(requireScript('build:desktop'), 'pnpm --filter @open-cowork/desktop build')
  assert.equal(requireScript('build:mcps'), 'pnpm --filter=./mcps/* build')
  assert.equal(requireScript('build:packages'), 'pnpm --filter=./packages/* build')
  assert.equal(requireScript('build:gateway'), 'pnpm --filter @open-cowork/gateway build')
  assert.equal(requireScript('build:website'), 'pnpm --filter @open-cowork/website build')

  assert.deepEqual(splitScriptSteps(requireScript('build')), [
    'pnpm build:packages',
    'pnpm build:mcps',
    'pnpm build:gateway',
    'pnpm build:website',
    'pnpm --filter @open-cowork/desktop build',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('dist')), [
    'pnpm build',
    'pnpm --filter @open-cowork/desktop dist',
  ])
})

test('root typecheck script covers package, MCP, gateway, website, and desktop surfaces', () => {
  assert.deepEqual(splitScriptSteps(requireScript('typecheck')), [
    'pnpm build:packages',
    'pnpm typecheck:mcps',
    'pnpm typecheck:gateway',
    'pnpm typecheck:website',
    'pnpm --filter @open-cowork/desktop build:electron',
    'pnpm --filter @open-cowork/desktop typecheck',
  ])

  assert.equal(requireScript('typecheck:mcps'), 'pnpm --filter=./mcps/* typecheck')
  assert.equal(requireScript('typecheck:gateway'), 'pnpm --filter @open-cowork/gateway typecheck')
  assert.equal(requireScript('typecheck:website'), 'pnpm --filter @open-cowork/website typecheck')
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
})

test('ci and release workflows use canonical release gate scripts', () => {
  for (const command of [
    'pnpm lint',
    'pnpm test',
    'pnpm test:cloud-web',
    'pnpm test:renderer',
    'pnpm typecheck',
    'pnpm perf:check',
    'pnpm build',
    'pnpm docs:build',
    'pnpm deploy:validate -- --require-tools',
    'pnpm deploy:launch:validate',
    'pnpm deploy:private-beta:validate',
    'pnpm ops:validate',
    'pnpm audit --prod --audit-level moderate',
    'pnpm audit --audit-level critical',
  ]) {
    assert.match(ciWorkflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `CI must run ${command}`)
  }

  for (const command of [
    'pnpm lint',
    'pnpm typecheck',
    'pnpm test',
    'pnpm test:renderer',
    'pnpm perf:check',
    'pnpm docs:build',
    'pnpm --dir apps/desktop test:e2e:packaged',
    'pnpm audit --prod --audit-level moderate',
    'pnpm audit --audit-level critical',
    'node scripts/verify-release-tag-signature.mjs',
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
  ]) {
    assert.match(releaseWorkflow, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `release workflow must preserve ${evidence}`)
  }

  assert.match(packagingDocs, /gh attestation verify "oci:\/\/\$\{digest_ref\}"/)
  assert.match(packagingDocs, /--predicate-type https:\/\/cyclonedx\.org\/bom/)
})
