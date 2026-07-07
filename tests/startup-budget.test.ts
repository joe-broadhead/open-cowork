import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionEngine } from '@open-cowork/runtime-host/session-engine'
import { createHistoryFixture, buildProjectedHistory } from '../scripts/perf/fixtures.ts'

// Startup-to-interactive budget (issue #900).
//
// A real headless cold-launch measurement isn't feasible in a node test, so this
// gates the main-process PROXY for "cold launch to first interactive session": a
// fresh SessionEngine, hydrating a realistically-sized session from projected
// history, and producing the first getSessionView() — the exact work the main
// process must finish before the renderer can paint an interactive transcript.
//
// The renderer half of startup (parse/eval bytes) is gated separately by the
// gzipped eager-bundle budget in scripts/check-bundle-size.mjs; together they form
// the enforced startup budget documented in docs/performance.md.
//
// The ceiling is an ABSOLUTE wall-clock bound on the MEDIAN sample (stable, unlike
// max/p95). Local median is ~0.3 ms for the shared perf fixture (355 projected
// items); the 12 ms ceiling leaves ~40x headroom so it never flakes on slow CI
// hardware, yet still fails hard on a catastrophic regression (e.g. an accidental
// O(n^2) hydrate would push a sub-millisecond path into the tens-to-hundreds of ms).
const COLD_START_CEILING_MS = 12

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

test('main-process cold-start to first interactive session view stays within budget', async () => {
  const fixture = createHistoryFixture()
  const projected = (await buildProjectedHistory(fixture)) as any[]
  assert.ok(projected.length > 0, 'perf fixture must project a non-empty history')

  const coldStartToInteractive = () => {
    const engine = new SessionEngine()
    engine.activateSession('cold-launch')
    engine.setSessionFromHistory('cold-launch', projected as any, { force: true })
    const view = engine.getSessionView('cold-launch')
    // Interactive = the transcript and task tree are hydrated and ready to paint.
    assert.ok(view.messages.length > 0, 'cold start must hydrate messages')
    assert.ok(view.taskRuns.length > 0, 'cold start must hydrate task runs')
    return view
  }

  // Warm the JIT so the measured window reflects steady-state hydrate cost rather
  // than first-call compilation, matching how the perf harness warms its samples.
  for (let index = 0; index < 30; index += 1) coldStartToInteractive()

  const samples: number[] = []
  for (let index = 0; index < 120; index += 1) {
    const start = performance.now()
    coldStartToInteractive()
    samples.push(performance.now() - start)
  }

  const medianMs = median(samples)
  assert.ok(
    medianMs <= COLD_START_CEILING_MS,
    `cold-start-to-interactive median ${medianMs.toFixed(3)} ms exceeds the ${COLD_START_CEILING_MS} ms `
    + 'startup budget. This is a catastrophic startup regression (the main-process hydrate path went '
    + 'from sub-millisecond to tens of ms). Investigate the SessionEngine hydrate/view path before '
    + 'raising COLD_START_CEILING_MS in tests/startup-budget.test.ts.',
  )
})
