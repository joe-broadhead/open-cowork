import { SessionEngine } from '../../apps/desktop/src/main/session-engine.ts'
import { buildProjectedHistory, createHistoryFixture, createStreamEvents } from './fixtures.ts'
import { createReport } from './report.ts'
import { runBenchmark } from './run.ts'

export async function runSessionBenchmarks() {
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
    }, { batchSize: 4, warmupIterations: 3 }),
  ]

  return createReport(results)
}
