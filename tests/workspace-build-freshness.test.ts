import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectPackageBuildFreshness,
} from '../scripts/workspace-build-freshness.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-build-freshness-'))
  const source = join(root, 'src', 'index.ts')
  const testSource = join(root, 'src', 'index.test.ts')
  const output = join(root, 'dist', 'index.js')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(source, 'export const value = 1\n')
  writeFileSync(testSource, 'test("value", () => {})\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@fixture/package',
    scripts: { build: 'tsc' },
    exports: { '.': { import: './dist/index.js' } },
  }))
  return { root, source, testSource, output }
}

test('workspace build freshness rejects missing and stale distribution output', (t) => {
  const { root, source, output } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.deepEqual(inspectPackageBuildFreshness(root), {
    packageName: '@fixture/package',
    reason: 'missing dist output',
  })

  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(output, 'export const value = 1\n')
  const now = Date.now()
  utimesSync(output, new Date(now - 2_000), new Date(now - 2_000))
  utimesSync(source, new Date(now), new Date(now))
  assert.match(inspectPackageBuildFreshness(root)?.reason || '', /src.index\.ts is newer than dist.index\.js/)
})

test('workspace build freshness accepts current output and ignores test-only edits', (t) => {
  const { root, source, testSource, output } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(output, 'export const value = 1\n')

  const now = Date.now()
  utimesSync(source, new Date(now - 2_000), new Date(now - 2_000))
  utimesSync(output, new Date(now - 1_000), new Date(now - 1_000))
  utimesSync(testSource, new Date(now), new Date(now))
  assert.equal(inspectPackageBuildFreshness(root), null)
})

test('workspace build freshness rejects a partial TypeScript build hidden by a newer unrelated output', (t) => {
  const { root, source, output } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const otherSource = join(root, 'src', 'other.ts')
  const otherOutput = join(root, 'dist', 'other.js')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(otherSource, 'export const other = 2\n')
  writeFileSync(output, 'export const value = 1\n')
  writeFileSync(otherOutput, 'export const other = 1\n')

  const now = Date.now()
  utimesSync(otherOutput, new Date(now - 3_000), new Date(now - 3_000))
  utimesSync(otherSource, new Date(now - 2_000), new Date(now - 2_000))
  utimesSync(source, new Date(now - 1_000), new Date(now - 1_000))
  utimesSync(output, new Date(now), new Date(now))

  assert.match(inspectPackageBuildFreshness(root)?.reason || '', /src.other\.ts is newer than dist.other\.js/)
})
