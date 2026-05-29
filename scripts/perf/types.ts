export type BenchmarkResult = {
  name: string
  iterations: number
  minMs: number
  maxMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
}

export type BenchmarkReport = {
  generatedAt: string
  environment: {
    platform: string
    arch: string
    node: string
  }
  suiteRuns: number
  regressionThresholds: {
    avgMultiplier: number
    p95Multiplier: number
    avgAbsoluteFloorMs: number
    p95AbsoluteFloorMs: number
    jitterAllowanceMs?: number
  }
  benchmarks: BenchmarkResult[]
}

export type HistoryFixture = {
  sessionId: string
  cachedModelId: string
  rootMessages: any[]
  rootTodos: any[]
  children: any[]
  statuses: Record<string, any>
  childSnapshots: Map<string, { messages: any[]; todos: any[] }>
}
