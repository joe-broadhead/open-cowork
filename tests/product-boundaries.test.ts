import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

test('product boundary checker passes on the monorepo tree', () => {
  const result = spawnSync(process.execPath, ['scripts/check-product-boundaries.mjs'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /product-boundaries\] ok/)
})

test('product boundary checker fails on intentional desktop→gateway import', () => {
  const probeDir = join('packages', 'app', 'src')
  const probe = join(probeDir, '__boundary_probe_forbidden_import__.ts')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(probe, "import 'cowork-gateway'\n", 'utf8')
  try {
    const result = spawnSync(process.execPath, ['scripts/check-product-boundaries.mjs'], {
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, /desktop-to-products|FAILED/)
  } finally {
    rmSync(probe, { force: true })
  }
})
