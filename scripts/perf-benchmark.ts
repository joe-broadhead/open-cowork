import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { SessionEngine } from '../apps/desktop/src/main/session-engine.ts'
import { projectSessionHistory } from '../apps/desktop/src/main/session-history-projector.ts'

type BenchmarkResult = {
  name: string
  iterations: number
  minMs: number
  maxMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
}

type BenchmarkReport = {
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
  }
  benchmarks: BenchmarkResult[]
}

type HistoryFixture = {
  sessionId: string
  cachedModelId: string
  rootMessages: any[]
  rootTodos: any[]
  children: any[]
  statuses: Record<string, any>
  childSnapshots: Map<string, { messages: any[]; todos: any[] }>
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = resolve(__dirname, '../benchmarks/perf-baseline.json')
const DEFAULT_THRESHOLDS = {
  avgMultiplier: 1.2,
  p95Multiplier: 1.25,
  avgAbsoluteFloorMs: 0.4,
  p95AbsoluteFloorMs: 0.8,
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

async function runBenchmark(
  name: string,
  iterations: number,
  work: () => void | Promise<void>,
  options?: { batchSize?: number; warmupIterations?: number },
): Promise<BenchmarkResult> {
  const batchSize = Math.max(1, options?.batchSize || 1)
  const warmupIterations = Math.max(1, options?.warmupIterations || 2)

  for (let index = 0; index < warmupIterations; index += 1) {
    for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
      await work()
    }
  }
  const samples: number[] = []

  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now()
    for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
      await work()
    }
    samples.push((performance.now() - start) / batchSize)
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)

  return {
    name,
    iterations,
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    avgMs: round(total / Math.max(1, samples.length)),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
  }
}

function createTextMessage(id: string, role: 'user' | 'assistant', text: string, created: number, extraParts: any[] = []) {
  return {
    info: {
      id,
      role,
      time: { created },
    },
    parts: [
      { id: `${id}:text`, type: 'text', text },
      ...extraParts,
    ],
  }
}

function createHistoryFixture(): HistoryFixture {
  const sessionId = 'perf-root'
  const childCount = 8
  const rootMessageCount = 48
  const childMessagesPerSession = 14
  const rootMessages: any[] = []
  const rootTodos = [
    { id: 'root-todo-1', content: 'Scope the work', status: 'done', priority: 'high' },
    { id: 'root-todo-2', content: 'Summarize findings', status: 'in_progress', priority: 'medium' },
  ]
  const children = Array.from({ length: childCount }, (_, index) => ({
    id: `child-${index + 1}`,
    title: `Research topic ${index + 1}`,
    time: {
      created: 2_000 + index * 100,
      updated: 2_500 + index * 100,
    },
  }))
  const statuses: Record<string, any> = {
    [sessionId]: { type: 'idle' },
  }
  const childSnapshots = new Map<string, { messages: any[]; todos: any[] }>()

  for (const child of children) {
    statuses[child.id] = { type: 'idle' }
  }

  let childCursor = 0
  for (let index = 0; index < rootMessageCount; index += 1) {
    const created = 1_000 + index * 100
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const parts: any[] = []

    if (childCursor < childCount && index % 6 === 1) {
      parts.push({
        id: `subtask-${childCursor + 1}`,
        type: 'subtask',
        agent: childCursor % 2 === 0 ? 'research' : 'engineer',
        description: `Investigate topic ${childCursor + 1}`,
      })
      childCursor += 1
    }

    if (index % 4 === 0) {
      parts.push({
        id: `tool-${index}`,
        type: 'tool',
        tool: 'fetch',
        state: {
          input: { url: `https://example.com/${index}` },
          output: { ok: true, index },
          metadata: { agent: 'assistant' },
        },
      })
    }

    if (index % 5 === 0) {
      parts.push({
        id: `cost-${index}`,
        type: 'step-finish',
        tokens: {
          input: 120 + index,
          output: 40 + index,
          reasoning: 10,
          cache: { read: 5, write: 1 },
        },
        cost: 0.02 + index / 10_000,
      })
    }

    if (index % 12 === 0) {
      parts.push({
        id: `compact-${index}`,
        type: 'compaction',
        auto: true,
        overflow: index % 24 === 0,
      })
    }

    rootMessages.push(createTextMessage(
      `root-msg-${index + 1}`,
      role,
      `${role === 'user' ? 'Request' : 'Response'} ${index + 1}: evaluate the current system and summarize the next step.`,
      created,
      parts,
    ))
  }

  for (const [childIndex, child] of children.entries()) {
    const messages: any[] = []
    for (let index = 0; index < childMessagesPerSession; index += 1) {
      const created = 5_000 + childIndex * 1_000 + index * 100
      const role = index === 0 ? 'user' : 'assistant'
      const parts: any[] = []

      if (index === 1) {
        parts.push({ id: `${child.id}:agent`, type: 'agent', name: childIndex % 2 === 0 ? 'research' : 'engineer' })
      }

      if (index % 3 === 0) {
        parts.push({
          id: `${child.id}:tool:${index}`,
          type: 'tool',
          tool: 'fetch',
          title: `Inspect source ${index}`,
          state: {
            input: { url: `https://example.com/${child.id}/${index}` },
            output: { ok: true, child: child.id, index },
            metadata: { agent: childIndex % 2 === 0 ? 'research' : 'engineer' },
          },
          metadata: { agent: childIndex % 2 === 0 ? 'research' : 'engineer' },
        })
      }

      parts.push({
        id: `${child.id}:finish:${index}`,
        type: 'step-finish',
        tokens: {
          input: 30 + index,
          output: 18 + index,
          reasoning: 6,
          cache: { read: 2, write: 0 },
        },
        cost: 0.01 + index / 20_000,
        ...(index === childMessagesPerSession - 1 ? { reason: 'stop' } : {}),
      })

      messages.push(createTextMessage(
        `${child.id}:msg:${index + 1}`,
        role,
        `${role === 'user' ? 'Task' : 'Finding'} ${index + 1} for ${child.title}.`,
        created,
        parts,
      ))
    }

    childSnapshots.set(child.id, {
      messages,
      todos: [
        { id: `${child.id}:todo:1`, content: `Investigate ${child.title}`, status: 'done', priority: 'high' },
        { id: `${child.id}:todo:2`, content: 'Publish summary', status: 'done', priority: 'medium' },
      ],
    })
  }

  return {
    sessionId,
    cachedModelId: 'databricks-claude-sonnet-4',
    rootMessages,
    rootTodos,
    children,
    statuses,
    childSnapshots,
  }
}

