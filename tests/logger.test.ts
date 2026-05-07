import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneLogDirectory } from '../apps/desktop/src/main/logger.ts'

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-logger-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeLog(dir: string, file: string, size: number, mtime: string) {
  const path = join(dir, file)
  writeFileSync(path, Buffer.alloc(size, 'x'))
  const date = new Date(mtime)
  utimesSync(path, date, date)
  return path
}

test('log pruning includes rotated archives in retention cleanup', () => withTempDir((dir) => {
  const oldArchive = writeLog(dir, 'cowork-2026-04-01.log.1', 4, '2026-04-01T00:00:00.000Z')
  const recentArchive = writeLog(dir, 'cowork-2026-05-06.log.1', 4, '2026-05-06T00:00:00.000Z')

  pruneLogDirectory(dir, {
    nowMs: Date.parse('2026-05-07T00:00:00.000Z'),
    retentionDays: 14,
    maxTotalBytes: Number.POSITIVE_INFINITY,
  })

  assert.equal(existsSync(oldArchive), false)
  assert.equal(existsSync(recentArchive), true)
}))

test('log pruning enforces a total retained size cap by removing oldest files first', () => withTempDir((dir) => {
  const newest = writeLog(dir, 'open-cowork-2026-05-06.log', 3, '2026-05-06T00:00:00.000Z')
  const middle = writeLog(dir, 'open-cowork-2026-05-05.log.1', 4, '2026-05-05T00:00:00.000Z')
  const oldest = writeLog(dir, 'open-cowork-2026-05-04.log', 4, '2026-05-04T00:00:00.000Z')
  const unrelated = writeLog(dir, 'other.log', 20, '2026-05-01T00:00:00.000Z')

  pruneLogDirectory(dir, {
    nowMs: Date.parse('2026-05-07T00:00:00.000Z'),
    retentionDays: 14,
    maxTotalBytes: 8,
  })

  assert.equal(existsSync(newest), true)
  assert.equal(existsSync(middle), true)
  assert.equal(existsSync(oldest), false)
  assert.equal(existsSync(unrelated), true)
}))
