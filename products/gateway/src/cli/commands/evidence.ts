import * as fs from 'node:fs'
import * as path from 'node:path'
import { allArgValues, argValue, firstEvidenceOutputArg, hasArg } from '../shared.js'

export async function evidenceCommand() {
  const sub = process.argv[3] || 'export'
  if (sub !== 'export' && sub !== 'incident' && sub !== 'replay-consistency') {
    console.log('Usage: opencode-gateway evidence <export|incident|replay-consistency> [output] [--task id] [--run id] [--session id] [--roadmap id] [--project id] [--alert id] [--active-session id] [--json]')
    return
  }

  if (sub === 'replay-consistency') {
    const workStore = await import('../../work-store.js')
    const evidence = await import('../../evidence-export.js')
    const mission = await import('../../mission-control-view-model.js')
    const runtime = await import('../../runtime-replay-consistency.js')
    const eventLimit = argValue('--limit') ? Number(argValue('--limit')) : 500
    const state = workStore.loadWorkState()
    const activeSessionIds = new Set(allArgValues('--active-session').flatMap(value => value.split(',').map(row => row.trim()).filter(Boolean)))
    const dashboardSummary = mission.buildMissionControlDashboardSummary({
      health: { status: 'ok' },
      taskData: {
        counts: workStore.summarizeWorkTasks(state.tasks),
        tasks: state.tasks.map(task => ({
          id: task.id,
          status: task.status,
          priority: task.priority,
          title: task.title,
          agent: task.agent,
          currentStage: task.currentStage,
        })),
        roadmaps: state.roadmaps.map(roadmap => ({
          id: roadmap.id,
          status: roadmap.status,
          priority: roadmap.priority,
          title: roadmap.title,
        })),
        runs: state.runs.map(run => ({ id: run.id, status: run.status, sessionId: run.sessionId })),
      },
      sessions: {
        sessions: [...activeSessionIds].map(id => ({ id })),
        counts: { running: activeSessionIds.size, total: activeSessionIds.size },
      },
      questions: { questions: [] },
      permissions: { permissions: [] },
    })
    const evidenceBundle = evidence.buildEvidenceBundle({ eventLimit })
    const report = runtime.buildRuntimeReplayConsistencyReport({
      state,
      events: workStore.listWorkEvents(eventLimit),
      routeReceipts: workStore.listDelegationProgressRouteReceipts({ limit: Math.min(Math.max(eventLimit, 1), 1000) }),
      channelBindings: workStore.listChannelBindings({}),
      projectBindings: workStore.listProjectBindings({}),
      taskDispatchReceipts: workStore.listTaskDispatchReceipts({}),
      dashboardSummary,
      evidenceManifest: evidenceBundle.manifest,
      activeSessionIds,
    })
    if (hasArg('--json')) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    const output = firstEvidenceOutputArg() || path.join(process.cwd(), 'runtime-replay-consistency-report.json')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(`Runtime replay consistency: ${report.status}`)
    console.log(`Findings: ${report.counts.findings} (${report.counts.criticalFindings} critical, ${report.counts.warningFindings} warning)`)
    console.log(`Determinism key: ${report.determinismKey}`)
    console.log(`Report: ${output}`)
    return
  }

  if (sub === 'incident') {
    const incident = await import('../../incident-bundle.js')
    const bundle = incident.buildIncidentBundle({
      alertId: argValue('--alert'),
      target: {
        taskId: argValue('--task'),
        runId: argValue('--run'),
        sessionId: argValue('--session'),
        roadmapId: argValue('--roadmap'),
        projectId: argValue('--project'),
      },
    })
    if (hasArg('--json')) {
      console.log(JSON.stringify(bundle.manifest, null, 2))
      return
    }
    const output = firstEvidenceOutputArg() || incident.defaultIncidentBundleDir(bundle.manifest.id)
    const written = incident.writeIncidentBundle(bundle, output)
    console.log(`Incident bundle: ${bundle.manifest.id}`)
    console.log(`Status: ${bundle.manifest.status}`)
    console.log(`Trace: ${bundle.manifest.traceRootId}`)
    console.log(`Manifest: ${written.manifestPath}`)
    console.log(`Markdown: ${written.markdownPath}`)
    console.log(`Evidence: ${written.evidenceDir}`)
    return
  }

  const evidence = await import('../../evidence-export.js')
  const unredacted = hasArg('--unredacted') || argValue('--redact') === 'false'
  const bundle = evidence.buildEvidenceBundle({
    mode: unredacted ? 'unredacted' : 'redacted',
    allowUnredacted: unredacted && hasArg('--local-admin'),
    target: {
      taskId: argValue('--task'),
      runId: argValue('--run'),
      sessionId: argValue('--session'),
      roadmapId: argValue('--roadmap'),
      projectId: argValue('--project'),
    },
    eventLimit: argValue('--limit') ? Number(argValue('--limit')) : undefined,
  })

  if (hasArg('--json')) {
    console.log(JSON.stringify(bundle.manifest, null, 2))
    return
  }

  const output = firstEvidenceOutputArg() || evidence.defaultEvidenceBundleDir(bundle.manifest.id)
  const written = evidence.writeEvidenceBundle(bundle, output)
  console.log(`Evidence bundle: ${bundle.manifest.id}`)
  console.log(`Mode: ${bundle.manifest.mode}`)
  console.log(`Manifest: ${written.manifestPath}`)
  console.log(`Markdown: ${written.markdownPath}`)
}
