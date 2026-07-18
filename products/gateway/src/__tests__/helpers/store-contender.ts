/**
 * Child-process fixture for multi-process-store.test.ts.
 *
 * Hammers the shared SQLite work store from a separate OS process so real WAL
 * locking and PRAGMA busy_timeout handling are exercised across process
 * boundaries (mutateWorkState BEGIN IMMEDIATE transactions via createWorkTask
 * and applyWorkTaskAction). The parent points OPENCODE_GATEWAY_STATE_DIR and
 * OPENCODE_GATEWAY_CONFIG_DIR at the contended state directory before spawning.
 *
 * argv: <workerId> <taskCount>
 * Prints a single JSON line: { workerId, created: [taskIds...] } and exits 0;
 * any dropped or failed write surfaces as a thrown error and a non-zero exit.
 */
import { applyWorkTaskAction, createRoadmap, createWorkTask } from '../../work-store.js'

const workerId = process.argv[2] || 'worker'
const count = Number(process.argv[3] || 25)

const roadmap = createRoadmap({ title: `Contention roadmap ${workerId}` })
const created: string[] = []
for (let i = 0; i < count; i += 1) {
  const task = createWorkTask({ title: `contend-${workerId}-${i}`, roadmapId: roadmap.id })
  // Two more contended mutateWorkState transactions per task: pause + resume.
  // The final resume leaves every task 'pending'; a silently dropped busy
  // write would leave it 'paused' and fail the parent's assertions.
  applyWorkTaskAction(task.id, 'pause', { note: `paused by ${workerId}` })
  applyWorkTaskAction(task.id, 'resume')
  created.push(task.id)
}
process.stdout.write(JSON.stringify({ workerId, created }) + '\n')
