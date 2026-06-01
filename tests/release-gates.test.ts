import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('release gate validator enforces branch protection and supply-chain contracts', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-release-gates.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /release gate contract validated/)
})
