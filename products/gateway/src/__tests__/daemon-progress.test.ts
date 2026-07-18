import { afterEach, describe, expect, it } from 'vitest'
import { __daemonTest } from '../daemon.js'
import { clearEventsForTest, getQueuedEvents } from '../wakeup.js'

describe('daemon progress notification loop', () => {
  afterEach(() => {
    clearEventsForTest()
  })

  it('bounds a hung sub-delivery and clears the in-flight guard for later cycles', async () => {
    const delivered: string[] = []

    await __daemonTest.notifyProgressDeliveriesOnce([
      async () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('delegated progress parent session prompt timed out after 5ms')), 5)),
      async () => { delivered.push('first-cycle') },
    ])

    await __daemonTest.notifyProgressDeliveriesOnce([
      async () => { delivered.push('second-cycle') },
    ])

    expect(delivered).toEqual(['first-cycle', 'second-cycle'])
    expect(getQueuedEvents().join('\n')).toContain('Progress notify failed: delegated progress parent session prompt timed out after 5ms')
  })

  it('waits for tracked daemon work before declaring the drain complete', async () => {
    let release!: () => void
    const work = new Promise<void>(resolve => { release = resolve })
    __daemonTest.trackDaemonOperation(work)
    let drained = false
    const drain = __daemonTest.drainDaemonOperations().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await drain
    expect(drained).toBe(true)
  })
})
