import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRuntimeAgentsFile } from '../apps/desktop/src/main/runtime-content.ts'

test('writeRuntimeAgentsFile writes the runtime AGENTS mirror privately', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-agents-'))

  try {
    const sourcePath = join(root, 'AGENTS.md')
    const runtimeHome = join(root, 'runtime-home')
    writeFileSync(sourcePath, '# Runtime Instructions\n')

    writeRuntimeAgentsFile(runtimeHome, sourcePath)

    const outputPath = join(runtimeHome, 'AGENTS.md')
    assert.equal(readFileSync(outputPath, 'utf-8'), '# Runtime Instructions\n')
    assert.equal(statSync(outputPath).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
