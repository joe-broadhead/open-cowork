/**
 * Algorithm parity: gateway-channel package-local constant-time compare must
 * stay byte-compatible with `@open-cowork/shared/node` constantTimeEquals
 * (audit 2026-07-18 SEC-1 / 2026-07-21 P2-6).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { constantTimeEquals } from '@open-cowork/shared/node'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const require = createRequire(import.meta.url)

function loadGatewayChannelConstantTime(): (
  left: string | null | undefined,
  right: string | null | undefined,
) => boolean {
  // Prefer built dist; fall back to source transpile via experimental strip when needed.
  const distPath = join(repoRoot, 'packages/gateway-channel/dist/crypto.js')
  try {
    const mod = require(distPath) as { constantTimeStringEqual: typeof constantTimeEquals }
    return mod.constantTimeStringEqual
  } catch {
    // Source is ESM TypeScript; read and assert algorithm identity when dist missing.
    const src = readFileSync(join(repoRoot, 'packages/gateway-channel/src/crypto.ts'), 'utf8')
    assert.match(src, /timingSafeEqual/)
    assert.match(src, /if \(!left \|\| !right\) return false/)
    assert.match(src, /Buffer\.from\(left, ["']utf8["']\)/)
    // Return shared implementation only for structural check path — test below
    // requires dist for behavioral parity.
    throw new Error('packages/gateway-channel/dist/crypto.js missing; run pnpm --filter @open-cowork/gateway-channel build')
  }
}

const vectors: Array<[string | null | undefined, string | null | undefined]> = [
  ['secret-token', 'secret-token'],
  ['secret-token', 'secret-tokeX'],
  ['short', 'longer-value'],
  ['', ''],
  ['', 'x'],
  ['x', ''],
  [null, null],
  [undefined, 'x'],
  ['unicode-✓-secret', 'unicode-✓-secret'],
  ['unicode-✓-secret', 'unicode-✗-secret'],
  ['a'.repeat(64), 'a'.repeat(64)],
  ['a'.repeat(64), 'a'.repeat(63) + 'b'],
]

test('gateway-channel constantTimeStringEqual matches shared constantTimeEquals on vectors', () => {
  const channelEquals = loadGatewayChannelConstantTime()
  for (const [left, right] of vectors) {
    assert.equal(
      channelEquals(left, right),
      constantTimeEquals(left, right),
      `parity mismatch for ${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
    )
  }
})
