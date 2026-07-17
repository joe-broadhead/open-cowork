import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKSPACE_SUBPROCESS_COVERAGE_PREFIXES = [
  'apps/standalone-gateway/dist/',
  'mcps/agents/dist/',
  'mcps/charts/dist/',
  'mcps/knowledge/dist/',
  'mcps/semantic-ui/dist/',
  'mcps/skills/dist/',
  'mcps/workflows/dist/',
]

export function mergeSubprocessV8Coverage({
  coverageDir,
  lcovPath,
  includePathPrefixes = WORKSPACE_SUBPROCESS_COVERAGE_PREFIXES,
  cwd = process.cwd(),
} = {}) {
  if (!coverageDir) throw new Error('coverageDir is required')
  if (!lcovPath) throw new Error('lcovPath is required')
  if (!existsSync(coverageDir)) return { v8Files: 0, files: 0, lines: 0 }

  const normalizedPrefixes = includePathPrefixes.map((prefix) => prefix.replace(/\\/g, '/'))
  const fileLineHits = new Map()
  let v8Files = 0

  for (const coverageFile of collectCoverageFiles(coverageDir)) {
    v8Files += 1
    const payload = JSON.parse(readFileSync(coverageFile, 'utf8'))
    for (const script of payload.result || []) {
      const relativePath = relativeScriptPath(script.url, cwd)
      if (!relativePath || !normalizedPrefixes.some((prefix) => relativePath.startsWith(prefix))) continue
      const absolutePath = fileURLToPath(script.url)
      if (!existsSync(absolutePath)) continue

      const source = readFileSync(absolutePath, 'utf8')
      const lineHits = scriptLineHits(source, script.functions || [])
      if (lineHits.size === 0) continue

      if (!fileLineHits.has(relativePath)) fileLineHits.set(relativePath, new Map())
      const merged = fileLineHits.get(relativePath)
      for (const [line, hits] of lineHits) {
        merged.set(line, Math.max(merged.get(line) || 0, hits))
      }
    }
  }

  const lcovRecords = renderLcovRecords(fileLineHits)
  if (lcovRecords) {
    appendLcovRecords(lcovPath, lcovRecords)
  }

  let lines = 0
  for (const lineHits of fileLineHits.values()) lines += lineHits.size
  return { v8Files, files: fileLineHits.size, lines }
}

function appendLcovRecords(path, records) {
  const fd = openSync(path, 'a+')
  try {
    const { size } = fstatSync(fd)
    let separator = ''
    if (size > 0) {
      const lastByte = Buffer.alloc(1)
      readSync(fd, lastByte, 0, 1, size - 1)
      separator = lastByte[0] === 0x0a ? '' : '\n'
    }
    appendFileSync(fd, `${separator}${records}\n`)
  } finally {
    closeSync(fd)
  }
}

function collectCoverageFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectCoverageFiles(path))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path)
    }
  }
  return files.sort()
}

function relativeScriptPath(url, cwd) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null
  const path = fileURLToPath(url)
  let stats
  try {
    stats = statSync(path)
  } catch {
    return null
  }
  if (!stats.isFile()) return null
  const relativePath = relative(cwd, path).replace(/\\/g, '/')
  return relativePath.startsWith('..') ? null : relativePath
}

function scriptLineHits(source, functions) {
  const ranges = functions.flatMap((fn) => {
    return (fn.ranges || []).flatMap((range) => {
      if (!Number.isFinite(range.startOffset) || !Number.isFinite(range.endOffset) || range.endOffset <= range.startOffset) {
        return []
      }
      return [{
        start: range.startOffset,
        end: range.endOffset,
        count: Number(range.count) || 0,
        length: range.endOffset - range.startOffset,
      }]
    })
  }).sort((a, b) => a.start - b.start || b.end - a.end)

  if (ranges.length === 0) return new Map()

  const lineProbes = sourceLineProbes(source)
  const hits = new Map()
  const active = []
  let nextRangeIndex = 0

  for (const { line, offset } of lineProbes) {
    while (nextRangeIndex < ranges.length && ranges[nextRangeIndex].start <= offset) {
      active.push(ranges[nextRangeIndex])
      nextRangeIndex += 1
    }

    let best = null
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const range = active[index]
      if (range.end <= offset) {
        active.splice(index, 1)
        continue
      }
      if (range.start <= offset && offset < range.end && (!best || range.length < best.length)) {
        best = range
      }
    }

    hits.set(line, best && best.count > 0 ? 1 : 0)
  }

  return hits
}

function sourceLineProbes(source) {
  const probes = []
  const lines = source.split('\n')
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index].replace(/\r$/, '')
    const firstCodeIndex = lineText.search(/\S/)
    if (firstCodeIndex >= 0) {
      probes.push({ line: index + 1, offset: offset + firstCodeIndex })
    }
    offset += lines[index].length + 1
  }
  return probes
}

function renderLcovRecords(fileLineHits) {
  const records = []
  for (const [file, lineHits] of [...fileLineHits.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sortedHits = [...lineHits.entries()].sort(([left], [right]) => left - right)
    const covered = sortedHits.filter(([, hits]) => hits > 0).length
    records.push(
      'TN:subprocess-v8',
      `SF:${file}`,
      ...sortedHits.map(([line, hits]) => `DA:${line},${hits}`),
      `LF:${sortedHits.length}`,
      `LH:${covered}`,
      'end_of_record',
    )
  }
  return records.join('\n')
}
