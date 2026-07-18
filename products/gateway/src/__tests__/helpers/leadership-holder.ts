/**
 * Child-process fixture for multi-process-store.test.ts.
 *
 * Acquires the daemon writer-leadership lease against the SQLite store named
 * by OPENCODE_GATEWAY_STATE_DIR (set by the parent) from a real separate OS
 * process, and prints the resulting snapshot as one JSON line.
 *
 * argv: <daemonId> [hold]
 * With "hold" the process keeps the lease until stdin closes (parent
 * controlled), then releases it and exits; without it the process reports the
 * acquired mode and exits immediately (releasing only if it became writer).
 */
import { createDaemonLeadership } from '../../daemon-leadership.js'

const daemonId = process.argv[2] || 'daemon'
const hold = process.argv[3] === 'hold'

const leadership = createDaemonLeadership({ daemonId, instanceId: `${daemonId}:proc-${process.pid}`, leaseMs: 60_000 })
const snapshot = leadership.acquireOrRenew({ source: 'multi-process-test' })
process.stdout.write(JSON.stringify({ mode: snapshot.mode, canWrite: snapshot.canWrite, leaderId: snapshot.leaderId }) + '\n')

if (hold) {
  const done = () => {
    try { leadership.release('multi-process-test') } catch {}
    process.exit(0)
  }
  process.stdin.resume()
  process.stdin.on('data', done)
  process.stdin.on('end', done)
} else if (snapshot.canWrite) {
  leadership.release('multi-process-test')
}
