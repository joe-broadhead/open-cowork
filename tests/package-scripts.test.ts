import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

type PackageJson = {
  scripts?: Record<string, string>
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson

function requireScript(name: string): string {
  const script = packageJson.scripts?.[name]
  assert.equal(typeof script, 'string', `Missing package script: ${name}`)
  return script
}

function splitScriptSteps(script: string): string[] {
  return script.split('&&').map((step) => step.trim())
}

test('root node test scripts prepare generated shared artifacts before tests run', () => {
  assert.equal(requireScript('test:prepare'), 'pnpm build:shared')

  assert.deepEqual(splitScriptSteps(requireScript('test')), [
    'pnpm test:prepare',
    'pnpm --filter=./mcps/* test',
    'node scripts/run-node-tests.mjs',
  ])

  assert.deepEqual(splitScriptSteps(requireScript('test:coverage:node')), [
    'pnpm test:prepare',
    'pnpm --filter=./mcps/* test',
    'node scripts/run-node-tests.mjs --coverage',
    'node scripts/coverage-summary.mjs --check --node-only --no-write',
  ])
})
