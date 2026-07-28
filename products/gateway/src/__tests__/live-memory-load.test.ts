import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Forced-GC runs stay far below this on supported Node versions, while one
// retained 3 MiB replay generation per cycle crosses it before the run ends.
const HEAP_GROWTH_LIMIT_BYTES = 12 * 1024 * 1024

interface LoadPhaseReport {
  generations: number
  operationsPerGeneration: number
  heapUsedBytes: number[]
  heapGrowthBytes: number
}

interface LiveMemoryLoadReport {
  principalChurn: LoadPhaseReport & {
    retainedClients: number
    retainedPrincipals: number
  }
  replayChurn: LoadPhaseReport & {
    retainedSnapshots: number
  }
  parserChurn: LoadPhaseReport & {
    exactFrames: number
    rejectedFrames: number
    cancelledStreams: number
  }
}

describe('live SSE memory envelope', () => {
  it('keeps principal, replay, and incremental parser churn within a bounded heap envelope', () => {
    const require = createRequire(import.meta.url)
    const tsxLoader = require.resolve('tsx')
    const harness = fileURLToPath(new URL('./live-memory-load-harness.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--expose-gc', '--import', tsxLoader, harness], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      timeout: 60_000,
    })

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    const report = JSON.parse(result.stdout) as LiveMemoryLoadReport

    expect(report.principalChurn).toMatchObject({
      generations: 6,
      operationsPerGeneration: 30_000,
      retainedClients: 0,
      retainedPrincipals: 0,
    })
    expect(report.replayChurn).toMatchObject({
      generations: 6,
      operationsPerGeneration: 10_000,
      retainedSnapshots: 1_000,
    })
    expect(report.parserChurn).toMatchObject({
      generations: 6,
      operationsPerGeneration: 1_000,
      exactFrames: 6_000,
      rejectedFrames: 6_000,
      cancelledStreams: 768,
    })
    expect(report.principalChurn.heapUsedBytes).toHaveLength(6)
    expect(report.replayChurn.heapUsedBytes).toHaveLength(6)
    expect(report.parserChurn.heapUsedBytes).toHaveLength(6)
    expect(report.principalChurn.heapGrowthBytes).toBeLessThanOrEqual(HEAP_GROWTH_LIMIT_BYTES)
    expect(report.replayChurn.heapGrowthBytes).toBeLessThanOrEqual(HEAP_GROWTH_LIMIT_BYTES)
    expect(report.parserChurn.heapGrowthBytes).toBeLessThanOrEqual(HEAP_GROWTH_LIMIT_BYTES)
  })
})
