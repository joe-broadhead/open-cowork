import { describe, expect, it } from 'vitest'
import type {
  AutomationListPayload,
  AutomationSummary,
  CapabilitySkill,
  CapabilityTool,
  CrewListItem,
  CustomAgentSummary,
} from '@open-cowork/shared'
import {
  FLEET_REGISTRY_FEATURE_GATE_KEY,
  buildAgentRegistryItems,
  buildAutomationRegistryItems,
  buildCapabilityRegistryItems,
  buildCrewRegistryItems,
  filterFleetRegistryItems,
  isFleetRegistryViewsEnabled,
  readFleetRegistryPreference,
  shouldDefaultFleetRegistryToTable,
  sortFleetRegistryItems,
  writeFleetRegistryPreference,
} from './fleet-registry-model'

const customAgent: CustomAgentSummary = {
  scope: 'project',
  directory: '/work/project',
  name: 'market-analyst',
  description: 'Prepares market analysis.',
  instructions: 'Use research evidence.',
  skillNames: ['research'],
  toolIds: ['charts'],
  enabled: true,
  color: 'accent',
  avatar: null,
  model: 'openai/gpt-5.2',
  variant: null,
  temperature: null,
  top_p: null,
  steps: null,
  options: null,
  deniedToolPatterns: [],
  writeAccess: true,
  valid: true,
  issues: [],
}

function automation(overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return {
    id: overrides.id || 'auto-1',
    title: overrides.title || 'Weekly report',
    goal: overrides.goal || 'Prepare a report.',
    kind: overrides.kind || 'recurring',
    status: overrides.status || 'ready',
    schedule: overrides.schedule || {
      type: 'weekly',
      timezone: 'UTC',
      dayOfWeek: 1,
      runAtHour: 9,
      runAtMinute: 0,
    },
    heartbeatMinutes: overrides.heartbeatMinutes ?? 15,
    retryPolicy: overrides.retryPolicy || { maxRetries: 3, baseDelayMinutes: 5, maxDelayMinutes: 60 },
    runPolicy: overrides.runPolicy || { dailyRunCap: 6, maxRunDurationMinutes: 120 },
    executionMode: overrides.executionMode || 'planning_only',
    autonomyPolicy: overrides.autonomyPolicy || 'review-first',
    projectDirectory: overrides.projectDirectory ?? '/work/project',
    preferredAgentNames: overrides.preferredAgentNames || ['market-analyst'],
    createdAt: overrides.createdAt || '2026-05-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-05-01T01:00:00.000Z',
    nextRunAt: overrides.nextRunAt ?? null,
    lastRunAt: overrides.lastRunAt ?? null,
    nextHeartbeatAt: overrides.nextHeartbeatAt ?? null,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    latestRunStatus: overrides.latestRunStatus ?? null,
    latestRunId: overrides.latestRunId ?? null,
  }
}

