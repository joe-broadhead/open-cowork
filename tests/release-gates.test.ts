import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'

test('release gate validator enforces branch protection and supply-chain contracts', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-release-gates.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /release gate contract validated/)
})

test('release gate validator scans newly added public deploy examples', () => {
  const fixturePath = 'deploy/private-value-scan-ci-test.env.example'
  try {
    writeFileSync(fixturePath, 'OPEN_COWORK_GATEWAY_SERVICE_TOKEN=actual-live-token\n')
    const result = spawnSync(process.execPath, ['scripts/validate-release-gates.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /private-value-scan-ci-test\.env\.example/)
  } finally {
    if (existsSync(fixturePath)) unlinkSync(fixturePath)
  }
})
