import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

type PackageJson = {
  scripts?: Record<string, string>
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson
const desktopPackageJson = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8')) as PackageJson

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
})

test('root lint script runs all release gate checks', () => {
  assert.deepEqual(splitScriptSteps(requireScript('lint')), [
    'eslint . --max-warnings 0',
    'node scripts/lint.mjs',
    'node scripts/check-preload-channels.mjs',
    'node scripts/check-shared-dist.mjs',
  ])
})

test('root build and dist scripts preserve release build prerequisites', () => {
  assert.equal(requireScript('build:packages'), 'pnpm --filter=./packages/* build')
  assert.equal(requireScript('build:gateway'), 'pnpm --filter @open-cowork/gateway build')

  assert.deepEqual(splitScriptSteps(requireScript('build')), [
    'pnpm build:packages',
    'pnpm build:mcps',
    'pnpm build:gateway',
    'pnpm --filter @open-cowork/desktop build',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('dist')), [
    'pnpm build',
    'pnpm --filter @open-cowork/desktop dist',
  ])
})

test('root typecheck script covers shared, MCP, and desktop packages', () => {
  assert.deepEqual(splitScriptSteps(requireScript('typecheck')), [
    'pnpm build:packages',
    'pnpm typecheck:mcps',
    'pnpm typecheck:gateway',
    'pnpm --filter @open-cowork/desktop build:electron',
    'pnpm --filter @open-cowork/desktop typecheck',
  ])

  assert.equal(requireScript('typecheck:mcps'), 'pnpm --filter=./mcps/* typecheck')
  assert.equal(requireScript('typecheck:gateway'), 'pnpm --filter @open-cowork/gateway typecheck')
})

test('packaged e2e script fails before smoke discovery without a packaged executable', () => {
  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged')), [
    'pnpm --filter @open-cowork/desktop test:e2e:packaged',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:e2e:packaged', desktopPackageJson)), [
    'node ../../scripts/require-packaged-executable.mjs',
    'node ../../scripts/run-desktop-smoke-tests.mjs --pattern "tests/*.packaged.test.ts" --timeout=240000 --retries=1',
  ])
})
