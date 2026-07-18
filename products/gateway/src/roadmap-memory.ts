import { loadWorkState, workStatePath, type RunRecord, type WorkState } from './work-store.js'
import { getRunsForRoadmap } from './work-store/queries.js'

/**
 * Upper bound on roadmap runs pulled into a memory digest. The digest only ever
 * surfaces tail slices (newest decisions/evidence/failures), so this indexed,
 * newest-first read is behaviour-preserving for those while keeping the load
 * flat regardless of total history. Only the raw environment-snapshot count can
 * differ for a roadmap with more than this many runs.
 */
const ROADMAP_MEMORY_RUN_LIMIT = 2000

export interface RoadmapMemory {
  roadmapId: string
  title: string
  generatedAt: string
  summary: string
  decisions: string[]
  evidence: string[]
  failures: string[]
  recentTasks: string[]
}

export function buildRoadmapMemory(roadmapId: string, state: WorkState = loadWorkState(), now = Date.now(), filePath = workStatePath()): RoadmapMemory | undefined {
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap) return undefined
  const tasks = state.tasks.filter(task => task.roadmapId === roadmapId)
  // Read the roadmap's runs from the indexed runs table (oldest-first, matching
  // the old `state.runs` ordering) instead of scanning a fully-materialized run
  // array, so this stays flat as history grows.
  const runs = getRunsForRoadmap(roadmapId, { limit: ROADMAP_MEMORY_RUN_LIMIT }, filePath).reverse()
  const environments = runs.map(run => run.environment).filter(Boolean)
  const decisions = unique(runs.flatMap(run => run.result?.decisions || [])).slice(-20)
  const evidence = unique(runs.flatMap(run => evidenceLabels(run))).slice(-30)
  const failures = runs
    .filter(run => ['failed', 'blocked', 'errored'].includes(run.status) || run.result?.failureClass)
    .slice(-12)
    .map(run => `${run.stage}: ${run.result?.failureClass || run.status} - ${run.result?.feedback || run.result?.summary || run.sessionId}`)
  failures.push(...runs.filter(run => run.environment?.status === 'cleanup_failed').slice(-8).map(run => `${run.stage}: environment cleanup_failed - ${run.environment?.backend}/${run.environment?.name} ${run.environment?.id}`))
  const recentTasks = tasks
    .slice(-20)
    .map(task => `[${task.status}] ${task.title}${task.note ? ` - ${task.note}` : ''}`)
  return {
    roadmapId,
    title: roadmap.title,
    generatedAt: new Date(now).toISOString(),
    summary: `${tasks.filter(task => task.status === 'done').length}/${tasks.length} tasks done; ${failures.length} recent failure(s); ${evidence.length} evidence item(s); ${environments.length} environment snapshot(s).`,
    decisions,
    evidence,
    failures,
    recentTasks,
  }
}

export function formatRoadmapMemory(memory: RoadmapMemory): string {
  const lines = [`Roadmap memory: ${memory.title}`, memory.summary]
  append(lines, 'Decisions', memory.decisions)
  append(lines, 'Evidence', memory.evidence)
  append(lines, 'Failures', memory.failures)
  append(lines, 'Recent tasks', memory.recentTasks.slice(-8))
  return lines.join('\n')
}

function evidenceLabels(run: RunRecord): string[] {
  const result = run.result
  const environment = run.environment
  return [
    ...(result?.artifacts || []).map(artifact => `${run.stage}: ${artifact}`),
    ...(result?.evidence || []).map(item => `${run.stage}: ${item.type} ${item.ref}${item.summary ? ` - ${item.summary}` : ''}`),
    ...(environment ? [`${run.stage}: environment ${environment.backend}/${environment.name} ${environment.status} cleanup=${environment.cleanup.state}`] : []),
    ...(environment?.artifacts || []).map(artifact => `${run.stage}: environment artifact ${artifact}`),
  ]
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const rows: string[] = []
  for (const value of values.map(row => row.trim()).filter(Boolean)) {
    if (seen.has(value)) continue
    seen.add(value)
    rows.push(value.substring(0, 500))
  }
  return rows
}

function append(lines: string[], title: string, rows: string[]): void {
  if (!rows.length) return
  lines.push(`${title}:`)
  for (const row of rows) lines.push(`- ${row}`)
}
