import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expectedReleaseArtifacts,
  verifyReleaseArtifactMatrix,
} from '../scripts/verify-release-artifact-matrix.mjs'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

function tempRoot(name: string) {
  const scratchRoot = join(repoRoot, '.open-cowork-test', 'release-artifact-matrix')
  mkdirSync(scratchRoot, { recursive: true })
  return mkdtempSync(join(scratchRoot, `${name}-`))
}

function writeArtifact(root: string, relativePath: string, body = 'artifact\n') {
  const path = join(root, relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

function writeExpectedArtifacts(root: string, version: string, options: { latestMac?: boolean } = {}) {
  const expected = expectedReleaseArtifacts(version)
  for (const artifact of expected.macos) writeArtifact(root, join('release-macos', artifact))
  for (const artifact of expected.linux) writeArtifact(root, join('release-linux', artifact))
  if (options.latestMac) writeArtifact(root, join('release-macos', 'latest-mac.yml'))
}

test('release artifact matrix accepts the documented signed desktop artifact set', () => {
  const root = tempRoot('signed')
  try {
    writeExpectedArtifacts(root, '0.0.0', { latestMac: true })

    assert.doesNotThrow(() => verifyReleaseArtifactMatrix({
      root,
      version: '0.0.0',
      signingMode: 'signed',
    }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release artifact matrix rejects missing macOS formats or architectures', () => {
  const root = tempRoot('missing-macos')
  try {
    writeExpectedArtifacts(root, '0.0.0', { latestMac: true })
    rmSync(join(root, 'release-macos', 'Open-Cowork-0.0.0-arm64-mac.zip'))

    assert.throws(() => verifyReleaseArtifactMatrix({
      root,
      version: '0.0.0',
      signingMode: 'signed',
    }), /Missing release artifact: .*Open-Cowork-0\.0\.0-arm64-mac\.zip/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release artifact matrix rejects unexpected installer artifacts', () => {
  const root = tempRoot('unexpected')
  try {
    writeExpectedArtifacts(root, '0.0.0', { latestMac: true })
    writeArtifact(root, join('release-linux', 'Open-Cowork-0.0.0-arm64.deb'))

    assert.throws(() => verifyReleaseArtifactMatrix({
      root,
      version: '0.0.0',
      signingMode: 'signed',
    }), /Unexpected Linux release artifacts: Open-Cowork-0\.0\.0-arm64\.deb/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release artifact matrix rejects unsigned macOS feed metadata', () => {
  const root = tempRoot('unsigned-feed')
  try {
    writeExpectedArtifacts(root, '0.0.0', { latestMac: true })

    assert.throws(() => verifyReleaseArtifactMatrix({
      root,
      version: '0.0.0',
      signingMode: 'unsigned',
    }), /Unsigned macOS preview artifacts must not publish latest-mac\.yml/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
