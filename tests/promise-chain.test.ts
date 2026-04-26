import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPromiseChain } from '../apps/desktop/src/main/promise-chain.ts'

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
