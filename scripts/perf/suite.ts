import { ThreadIndexStore } from '@open-cowork/runtime-host/thread-index/thread-index-store'
import { SessionEngine } from '@open-cowork/runtime-host/session-engine'
import { buildCoworkRuntimePermissionConfig } from '@open-cowork/runtime-host/runtime-permissions'
import { summarizeCustomAgents } from '@open-cowork/runtime-host/custom-agents-utils'
import { buildOpenCoworkAgentConfig } from '@open-cowork/runtime-host/agent-config'
import { buildLaunchpadFeedFromSources } from '@open-cowork/runtime-host/launchpad/launchpad-service'
import {
  clearArtifactLifecycleStoreCache,
  indexLocalSessionArtifactsFromView,
  setArtifactLifecycleDatabaseForTests,
} from '@open-cowork/runtime-host/artifact-index'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCapabilityMapGroups } from '../../packages/app/src/components/capabilities/capabilities-page-support.ts'
import { compileAgentPreview } from '../../packages/app/src/components/agents/agent-builder-utils.ts'
import {
  createDownstreamCatalogFixture,
  DOWNSTREAM_SKILL_COUNT,
} from './downstream-catalog-fixture.ts'
import { buildProjectedHistory, createHistoryFixture, createStreamEvents } from './fixtures.ts'
import { createReport } from './report.ts'
import { runBenchmark } from './run.ts'

