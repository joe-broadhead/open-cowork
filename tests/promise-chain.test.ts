import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createKeyedPromiseChain,
  createPromiseChain,
  createSingleFlight,
} from '../apps/desktop/src/main/promise-chain.ts'

// `ensureRuntimeForDirectory` relies on `createPromiseChain()` to
// serialize concurrent callers arriving with different target
// directories. These tests pin the ordering + error-isolation contract
// so a future refactor can't silently regress it.

describe('createPromiseChain', () => {
  it('runs tasks in submission order, even when earlier tasks are slow', async () => {
    const runSerially = createPromiseChain()
    const log: string[] = []

    const p1 = runSerially(async () => {
      await new Promise((r) => setTimeout(r, 20))
      log.push('one')
    })
    const p2 = runSerially(async () => {
      log.push('two')
    })
    const p3 = runSerially(async () => {
      log.push('three')
    })

    await Promise.all([p1, p2, p3])
    assert.deepEqual(log, ['one', 'two', 'three'])
  })

  it('does not start a later task until the previous one has settled', async () => {
    const runSerially = createPromiseChain()
    let activeCount = 0
    let peakConcurrency = 0

    const makeTask = () => async () => {
      activeCount++
      peakConcurrency = Math.max(peakConcurrency, activeCount)
      await new Promise((r) => setTimeout(r, 10))
      activeCount--
    }

    await Promise.all([
      runSerially(makeTask()),
      runSerially(makeTask()),
      runSerially(makeTask()),
      runSerially(makeTask()),
    ])
    assert.equal(peakConcurrency, 1)
  })

  it('isolates errors — a rejected task does not break the chain', async () => {
    const runSerially = createPromiseChain()
    const log: string[] = []

    const p1 = runSerially(async () => { log.push('before') })
    const p2 = runSerially(async () => {
      log.push('fail')
      throw new Error('task two failed')
    })
    const p3 = runSerially(async () => { log.push('after') })

    await p1
    await assert.rejects(p2, /task two failed/)
    await p3

    assert.deepEqual(log, ['before', 'fail', 'after'])
  })

  it('propagates a task\'s resolved value to its caller', async () => {
    const runSerially = createPromiseChain()
    const a = await runSerially(async () => 'alpha')
    const b = await runSerially(async () => 42)
    assert.equal(a, 'alpha')
    assert.equal(b, 42)
  })
})

describe('createSingleFlight', () => {
  it('shares the same in-flight task and resets after settlement', async () => {
    const runOnce = createSingleFlight()
    let calls = 0
    let release!: (value: number) => void
    const pending = new Promise<number>((resolve) => { release = resolve })

    const p1 = runOnce(async () => {
      calls++
      return pending
    })
    const p2 = runOnce(async () => 99)

    assert.strictEqual(p1, p2)
    assert.equal(calls, 1)
    release(42)
    assert.equal(await p1, 42)

    assert.equal(await runOnce(async () => {
      calls++
      return 7
    }), 7)
    assert.equal(calls, 2)
  })
})

describe('createKeyedPromiseChain', () => {
  it('serializes work for the same key while allowing different keys to run concurrently', async () => {
    const runForKey = createKeyedPromiseChain()
    const log: string[] = []
    let activeA = 0
    let peakA = 0

    const firstA = runForKey('a', async () => {
      activeA++
      peakA = Math.max(peakA, activeA)
      log.push('a1:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      log.push('a1:end')
      activeA--
    })
    const secondA = runForKey('a', async () => {
      activeA++
      peakA = Math.max(peakA, activeA)
      log.push('a2')
      activeA--
    })
    const firstB = runForKey('b', async () => {
      log.push('b1')
    })

    await Promise.all([firstA, secondA, firstB])

    assert.equal(peakA, 1)
    assert.ok(log.indexOf('a1:end') < log.indexOf('a2'))
    assert.ok(log.includes('b1'))
  })
})
