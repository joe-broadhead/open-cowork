import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionEngine } from '../../apps/desktop/src/main/session-engine.ts'
import { buildOpenCoworkAgentConfig } from '../../apps/desktop/src/main/agent-config.ts'
import { buildCoworkRuntimePermissionConfig } from '../../apps/desktop/src/main/runtime-permissions.ts'
import { ThreadIndexStore } from '../../apps/desktop/src/main/thread-index-store.ts'
import { buildCapabilityMapGroups } from '../../apps/desktop/src/renderer/components/capabilities/capabilities-page-support.ts'
import { compileAgentPreview } from '../../apps/desktop/src/renderer/components/agents/agent-builder-utils.ts'
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

export async function runSessionBenchmarks() {
  const historyFixture = createHistoryFixture()
  const downstreamCatalog = createDownstreamCatalogFixture()
  const downstreamProjectDirectory = join(tmpdir(), 'open-cowork-downstream-project')
  const threadIndex = createSeededThreadIndexStore()
  const projectedHistory = await buildProjectedHistory(historyFixture)
  const streamEvents = createStreamEvents('perf-stream')
  const hydratedEngine = new SessionEngine()
  hydratedEngine.activateSession('perf-view')
  hydratedEngine.setSessionFromHistory('perf-view', projectedHistory as any, { force: true })

  try {
    const results = [
      await runBenchmark('history.project.large', 10, async () => {
        const items = await buildProjectedHistory(historyFixture)
        if (items.length === 0) {
          throw new Error('history.project.large produced no items')
        }
      }, { batchSize: 4, warmupIterations: 3 }),
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
    ]

    return createReport(results)
  } finally {
    threadIndex.close()
  }
}