async function buildProjectedHistory(fixture: HistoryFixture) {
  return projectSessionHistory({
    sessionId: fixture.sessionId,
    cachedModelId: fixture.cachedModelId,
    rootMessages: fixture.rootMessages,
    rootTodos: fixture.rootTodos,
    children: fixture.children,
    statuses: fixture.statuses,
    loadChildSnapshot: async (childId: string) => {
      return fixture.childSnapshots.get(childId) || { messages: [], todos: [] }
    },
  })
}

function createStreamEvents(sessionId: string) {
  const events: Array<{ sessionId: string; data: Record<string, unknown> }> = []
  events.push({ sessionId, data: { type: 'busy' } })
  events.push({ sessionId, data: { type: 'agent', name: 'assistant' } })

  for (let taskIndex = 0; taskIndex < 6; taskIndex += 1) {
    const taskRunId = `task-${taskIndex + 1}`
    const childId = `child-${taskIndex + 1}`
    events.push({
      sessionId,
      data: {
        type: 'task_run',
        id: taskRunId,
        title: `Investigate area ${taskIndex + 1}`,
        agent: taskIndex % 2 === 0 ? 'research' : 'engineer',
        status: 'running',
        sourceSessionId: childId,
      },
    })

    for (let chunkIndex = 0; chunkIndex < 40; chunkIndex += 1) {
      events.push({
        sessionId,
        data: {
          type: 'text',
          role: 'assistant',
          messageId: 'assistant-live',
          partId: 'assistant-live:part:1',
          content: `root chunk ${taskIndex}-${chunkIndex} `,
          mode: 'append',
        },
      })
      events.push({
        sessionId,
        data: {
          type: 'text',
          taskRunId,
          messageId: `${taskRunId}:assistant`,
          partId: `${taskRunId}:assistant:part:1`,
          content: `task chunk ${taskIndex}-${chunkIndex} `,
          mode: 'append',
        },
      })

      if (chunkIndex % 5 === 0) {
        events.push({
          sessionId,
          data: {
            type: 'tool_call',
            id: `${taskRunId}:tool:${chunkIndex}`,
            taskRunId,
            name: 'fetch',
            input: { query: `doc-${chunkIndex}` },
            status: 'complete',
            output: { ok: true, chunkIndex },
            agent: taskIndex % 2 === 0 ? 'research' : 'engineer',
            sourceSessionId: childId,
          },
        })
      }

      if (chunkIndex % 10 === 0) {
        events.push({
          sessionId,
          data: {
            type: 'todos',
            taskRunId,
            todos: [
              { id: `${taskRunId}:todo:1`, content: 'Inspect source', status: 'done', priority: 'high' },
              { id: `${taskRunId}:todo:2`, content: 'Write summary', status: chunkIndex < 30 ? 'in_progress' : 'done', priority: 'medium' },
            ],
          },
        })
      }

      if (chunkIndex % 4 === 0) {
        events.push({
          sessionId,
          data: {
            type: 'cost',
            taskRunId,
            cost: 0.005,
            tokens: {
              input: 45,
              output: 20,
              reasoning: 4,
              cache: { read: 2, write: 0 },
            },
          },
        })
      }
    }

    events.push({
      sessionId,
      data: {
        type: 'compaction',
        taskRunId,
        id: `${taskRunId}:compaction`,
        auto: true,
        overflow: false,
        sourceSessionId: childId,
      },
    })
    events.push({
      sessionId,
      data: {
        type: 'compacted',
        taskRunId,
        id: `${taskRunId}:compaction`,
        auto: true,
        overflow: false,
        sourceSessionId: childId,
      },
    })
    events.push({
      sessionId,
      data: {
        type: 'task_run',
        id: taskRunId,
        title: `Investigate area ${taskIndex + 1}`,
        agent: taskIndex % 2 === 0 ? 'research' : 'engineer',
        status: 'complete',
        sourceSessionId: childId,
      },
    })
  }

  events.push({
    sessionId,
    data: {
      type: 'todos',
      todos: [
        { id: 'root:todo:1', content: 'Coordinate sub-work', status: 'done', priority: 'high' },
        { id: 'root:todo:2', content: 'Produce final answer', status: 'in_progress', priority: 'high' },
      ],
    },
  })
  events.push({ sessionId, data: { type: 'done' } })
  return events
}

