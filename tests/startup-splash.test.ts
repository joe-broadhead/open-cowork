import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeStartupSplashFile } from '../apps/desktop/src/main/startup-splash.ts'

test('writeStartupSplashFile writes escaped branded HTML privately', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-startup-splash-'))

  try {
    const templatePath = join(root, 'template.html')
    writeFileSync(templatePath, '<title>Open Cowork</title><h1>Open Cowork</h1>')

    const outputPath = writeStartupSplashFile({
      templatePath,
      outputDir: join(root, 'user-data', 'startup'),
      brandName: '<Acme & Co>',
    })

    assert.equal(
      readFileSync(outputPath, 'utf-8'),
      '<title>&lt;Acme &amp; Co&gt;</title><h1>&lt;Acme &amp; Co&gt;</h1>',
    )
    assert.equal(statSync(outputPath).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