describe('fleet registry model', () => {
  it('keeps the feature gate default-off and persists table preferences', () => {
    expect(isFleetRegistryViewsEnabled()).toBe(false)
    window.localStorage.setItem(FLEET_REGISTRY_FEATURE_GATE_KEY, 'true')
    expect(isFleetRegistryViewsEnabled()).toBe(true)
    expect(isFleetRegistryViewsEnabled({
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
    } as unknown as Storage)).toBe(false)

    writeFleetRegistryPreference('agents', {
      viewMode: 'table',
      quickFilter: 'custom_only',
      sort: { key: 'status', direction: 'desc' },
    })

    expect(readFleetRegistryPreference('agents')).toEqual({
      viewMode: 'table',
      quickFilter: 'custom_only',
      sort: { key: 'status', direction: 'desc' },
    })
  })

  it('normalizes agents into searchable registry rows with disabled unsupported bulk actions', () => {
    const items = buildAgentRegistryItems({
      customAgents: [customAgent],
      builtInAgents: [],
      runtimeAgents: [{ name: 'runtime-helper', description: 'Plugin helper', disabled: true, toolIds: ['web'] }],
    })

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      kind: 'agent',
      name: 'market-analyst',
      source: 'Custom project',
      status: 'active',
      provider: 'openai',
      capabilitiesCount: 2,
    })
    expect(filterFleetRegistryItems(items, { query: 'research' }).map((item) => item.name)).toEqual(['market-analyst'])
    expect(filterFleetRegistryItems(items, { quickFilter: 'builtin_runtime' }).map((item) => item.name)).toEqual(['runtime-helper'])
    expect(items[0]?.bulkActions.find((action) => action.kind === 'tag')).toMatchObject({
      supported: false,
      disabledReason: expect.stringContaining('not persisted'),
    })
  })

  it('normalizes crew lifecycle and table threshold defaults', () => {
    const crew: CrewListItem = {
      definition: {
        schemaVersion: 1,
        id: 'crew-1',
        name: 'Operations Crew',
        description: 'Runs supervised work.',
        status: 'review',
        activeVersionId: 'version-1',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T01:00:00.000Z',
      },
      activeVersion: {
        schemaVersion: 1,
        id: 'version-1',
        crewId: 'crew-1',
        version: 2,
        members: [
          { schemaVersion: 1, id: 'lead', role: 'lead', agentName: 'plan', displayName: 'Planner', description: 'Plans', required: true },
        ],
        workspaceProfileId: null,
        outcomeRubricId: null,
        evalSuiteId: null,
        certificationStatus: 'required',
        certifiedAt: null,
        budgetCapUsd: 3,
        workflow: ['plan'],
        createdAt: '2026-05-01T01:00:00.000Z',
        createdBy: null,
      },
      latestRun: {
        schemaVersion: 1,
        id: 'run-1',
        crewId: 'crew-1',
        crewVersionId: 'version-1',
        workItemId: null,
        status: 'blocked',
        title: 'Review run',
        summary: null,
        rootSessionId: null,
        createdAt: '2026-05-01T02:00:00.000Z',
        startedAt: '2026-05-01T02:01:00.000Z',
        finishedAt: null,
      },
    }

    const items = buildCrewRegistryItems([crew])
    expect(items[0]).toMatchObject({
      status: 'waiting_review',
      activeRuns: 1,
      reviewBacklog: 1,
      capabilitiesCount: 1,
    })
    expect(shouldDefaultFleetRegistryToTable(23)).toBe(false)
    expect(shouldDefaultFleetRegistryToTable(24)).toBe(true)
  })

  it('normalizes automations with supported pause/resume/archive gates', () => {
    const payload: AutomationListPayload = {
      automations: [
        automation({ id: 'ready', title: 'Ready automation', status: 'ready' }),
        automation({ id: 'paused', title: 'Paused automation', status: 'paused' }),
        automation({ id: 'completed', title: 'Completed automation', status: 'completed', lastRunAt: '2026-05-02T00:00:00.000Z' }),
        automation({ id: 'never-run', title: 'Never run automation', status: 'draft' }),
      ],
      inbox: [{
        id: 'inbox-1',
        automationId: 'ready',
        runId: null,
        sessionId: null,
        questionId: null,
        type: 'approval',
        status: 'open',
        title: 'Approve',
        body: 'Approve this run.',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }],
      workItems: [],
      runs: [{
        id: 'run-1',
        automationId: 'ready',
        sessionId: null,
        kind: 'execution',
        status: 'failed',
        title: 'Failed run',
        summary: null,
        error: 'Provider failed',
        failureCode: null,
        attempt: 1,
        retryOfRunId: null,
        nextRetryAt: null,
        createdAt: '2026-05-01T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
      }],
      deliveries: [],
    }

    const items = buildAutomationRegistryItems(payload)
    expect(filterFleetRegistryItems(items, { quickFilter: 'waiting_review' }).map((item) => item.id)).toEqual(['ready'])
    expect(items.find((item) => item.id === 'ready')?.bulkActions.find((action) => action.kind === 'pause')).toMatchObject({ supported: true })
    expect(items.find((item) => item.id === 'ready')?.bulkActions.find((action) => action.kind === 'archive')).toMatchObject({ supported: false })
    expect(items.find((item) => item.id === 'paused')?.bulkActions.find((action) => action.kind === 'resume')).toMatchObject({ supported: true })
    expect(items.find((item) => item.id === 'completed')?.bulkActions.find((action) => action.kind === 'archive')).toMatchObject({ supported: true })
    expect(filterFleetRegistryItems(items, { quickFilter: 'unused' }).map((item) => item.id)).toEqual(['paused', 'never-run'])
  })

  it('normalizes capability dependency rows and sorts by activity/capability counts', () => {
    const tool: CapabilityTool = {
      id: 'charts',
      name: 'Chart MCP',
      description: 'Creates charts.',
      kind: 'mcp',
      source: 'custom',
      origin: 'custom',
      scope: 'project',
      namespace: 'charts',
      patterns: ['mcp__charts__*'],
      availableTools: [{ id: 'mcp__charts__bar', description: 'Bar chart' }],
      agentNames: ['chart-agent'],
      authMode: 'api_token',
      enabled: false,
    }
    const skill: CapabilitySkill = {
      name: 'research',
      label: 'Research',
      description: 'Finds evidence.',
      source: 'builtin',
      origin: 'open-cowork',
      scope: 'project',
      toolIds: ['charts'],
      agentNames: ['research-agent'],
    }

    const items = buildCapabilityRegistryItems({
      tools: [tool],
      skills: [skill],
      runtimeTools: [{ id: 'mcp__charts__line', description: 'Line chart' }],
    })

    expect(items.find((item) => item.name === 'Chart MCP')).toMatchObject({
      status: 'blocked',
      approvalBacklog: 1,
      toolsCount: 1,
      skillsCount: 1,
    })
    expect(filterFleetRegistryItems(items, { quickFilter: 'missing_credentials' }).map((item) => item.name)).toEqual(['Chart MCP'])
    expect(items[0]?.bulkActions.find((action) => action.kind === 'open_dependency')).toMatchObject({
      supported: true,
      selection: 'single',
    })
    expect(sortFleetRegistryItems(items, { key: 'capabilities', direction: 'desc' })[0]?.name).toBe('Chart MCP')
  })
})