function formatLine(result: BenchmarkResult) {
  return `${result.name.padEnd(28)} avg ${String(result.avgMs).padStart(7)} ms  p95 ${String(result.p95Ms).padStart(7)} ms  min ${String(result.minMs).padStart(7)} ms  max ${String(result.maxMs).padStart(7)} ms`
}

function writeStdout(line = '') {
  process.stdout.write(`${line}\n`)
}

function writeStderr(line = '') {
  process.stderr.write(`${line}\n`)
}

function createReport(results: BenchmarkResult[]): BenchmarkReport {
  return {
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    suiteRuns: 1,
    regressionThresholds: DEFAULT_THRESHOLDS,
    benchmarks: results,
  }
}

function aggregateReports(reports: BenchmarkReport[]): BenchmarkReport {
  if (reports.length === 1) return reports[0]

  const aggregateForName = (name: string) => {
    const entries = reports
      .map((report) => report.benchmarks.find((benchmark) => benchmark.name === name))
      .filter((entry): entry is BenchmarkResult => Boolean(entry))
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
    const median = (values: number[]) => {
      const ordered = sorted(values)
      return ordered[Math.floor(ordered.length / 2)] ?? 0
    }

    return {
      name,
      iterations: entries[0]?.iterations || 0,
      minMs: round(Math.min(...entries.map((entry) => entry.minMs))),
      maxMs: round(Math.max(...entries.map((entry) => entry.maxMs))),
      avgMs: round(median(entries.map((entry) => entry.avgMs))),
      p50Ms: round(median(entries.map((entry) => entry.p50Ms))),
      p95Ms: round(median(entries.map((entry) => entry.p95Ms))),
    }
  }

  const benchmarkNames = reports[0]?.benchmarks.map((benchmark) => benchmark.name) || []
  return {
    ...reports[0],
    generatedAt: new Date().toISOString(),
    suiteRuns: reports.length,
    benchmarks: benchmarkNames.map(aggregateForName),
  }
}

