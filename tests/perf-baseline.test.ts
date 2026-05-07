import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  baselineFilenameForEnvironment,
  baselinePathForEnvironment,
  selectBaselinePath,
} from '../scripts/perf/baseline.ts'

const linuxNode22 = {
  platform: 'linux',
  arch: 'x64',
  node: 'v22.12.0',
}

const linuxNode24 = {
  platform: 'linux',
  arch: 'x64',
  node: 'v24.1.0',
}

test('baselineFilenameForEnvironment includes platform, arch, and Node major', () => {
  assert.equal(
    baselineFilenameForEnvironment(linuxNode22),
    'perf-baseline.linux-x64-node22.json',
  )
})

test('selectBaselinePath prefers a matching environment baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-'))
  try {
    const expected = baselinePathForEnvironment(dir, linuxNode22)
    writeFileSync(expected, '{}\n')
    assert.equal(selectBaselinePath(dir, linuxNode22), expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('selectBaselinePath prefers same platform and arch before generic fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-'))
  try {
    const generic = join(dir, 'perf-baseline.json')
    const linuxNode22Path = baselinePathForEnvironment(dir, linuxNode22)
    writeFileSync(generic, '{}\n')
    writeFileSync(linuxNode22Path, '{}\n')
    assert.equal(selectBaselinePath(dir, linuxNode24), linuxNode22Path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('selectBaselinePath chooses the nearest same-platform Node major', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-'))
  try {
    const linuxNode20Path = baselinePathForEnvironment(dir, { ...linuxNode22, node: 'v20.11.0' })
    const linuxNode22Path = baselinePathForEnvironment(dir, linuxNode22)
    writeFileSync(linuxNode20Path, '{}\n')
    writeFileSync(linuxNode22Path, '{}\n')
    assert.equal(selectBaselinePath(dir, linuxNode24), linuxNode22Path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('selectBaselinePath falls back to the generic baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-'))
  try {
    assert.equal(selectBaselinePath(dir, linuxNode22), join(dir, 'perf-baseline.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
