import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BenchmarkReport } from './types.ts'

type BenchmarkEnvironment = BenchmarkReport['environment']

function nodeMajor(version: string) {
  const match = /^v?(\d+)/.exec(version)
  return match ? Number(match[1]) : null
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

function platformArchPrefix(environment: BenchmarkEnvironment) {
  return `perf-baseline.${safeSegment(environment.platform)}-${safeSegment(environment.arch)}-node`
}

export function baselineFilenameForEnvironment(environment: BenchmarkEnvironment) {
  const major = nodeMajor(environment.node)
  const nodeSegment = major === null ? 'node-unknown' : `node${major}`
  return `perf-baseline.${safeSegment(environment.platform)}-${safeSegment(environment.arch)}-${nodeSegment}.json`
}

export function baselinePathForEnvironment(baselineDir: string, environment: BenchmarkEnvironment) {
  return resolve(baselineDir, baselineFilenameForEnvironment(environment))
}

export function selectBaselinePath(baselineDir: string, environment: BenchmarkEnvironment) {
  const environmentPath = baselinePathForEnvironment(baselineDir, environment)
  if (existsSync(environmentPath)) return environmentPath

  const currentMajor = nodeMajor(environment.node)
  const prefix = platformArchPrefix(environment)
  let files: string[]
  try {
    files = readdirSync(baselineDir)
  } catch {
    files = []
  }
  const samePlatformArch = files.flatMap((file) => {
    if (!file.startsWith(prefix) || !file.endsWith('.json')) return []
    const match = /^(.+)-node(\d+)\.json$/.exec(file)
    return [{ file, major: match ? Number(match[2]) : null }]
  })

  const [nearest] = samePlatformArch.sort((a, b) => {
    if (currentMajor !== null && a.major !== null && b.major !== null) {
      const distance = Math.abs(a.major - currentMajor) - Math.abs(b.major - currentMajor)
      if (distance !== 0) return distance
    }
    return (b.major ?? -1) - (a.major ?? -1) || a.file.localeCompare(b.file)
  })
  if (nearest) return resolve(baselineDir, nearest.file)

  return resolve(baselineDir, 'perf-baseline.json')
}