function compareReports(current: BenchmarkReport, baseline: BenchmarkReport) {
  const failures: string[] = []
  const baselineByName = new Map(baseline.benchmarks.map((entry) => [entry.name, entry]))
  const avgMultiplier = baseline.regressionThresholds?.avgMultiplier || DEFAULT_THRESHOLDS.avgMultiplier
  const p95Multiplier = baseline.regressionThresholds?.p95Multiplier || DEFAULT_THRESHOLDS.p95Multiplier
  const avgAbsoluteFloorMs = baseline.regressionThresholds?.avgAbsoluteFloorMs || DEFAULT_THRESHOLDS.avgAbsoluteFloorMs
  const p95AbsoluteFloorMs = baseline.regressionThresholds?.p95AbsoluteFloorMs || DEFAULT_THRESHOLDS.p95AbsoluteFloorMs

  for (const currentEntry of current.benchmarks) {
    const baselineEntry = baselineByName.get(currentEntry.name)
    if (!baselineEntry) continue

    const avgLimit = round(Math.max(
      baselineEntry.avgMs * avgMultiplier,
      baselineEntry.avgMs + avgAbsoluteFloorMs,
    ))
    const p95Limit = round(Math.max(
      baselineEntry.p95Ms * p95Multiplier,
      baselineEntry.p95Ms + p95AbsoluteFloorMs,
    ))

    if (currentEntry.avgMs > avgLimit) {
      failures.push(`${currentEntry.name} avg ${currentEntry.avgMs} ms exceeds baseline limit ${avgLimit} ms`)
    }
    if (currentEntry.p95Ms > p95Limit) {
      failures.push(`${currentEntry.name} p95 ${currentEntry.p95Ms} ms exceeds baseline limit ${p95Limit} ms`)
    }
  }

  return failures
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const shouldWrite = args.has('--write')
  const shouldCheck = args.has('--check')
  const runSuite = async () => {
    const historyFixture = createHistoryFixture()
    const projectedHistory = await buildProjectedHistory(historyFixture)
    const streamEvents = createStreamEvents('perf-stream')
    const hydratedEngine = new SessionEngine()
    hydratedEngine.activateSession('perf-view')
    hydratedEngine.setSessionFromHistory('perf-view', projectedHistory as any, { force: true })

    const results = [
      await runBenchmark('history.project.large', 10, async () => {
        const items = await buildProjectedHistory(historyFixture)
        if (items.length === 0) {
          throw new Error('history.project.large produced no items')
        }
      }, { batchSize: 4, warmupIterations: 3 }),
      await runBenchmark('engine.hydrate.large', 24, () => {
        const engine = new SessionEngine()
        engine.activateSession('perf-hydrate')
        engine.setSessionFromHistory('perf-hydrate', projectedHistory as any, { force: true })
        const view = engine.getSessionView('perf-hydrate')
        if (view.messages.length === 0 || view.taskRuns.length === 0) {
          throw new Error('engine.hydrate.large produced an empty view')
        }
      }, { batchSize: 4, warmupIterations: 3 }),
      await runBenchmark('engine.view.large', 30, () => {
        let lastView = hydratedEngine.getSessionView('perf-view')
        for (let index = 0; index < 500; index += 1) {
          lastView = hydratedEngine.getSessionView('perf-view')
        }
        if (lastView.messages.length === 0 || lastView.taskRuns.length === 0) {
          throw new Error('engine.view.large produced an empty view')
        }
      }, { batchSize: 2, warmupIterations: 2 }),
      await runBenchmark('engine.stream.mixed', 20, () => {
        const engine = new SessionEngine()
        engine.activateSession('perf-stream')
        for (const event of streamEvents) {
          engine.applyStreamEvent(event as any)
        }
        const view = engine.getSessionView('perf-stream')
        if (view.messages.length === 0 || view.taskRuns.length === 0 || view.sessionCost <= 0) {
          throw new Error('engine.stream.mixed produced an incomplete view')
        }
      }, { batchSize: 2, warmupIterations: 2 }),
    ]

    return createReport(results)
  }

  const printReport = (report: BenchmarkReport) => {
    writeStdout(`Perf benchmark report (${report.environment.platform}/${report.environment.arch} ${report.environment.node})`)
    for (const result of report.benchmarks) {
      writeStdout(formatLine(result))
    }
  }

  const suiteRuns = shouldCheck || shouldWrite ? 3 : 1
  const reports: BenchmarkReport[] = []
  for (let runIndex = 0; runIndex < suiteRuns; runIndex += 1) {
    reports.push(await runSuite())
  }
  let report = aggregateReports(reports)
  printReport(report)

  if (shouldWrite) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true })
    writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    writeStdout(`\nWrote baseline to ${BASELINE_PATH}`)
  }

  if (shouldCheck) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BenchmarkReport
    let failures = compareReports(report, baseline)
    if (failures.length > 0) {
      writeStdout('\nInitial perf check exceeded baseline. Retrying once to reduce machine-noise false positives.\n')
      report = await runSuite()
      printReport(report)
      failures = compareReports(report, baseline)
    }
    if (failures.length > 0) {
      writeStderr('\nPerf regression detected:')
      for (const failure of failures) {
        writeStderr(`- ${failure}`)
      }
      process.exitCode = 1
      return
    }
    writeStdout('\nPerf check passed against baseline.')
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  writeStderr(message)
  process.exitCode = 1
})
