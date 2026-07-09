import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mergeSubprocessV8Coverage } from '../scripts/subprocess-v8-coverage.mjs'
import { parseLcovInfo } from '../scripts/coverage-summary.mjs'

test('subprocess V8 coverage merge emits deterministic LCOV line records', () => {
  const root = join(process.cwd(), '.open-cowork-test/subprocess-v8-coverage')
  const coverageDir = join(root, 'v8')
  const sourcePath = join(root, 'dist/example.js')
  const lcovPath = join(root, 'lcov.info')
  const source = [
    'function covered() {',
    '  return 1',
    '}',
    'function missed() {',
    '  return 0',
    '}',
    'covered()',
    '',
  ].join('\n')

  try {
    mkdirSync(coverageDir, { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(sourcePath, source)
    writeFileSync(lcovPath, [
      'TN:node',
      'SF:unrelated.js',
      'DA:1,1',
      'LF:1',
      'LH:1',
      'end_of_record',
    ].join('\n'))

    const missedStart = source.indexOf('function missed')
    const missedEnd = source.lastIndexOf('covered()')
    writeFileSync(join(coverageDir, 'coverage-1.json'), JSON.stringify({
      result: [{
        url: pathToFileURL(sourcePath).href,
        functions: [{
          functionName: '',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: source.length, count: 1 },
            { startOffset: missedStart, endOffset: missedEnd, count: 0 },
          ],
        }],
      }],
      timestamp: 1,
    }))

    const result = mergeSubprocessV8Coverage({
      coverageDir,
      lcovPath,
      includePathPrefixes: ['.open-cowork-test/subprocess-v8-coverage/dist/'],
    })

    assert.deepEqual(result, { v8Files: 1, files: 1, lines: 7 })
    assert.match(
      readText(lcovPath),
      /end_of_record\nTN:subprocess-v8\nSF:\.open-cowork-test\/subprocess-v8-coverage\/dist\/example\.js/,
    )
    const totals = parseLcovInfo(
      readText(lcovPath),
      { includePathPrefixes: ['.open-cowork-test/subprocess-v8-coverage/dist/'] },
    )
    assert.deepEqual(totals.lines, { covered: 4, total: 7 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function readText(path: string) {
  return readFileSync(path, 'utf8')
}
