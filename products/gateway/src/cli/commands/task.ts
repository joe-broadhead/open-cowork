import { formatTaskCounts } from '../../task-summary.js'
import { fetchGatewayJson, hasArg, patchGatewayJson, postGatewayJson } from '../shared.js'

export async function taskCommand() {
  const sub = process.argv[3] || 'list'
  const local = hasArg('--local')
  const text = process.argv.slice(4).filter(arg => arg !== '--local').join(' ')

  if (sub === 'add' && text) {
    if (local) {
      const { createWorkTask } = await import('../../work-store.js')
      const task = createWorkTask({ title: text, priority: 'HIGH' })
      console.log(`Issue (task) added: ${task.title}`)
      console.log(`ID: ${task.id}`)
      return
    }
    const { task } = await postGatewayJson('/tasks', { title: text, priority: 'HIGH' })
    console.log(`Issue (task) added: ${task.title}`)
    console.log(`ID: ${task.id}`)
  } else if (sub === 'done' && text) {
    if (local) {
      const { markWorkTaskDone } = await import('../../work-store.js')
      const durable = markWorkTaskDone(text)
      console.log(durable ? `Issue (task) marked done: ${text}` : `Issue (task) not found: ${text}`)
      return
    }
    const snapshot = await fetchGatewayJson('/tasks')
    const task = (snapshot.tasks || []).find((row: any) => row.id === text || String(row.title || '').includes(text))
    if (!task) return console.log(`Issue (task) not found: ${text}`)
    await patchGatewayJson(`/tasks/${encodeURIComponent(task.id)}`, { status: 'done', note: 'completed from CLI' })
    console.log(`Issue (task) marked done: ${task.title || text}`)
  } else if (sub === 'list') {
    const { tasks, counts } = local
      ? await localTaskSnapshot()
      : await fetchGatewayJson('/tasks')
    console.log(formatTaskCounts(counts))
    console.log(tasks.map((task: any) => `- [${task.status}] ${task.priority}: ${task.title} — ${task.currentStage || 'complete'}${task.activeRun ? ` (${task.activeRun.sessionId})` : ''}`).join('\n'))
  } else {
    console.log('Usage: opencode-gateway task <add|list|done> [issue text] [--local]')
    process.exit(1)
  }
}

async function localTaskSnapshot(): Promise<{ tasks: any[]; counts: Record<string, number> }> {
  const { getWorkQueueSnapshot } = await import('../../scheduler.js')
  const { tasks, counts } = getWorkQueueSnapshot()
  return { tasks, counts }
}
