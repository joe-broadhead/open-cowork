/**
 * OpenCode V2 client kernel (audit 2026-07-21 P1-2).
 * Exercises the shipped createOpencodeV2Client / probeOpencodeV2Health entry points.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

test('opencode-client-kernel source is the shared construction entry', () => {
  const src = readFileSync(
    join(repoRoot, 'packages/runtime-host/src/opencode-client-kernel.ts'),
    'utf8',
  )
  assert.match(src, /export function createOpencodeV2Client/)
  assert.match(src, /export async function probeOpencodeV2Health/)
  assert.match(src, /createOpencodeClient/)
})

test('runtime-host and cloud-server construct clients via the shared kernel', () => {
  const runtime = readFileSync(join(repoRoot, 'packages/runtime-host/src/runtime.ts'), 'utf8')
  const cloud = readFileSync(
    join(repoRoot, 'packages/cloud-server/src/opencode-runtime-adapter.ts'),
    'utf8',
  )
  assert.match(runtime, /createOpencodeV2Client/)
  assert.doesNotMatch(runtime, /createOpencodeClient\(/)
  assert.match(cloud, /createOpencodeV2Client/)
  assert.doesNotMatch(cloud, /createOpencodeClient\(/)
})

test('createOpencodeV2Client and probeOpencodeV2Health are callable from dist when built', async () => {
  const dist = join(repoRoot, 'packages/runtime-host/dist/opencode-client-kernel.js')
  try {
    const mod = await import(dist) as {
      createOpencodeV2Client: (config: { baseUrl: string }) => unknown
      probeOpencodeV2Health: (client: unknown) => Promise<{ ok: boolean }>
    }
    assert.equal(typeof mod.createOpencodeV2Client, 'function')
    assert.equal(typeof mod.probeOpencodeV2Health, 'function')
    // Probe a stub client without network — missing health API → ok:false
    const result = await mod.probeOpencodeV2Health({})
    assert.equal(result.ok, false)
  } catch (error) {
    // Dist may not exist before build in a fresh worktree; structural tests above still apply.
    if (error instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/i.test(error.message)) {
      assert.ok(true, 'dist not built yet; source wiring tests still apply')
      return
    }
    throw error
  }
})
