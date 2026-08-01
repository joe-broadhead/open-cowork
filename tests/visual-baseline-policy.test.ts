import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCommittedVisualBaseline,
  shouldUpdateVisualBaselines,
  VISUAL_BASELINE_UPDATE_COMMAND,
} from '../apps/desktop/tests/visual-baseline-policy.ts'

test('visual baseline policy enables writes only through the explicit update mode', () => {
  for (const value of ['1', 'true', ' TRUE ']) {
    assert.equal(shouldUpdateVisualBaselines(value), true)
  }
  for (const value of [undefined, '', '0', 'false', 'yes', 'on']) {
    assert.equal(shouldUpdateVisualBaselines(value), false)
  }
  assert.match(VISUAL_BASELINE_UPDATE_COMMAND, /^OPEN_COWORK_EVAL_UPDATE_BASELINES=1 /)
})

test('visual baseline policy reads committed files and never creates a missing baseline', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-visual-baseline-'))
  const committedPath = join(tempRoot, 'committed.png')
  const missingPath = join(tempRoot, 'missing.png')
  try {
    writeFileSync(committedPath, Buffer.from('committed'))
    assert.equal(readCommittedVisualBaseline(committedPath).toString(), 'committed')
    assert.throws(
      () => readCommittedVisualBaseline(missingPath),
      /Missing committed visual baseline.*OPEN_COWORK_EVAL_UPDATE_BASELINES=1/,
    )
    assert.equal(existsSync(missingPath), false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('visual Home captures pin renderer time and timezone', () => {
  const source = readFileSync(
    new URL('../apps/desktop/tests/visual-regression.eval.test.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /VISUAL_CAPTURE_TIME = '[^']+Z'/)
  assert.match(source, /page\.clock\.setFixedTime\(VISUAL_CAPTURE_TIME\)/)
  assert.match(source, /Emulation\.setTimezoneOverride['"], \{ timezoneId: ['"]UTC['"] \}/)
  assert.equal(source.match(/await pinVisualCaptureTime\(page\)/g)?.length, 2)
})