function createSeededThreadIndexStore() {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-perf-thread-index-'))
  const store = new ThreadIndexStore(join(root, 'thread-index.sqlite'))
  for (let index = 0; index < 5_000; index += 1) {
    store.upsertThread({
      sessionId: `perf-thread-${String(index).padStart(4, '0')}`,
      title: index % 2 === 0 ? `Revenue report ${index}` : `Agent investigation ${index}`,
      directory: index % 3 === 0 ? `/workspace/downstream-${index % 8}` : null,
      projectLabel: index % 3 === 0 ? `downstream-${index % 8}` : null,
      providerId: index % 2 === 0 ? 'openrouter' : 'codex',
      modelId: index % 2 === 0 ? 'openrouter/sonnet' : 'codex/gpt-5',
      status: index % 11 === 0 ? 'needs_user' : 'idle',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index % 60)).toISOString(),
      messageCount: index % 18,
      toolCallCount: index % 7,
      taskRunCount: index % 5,
      actualAgents: index % 2 === 0 ? [{ name: 'research', count: 2 }] : [{ name: 'review', count: 1 }],
      actualTools: index % 5 === 0 ? [{ name: 'charts.create', mcpName: 'charts', count: 1 }] : [],
    })
  }
  return {
    store,
    close() {
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function perfIso(day: number, minute: number, second = 0) {
  return new Date(Date.UTC(2033, 0, day, 0, minute, second)).toISOString()
}

function createLaunchpadFeedFixture() {
  const projects = Array.from({ length: 8 }, (_, index) => ({
    id: `perf-project-${index}`,
    kind: 'project',
    workspaceId: 'local',
    ownerAuthority: 'local',
    executionAuthority: 'local',
    stateOwner: 'local',
    title: `Project ${index}`,
    objective: `Coordinate project ${index}`,
    status: 'active',
    team: ['build', 'review'],
    createdAt: perfIso(1, index),
    updatedAt: perfIso(2, index),
  }))
  const tasks = Array.from({ length: 240 }, (_, index) => ({
    id: `perf-task-${index}`,
    kind: 'task',
    workspaceId: 'local',
    ownerAuthority: 'local',
    executionAuthority: 'local',
    stateOwner: 'local',
    projectId: projects[index % projects.length]!.id,
    title: `Task ${index}`,
    spec: `Coordinate task ${index}`,
    status: index % 5 === 0 ? 'completed' : index % 3 === 0 ? 'running' : 'open',
    column: index % 5 === 0 ? 'done' : 'doing',
    priority: index % 4 === 0 ? 'high' : 'medium',
    assigneeAgent: index % 2 === 0 ? 'build' : 'review',
    assignedRunId: `run-${index}`,
    assignedSessionId: `launchpad-session-${index % 120}`,
    createdAt: perfIso(1, index % 60, index % 60),
    updatedAt: perfIso(3, index % 60, index % 60),
  }))
  const sessions = Array.from({ length: 120 }, (_, index) => ({
    sessionId: `launchpad-session-${index}`,
    title: `Launchpad session ${index}`,
    createdAt: perfIso(1, index % 60),
    updatedAt: perfIso(4, index % 60, index % 60),
    runId: `run-${index}`,
    view: {
      pendingApprovals: index % 2 === 0 ? [{
        id: `approval-${index}`,
        sessionId: `launchpad-session-${index}`,
        taskRunId: `run-${index}`,
        tool: 'shell',
        description: `Approve task ${index}`,
      }] : [],
      pendingQuestions: index % 3 === 0 ? [{
        id: `question-${index}`,
        sessionId: `launchpad-session-${index}`,
        questions: [{ id: `q-${index}`, header: 'Clarify', question: `Clarify task ${index}` }],
      }] : [],
    },
  }))
  const artifacts = Array.from({ length: 360 }, (_, index) => ({
    id: `artifact-${index}`,
    workspaceId: 'local',
    sessionId: `launchpad-session-${index % 120}`,
    sessionTitle: `Launchpad session ${index % 120}`,
    toolId: `tool-${index}`,
    toolName: 'write',
    filename: `artifact-${index}.md`,
    filePath: `/tmp/open-cowork-perf/artifact-${index}.md`,
    kind: index % 2 === 0 ? 'document' : 'chart',
    status: index % 3 === 0 ? 'in-review' : 'draft',
    projectId: projects[index % projects.length]!.id,
    taskId: `perf-task-${index % tasks.length}`,
    taskRunId: `run-${index % tasks.length}`,
    authorAgentId: index % 2 === 0 ? 'build' : 'review',
    createdAt: perfIso(2, index % 60, index % 60),
    updatedAt: perfIso(5, index % 60, index % 60),
  }))
  return {
    board: { projects, tasks },
    sessions,
    artifacts,
  }
}

function createLocalArtifactIndexFixture() {
  const db = new DatabaseSync(':memory:')
  setArtifactLifecycleDatabaseForTests(db)
  const artifactCount = 320
  const artifacts = Array.from({ length: artifactCount }, (_, index) => ({
    id: `local-artifact-${index}`,
    toolId: `tool-${index}`,
    toolName: 'write',
    filename: `local-artifact-${index}.md`,
    filePath: `/tmp/open-cowork-perf/local-artifact-${index}.md`,
    order: index,
    taskRunId: `local-run-${index}`,
  }))
  const tasks = Array.from({ length: artifactCount }, (_, index) => ({
    id: `local-task-${index}`,
    projectId: `local-project-${index % 12}`,
    assigneeAgent: index % 2 === 0 ? 'build' : 'review',
    assignedRunId: `local-run-${index}`,
    assignedSessionId: 'local-artifact-session',
  }))
  const view = {
    toolCalls: [],
    taskRuns: [],
    artifacts,
  }
  return {
    view,
    tasks,
    close() {
      setArtifactLifecycleDatabaseForTests(null)
      clearArtifactLifecycleStoreCache()
      db.close()
    },
  }
}

function createCloudStoreFixture() {
  const store = new InMemoryControlPlaneStore()
  const tenantId = 'perf-tenant'
  const userId = 'perf-user'
  store.createTenant({ tenantId, name: 'Perf tenant' })
  store.ensureUser({ tenantId, userId, email: 'perf@example.test', role: 'owner' })
  for (let index = 0; index < 180; index += 1) {
    const sessionId = `cloud-session-${index}`
    store.createSession({
      tenantId,
      userId,
      sessionId,
      opencodeSessionId: `oc-${sessionId}`,
      profileName: 'default',
      title: `Cloud session ${index}`,
      createdAt: new Date(Date.UTC(2033, 1, 1, 0, index % 60, index % 60)),
    })
    store.upsertCloudLaunchpadSessionSummary({
      tenantId,
      userId,
      sessionId,
      updatedAt: perfIso(5, index % 60, index % 60),
      pendingApprovals: index % 2 === 0 ? [{
        id: `approval-${index}`,
        sessionId,
        tool: 'shell',
        description: `Approve cloud action ${index}`,
      }] : [],
      pendingQuestions: index % 3 === 0 ? [{
        id: `question-${index}`,
        sessionId,
        questions: [{ id: `q-${index}`, header: 'Clarify', question: `Clarify cloud task ${index}` }],
      }] : [],
    })
    for (let artifactIndex = 0; artifactIndex < 3; artifactIndex += 1) {
      const absoluteIndex = index * 3 + artifactIndex
      store.upsertCloudArtifactIndex({
        tenantId,
        userId,
        sessionId,
        artifactId: `cloud-artifact-${absoluteIndex}`,
        filename: `cloud-artifact-${absoluteIndex}.md`,
        contentType: 'text/markdown',
        size: 1_000 + absoluteIndex,
        key: `tenant/${sessionId}/artifact-${absoluteIndex}.md`,
        kind: artifactIndex === 0 ? 'document' : 'chart',
        status: artifactIndex === 2 ? 'in-review' : 'draft',
        authorAgentId: artifactIndex % 2 === 0 ? 'build' : 'review',
        projectId: `cloud-project-${index % 8}`,
        taskId: `cloud-task-${absoluteIndex % 90}`,
        statusUpdatedBy: null,
        statusUpdatedAt: null,
        createdAt: perfIso(2, absoluteIndex % 60, artifactIndex),
        updatedAt: perfIso(6, absoluteIndex % 60, artifactIndex),
      })
    }
  }
  for (let workflowIndex = 0; workflowIndex < 48; workflowIndex += 1) {
    const workflowId = `perf-workflow-${workflowIndex}`
    store.createWorkflow({
      tenantId,
      userId,
      workflowId,
      draft: {
        title: `Workflow ${workflowIndex}`,
        instructions: 'Synthetic workflow perf fixture.',
        agentName: 'build',
        skillNames: [],
        toolIds: [],
        projectDirectory: null,
        draftSessionId: null,
        triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      },
      createdAt: new Date(Date.UTC(2033, 1, 2, 0, workflowIndex % 60)),
    })
    for (let runIndex = 0; runIndex < 24; runIndex += 1) {
      const runId = `${workflowId}-run-${runIndex}`
      store.createWorkflowRun({
        tenantId,
        userId,
        workflowId,
        runId,
        triggerType: 'manual',
        createdAt: new Date(Date.UTC(2033, 1, 3, 0, runIndex, workflowIndex % 60)),
      })
      store.completeWorkflowRun({
        tenantId,
        workflowId,
        runId,
        summary: `done ${runIndex}`,
        nextStatus: 'active',
        nextRunAt: null,
        finishedAt: new Date(Date.UTC(2033, 1, 3, 0, runIndex, (workflowIndex % 60) + 1)),
      })
    }
  }
  return {
    store,
    tenantId,
    userId,
    workflowIds: Array.from({ length: 48 }, (_, index) => `perf-workflow-${index}`),
  }
}

export async function runSessionBenchmarks() {
  const historyFixture = createHistoryFixture()
  const downstreamCatalog = createDownstreamCatalogFixture()
  const downstreamProjectDirectory = join(tmpdir(), 'open-cowork-downstream-project')
  const threadIndex = createSeededThreadIndexStore()
  const launchpadFeed = createLaunchpadFeedFixture()
  const localArtifactIndex = createLocalArtifactIndexFixture()
  const cloudStore = createCloudStoreFixture()
  const projectedHistory = await buildProjectedHistory(historyFixture)
  const streamEvents = createStreamEvents('perf-stream')
  const hydratedEngine = new SessionEngine()
  hydratedEngine.activateSession('perf-view')
  hydratedEngine.setSessionFromHistory('perf-view', projectedHistory as any, { force: true })

  try {
    const results = [
      // This is the suite's only *async* benchmark and it runs first, so its
      // measured window inherits the GC/JIT churn from the heavy fixture setup
      // above. At 10 samples `p95` is just the max sample, so a single inherited
      // pause spiked p95 to ~4 ms (vs a ~0.4 ms steady state that matches the
      // baseline) and failed the gate. More warmup absorbs the setup churn and
      // more samples make p95 a real percentile rather than the lone worst run.
      await runBenchmark('history.project.large', 40, async () => {
        const items = await buildProjectedHistory(historyFixture)
        if (items.length === 0) {
          throw new Error('history.project.large produced no items')
        }
      }, { batchSize: 4, warmupIterations: 16 }),
      await runBenchmark('engine.hydrate.large', 24, () => {
        const engine = new SessionEngine()
        engine.activateSession('perf-hydrate')
        engine.setSessionFromHistory('perf-hydrate', projectedHistory as any, { force: true })
        const view = engine.getSessionView('perf-hydrate')
        if (view.messages.length === 0 || view.taskRuns.length === 0) {
          throw new Error('engine.hydrate.large produced an empty view')
        }
      }, { batchSize: 4, warmupIterations: 3 }),
      await runBenchmark('engine.view.large', 30, () => {
        let lastView = hydratedEngine.getSessionView('perf-view')
        for (let index = 0; index < 500; index += 1) {
          lastView = hydratedEngine.getSessionView('perf-view')
        }
        if (lastView.messages.length === 0 || lastView.taskRuns.length === 0) {
          throw new Error('engine.view.large produced an empty view')
        }
      }, { batchSize: 2, warmupIterations: 2 }),
      await runBenchmark('engine.stream.mixed', 20, () => {
        const engine = new SessionEngine()
        engine.activateSession('perf-stream')
        for (const event of streamEvents) {
          engine.applyStreamEvent(event as any)
        }
        const view = engine.getSessionView('perf-stream')
        if (view.messages.length === 0 || view.taskRuns.length === 0 || view.sessionCost <= 0) {
          throw new Error('engine.stream.mixed produced an incomplete view')
        }
      }, { batchSize: 4, warmupIterations: 3 }),
      await runBenchmark('runtime.permission.downstreamCatalog', 24, () => {
        const permission = buildCoworkRuntimePermissionConfig({
          managedSkillNames: downstreamCatalog.skillNames,
          allowPatterns: downstreamCatalog.allowPatterns,
          askPatterns: downstreamCatalog.askPatterns,
          bash: 'ask',
          fileWrite: 'ask',
          task: 'allow',
          web: 'allow',
          webSearch: 'allow',
          projectDirectory: downstreamProjectDirectory,
        }) as Record<string, unknown>
        const externalDirectory = permission.external_directory as Record<string, unknown>
        if (Object.keys(externalDirectory).length > 5) {
          throw new Error('runtime.permission.downstreamCatalog generated per-skill external directory rules')
        }
        if (JSON.stringify(permission).length > 16_000) {
          throw new Error('runtime.permission.downstreamCatalog produced an unexpectedly large permission payload')
        }
      }, { batchSize: 4, warmupIterations: 3 }),
      await runBenchmark('agents.catalog.downstreamCatalog', 18, () => {
        const agents = buildOpenCoworkAgentConfig({
          allToolPatterns: downstreamCatalog.allToolPatterns,
          allowToolPatterns: downstreamCatalog.allowPatterns,
          askToolPatterns: downstreamCatalog.askPatterns,
          managedSkillNames: downstreamCatalog.skillNames,
          availableSkillNames: downstreamCatalog.skillNames,
          bash: 'ask',
          fileWrite: 'ask',
          task: 'allow',
          web: 'allow',
          webSearch: 'allow',
          projectDirectory: downstreamProjectDirectory,
          customDelegationAgents: downstreamCatalog.customAgents,
        })
        if (!agents.build || !agents.plan) {
          throw new Error('agents.catalog.downstreamCatalog produced an incomplete agent catalog')
        }
        const buildTaskRules = agents.build.permission.task as Record<string, unknown>
        for (const agent of downstreamCatalog.customAgents) {
          if (agents[agent.name]) {
            throw new Error('agents.catalog.downstreamCatalog duplicated a native custom agent in config.agent')
          }
          if (buildTaskRules[agent.name] !== 'allow') {
            throw new Error('agents.catalog.downstreamCatalog missed a custom agent delegation rule')
          }
        }
      }, { batchSize: 2, warmupIterations: 2 }),
      await runBenchmark('capabilities.map.downstreamCatalog', 30, () => {
        const groups = buildCapabilityMapGroups(
          downstreamCatalog.tools,
          downstreamCatalog.skills,
          'tool 01',
        )
        if (groups.length === 0) {
          throw new Error('capabilities.map.downstreamCatalog produced no groups')
        }
      }, { batchSize: 8, warmupIterations: 3 }),
      await runBenchmark('catalog.relationship.downstreamCatalog', 30, () => {
        const summaries = summarizeCustomAgents({
          state: {
            customMcps: downstreamCatalog.tools.map((tool) => ({
              name: tool.id,
              label: tool.name,
              description: tool.description,
              permissionMode: tool.source === 'custom' ? 'ask' as const : 'allow' as const,
            })),
            customSkills: downstreamCatalog.skills.map((skill) => ({
              name: skill.name,
              label: skill.label,
              description: skill.description,
              content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n# ${skill.label}`,
              toolIds: skill.toolIds,
            })),
            customAgents: downstreamCatalog.customAgents.map((agent) => ({
              name: agent.name,
              description: agent.description,
              instructions: agent.instructions,
              skillNames: agent.skillNames,
              toolIds: downstreamCatalog.tools.slice(0, 3).map((tool) => tool.id),
              enabled: !agent.disabled,
              color: agent.color,
            })),
          },
          availableSkills: downstreamCatalog.agentCatalog.skills,
          runtimeTools: downstreamCatalog.agentCatalog.tools.map((tool) => ({
            id: tool.id,
            description: tool.description,
          })),
          builtinTools: [],
          builtinSkills: [],
        })
        if (summaries.length !== downstreamCatalog.customAgents.length) {
          throw new Error('catalog.relationship.downstreamCatalog lost custom agents')
        }
      }, { batchSize: 8, warmupIterations: 3 }),
      await runBenchmark('agents.preview.downstreamCatalog', 30, () => {
        const preview = compileAgentPreview({
          scope: 'machine',
          directory: null,
          name: 'downstream-agent',
          description: 'Synthetic downstream catalog agent.',
          instructions: 'Use the selected downstream tools and skills.',
          toolIds: downstreamCatalog.agentCatalog.tools.slice(0, 12).map((tool) => tool.id),
          skillNames: downstreamCatalog.agentCatalog.skills.slice(0, DOWNSTREAM_SKILL_COUNT / 2).map((skill) => skill.name),
          enabled: true,
          color: 'accent',
        }, downstreamCatalog.agentCatalog)
        if (preview.selectedSkills.length === 0 || preview.selectedTools.length === 0) {
          throw new Error('agents.preview.downstreamCatalog produced an incomplete preview')
        }
      }, { batchSize: 8, warmupIterations: 3 }),
      await runBenchmark('threads.search.downstreamHistory', 24, () => {
        const result = threadIndex.store.searchThreads({
          text: 'revenue',
          limit: 25,
          providerIds: ['openrouter'],
          sort: 'title_asc',
        })
        const facets = threadIndex.store.listFacets({ text: 'report' })
        if (result.threads.length !== 25 || facets.providers.length === 0) {
          throw new Error('threads.search.downstreamHistory produced incomplete results')
        }
      }, { batchSize: 3, warmupIterations: 2 }),
      await runBenchmark('launchpad.feed.syntheticScale', 24, () => {
        const feed = buildLaunchpadFeedFromSources({
          request: { limit: 50 },
          board: launchpadFeed.board as any,
          sessions: launchpadFeed.sessions as any,
          artifacts: launchpadFeed.artifacts as any,
          generatedAt: perfIso(7, 0),
        })
        if (feed.inProgress.length === 0 || feed.waitingOnYou.length === 0 || feed.freshArtifacts.length === 0) {
          throw new Error('launchpad.feed.syntheticScale produced an incomplete feed')
        }
      }, { batchSize: 6, warmupIterations: 3 }),
      await runBenchmark('artifacts.localIndex.writeScale', 18, () => {
        const entries = indexLocalSessionArtifactsFromView({
          sessionId: 'local-artifact-session',
          sessionTitle: 'Local artifact session',
          view: localArtifactIndex.view as any,
          tasks: localArtifactIndex.tasks as any,
        })
        if (entries.length !== localArtifactIndex.tasks.length) {
          throw new Error('artifacts.localIndex.writeScale lost artifact entries')
        }
      }, { batchSize: 3, warmupIterations: 2 }),
      await runBenchmark('workflows.recentRuns.batchScale', 24, () => {
        const runs = cloudStore.store.listWorkflowRunsForWorkflows({
          tenantId: cloudStore.tenantId,
          userId: cloudStore.userId,
          workflowIds: cloudStore.workflowIds,
          limitPerWorkflow: 3,
          limit: 100,
        })
        if (runs.length !== 100) {
          throw new Error('workflows.recentRuns.batchScale returned an unexpected run count')
        }
      }, { batchSize: 6, warmupIterations: 3 }),
      await runBenchmark('cloud.launchpadSummaries.queryScale', 24, () => {
        const summaries = cloudStore.store.listCloudLaunchpadSessionSummaries({
          tenantId: cloudStore.tenantId,
          userId: cloudStore.userId,
          limit: 100,
        })
        if (summaries.items.length !== 100 || !summaries.truncated) {
          throw new Error('cloud.launchpadSummaries.queryScale returned incomplete summaries')
        }
      }, { batchSize: 6, warmupIterations: 3 }),
      await runBenchmark('cloud.artifactIndex.queryScale', 24, () => {
        const artifacts = cloudStore.store.listCloudArtifactIndex({
          tenantId: cloudStore.tenantId,
          userId: cloudStore.userId,
          projectId: 'cloud-project-3',
          taskIds: ['cloud-task-3', 'cloud-task-11', 'cloud-task-19'],
          limit: 100,
        })
        if (artifacts.items.length === 0) {
          throw new Error('cloud.artifactIndex.queryScale returned no artifacts')
        }
      }, { batchSize: 6, warmupIterations: 3 }),
    ]

    return createReport(results)
  } finally {
    localArtifactIndex.close()
    threadIndex.close()
  }
}
