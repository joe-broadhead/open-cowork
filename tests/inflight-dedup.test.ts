import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dedupByKey } from '../apps/desktop/src/main/inflight-dedup.ts'

// The provider-catalog refresh path uses this primitive to collapse the
// ~10 parallel `getProviderDescriptors()` reads that fire on cold boot
// into a single HTTPS call. These tests pin the concurrency contract so a
// future refactor can't silently regress it.

describe('dedupByKey', () => {
  it('shares a single in-flight promise across concurrent callers for the same key', async () => {
    const inflight = new Map<string, Promise<number>>()
    let runCalls = 0
    let release!: (value: number) => void
    const pending = new Promise<number>((resolve) => { release = resolve })

    const run = () => {
      runCalls++
      return pending
    }

    const p1 = dedupByKey(inflight, 'k', run)
    const p2 = dedupByKey(inflight, 'k', run)
    const p3 = dedupByKey(inflight, 'k', run)

    assert.equal(runCalls, 1)
    assert.equal(inflight.size, 1)
    assert.strictEqual(p1, p2)
    assert.strictEqual(p2, p3)

    release(42)
    const [a, b, c] = await Promise.all([p1, p2, p3])
    assert.equal(a, 42)
    assert.equal(b, 42)
    assert.equal(c, 42)
  })

  it('clears the key once the promise settles so the next call re-runs', async () => {
    const inflight = new Map<string, Promise<string>>()
    let runCalls = 0
    const run = async () => {
      runCalls++
      return `run-${runCalls}`
    }

    const first = await dedupByKey(inflight, 'k', run)
    assert.equal(first, 'run-1')
    assert.equal(inflight.size, 0)

    const second = await dedupByKey(inflight, 'k', run)
    assert.equal(second, 'run-2')
    assert.equal(runCalls, 2)
  })

  it('clears the key on rejection too so the next call is not stuck', async () => {
    const inflight = new Map<string, Promise<number>>()
    let runCalls = 0
    const run = async () => {
      runCalls++
      if (runCalls === 1) throw new Error('first call fails')
      return 7
    }

    await assert.rejects(dedupByKey(inflight, 'k', run), /first call fails/)
    assert.equal(inflight.size, 0)

    const retry = await dedupByKey(inflight, 'k', run)
    assert.equal(retry, 7)
    assert.equal(runCalls, 2)
  })

  it('runs independently for different keys', async () => {
    const inflight = new Map<string, Promise<string>>()
    let aCalls = 0
    let bCalls = 0

    const pa = dedupByKey(inflight, 'a', async () => { aCalls++; return 'A' })
    const pb = dedupByKey(inflight, 'b', async () => { bCalls++; return 'B' })

    assert.notStrictEqual(pa, pb)
    assert.equal(await pa, 'A')
    assert.equal(await pb, 'B')
    assert.equal(aCalls, 1)
    assert.equal(bCalls, 1)
  })
})
