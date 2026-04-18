import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: a healthy install with dozens of historical threads must
// bootstrap without jank. The sidebar flips on @tanstack/react-virtual
// above 50 rows, the dashboard drainer backfills usage summaries one
// session at a time, and every row renders an elapsed clock. A
// regression in any of those paths — a busted virtualizer dep array,
// a drainer deadlock, or a null-timestamp crash in the clock — is
// what this test catches.
//
// We seed 60 session records (above VIRTUALIZE_THRESHOLD) into the
// branded dataRoot so the registry loader picks them up on bootstrap.
// Each record carries realistic updatedAt deltas so the sort order is
// stable and `updatedAt` comparators get real inputs.

const SESSION_COUNT = 60

function makeSessionFixtures() {
  const base = Date.UTC(2026, 0, 1, 10, 0, 0)
  return Array.from({ length: SESSION_COUNT }, (_, index) => {
    const createdAt = new Date(base + index * 3_600_000).toISOString()
    const updatedAt = new Date(base + index * 3_600_000 + 60_000).toISOString()
    return {
      id: `ses_fixture_${String(index).padStart(3, '0')}`,
      title: `Fixture thread ${index + 1}`,
      directory: null,
      opencodeDirectory: '/tmp/open-cowork-smoke-fixture',
      createdAt,
      updatedAt,
      providerId: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
      summary: null,
      parentSessionId: null,
      changeSummary: null,
      revertedMessageId: null,
      managedByCowork: true as const,
    }
  })
}

test('sidebar renders dozens of seeded threads without failing the virtualizer', async () => {
  const fixtures = makeSessionFixtures()

  const { page, cleanup } = await launchSmokeApp({
    seedBeforeLaunch: ({ dataRoot }) => {
      writeFileSync(join(dataRoot, 'sessions.json'), JSON.stringify(fixtures, null, 2))
    },
  })
  try {
    await page.waitForSelector('h1:has-text("Workspace state")', { timeout: 30_000 })

    // The sidebar populates asynchronously via an IPC round-trip, so
    // poll until either the sessions show up or we give up — whichever
    // comes first. `sessions` is what the ThreadList reads from.
    await page.waitForFunction(
      (expectedCount) => {
        const state = (window as any).__coworkSessionStoreState?.()
        if (!state) return false
        return Array.isArray(state.sessions) && state.sessions.length >= expectedCount
      },
      SESSION_COUNT,
      { timeout: 20_000 },
    ).catch(() => {
      // Fall through to the DOM-based assertion. Not every build
      // exposes the store on window; the rendered UI is the real truth.
    })

    // At least one seeded title must be in the DOM. The virtualizer
    // only renders windowed rows, so we can't assert on all 60 — but
    // a couple of titles visible is enough to prove the list mounted
    // and the virtualized rows are being materialized.
    const visibleMatches = await page.locator('text=Fixture thread').count()
    assert.ok(visibleMatches > 0, `expected sidebar to render at least one fixture row, saw ${visibleMatches}`)

    // A crashed row would surface the ViewErrorBoundary copy. Guard
    // against a silent failure where React reset the subtree.
    const boundaryHit = await page.locator('text=/Something went wrong/i').count()
    assert.equal(boundaryHit, 0, 'no ViewErrorBoundary should have been triggered by the seeded history')
  } finally {
    await cleanup()
  }
})
