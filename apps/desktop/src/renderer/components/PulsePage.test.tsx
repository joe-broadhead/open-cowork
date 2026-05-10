import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BuiltInAgentDetail,
  CapabilitySkill,
  CapabilityTool,
  CustomAgentSummary,
  DashboardSummary,
  EffectiveAppSettings,
  ImprovementDiagnosticsSummary,
  ImprovementReviewQueue,
  CapabilityRiskMetadata,
  OperationalQueueAlert,
  OperationalQueueItem,
  PerfSnapshot,
  RuntimeInputDiagnostics,
  SessionInfo,
} from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { loadSessionMessages } from '../helpers/loadSessionMessages'
import { installRendererTestCoworkApi } from '../test/setup'
import { DASHBOARD_RANGE_STORAGE_KEY } from './pulse-page-support'
import { PulsePage } from './PulsePage'

vi.mock('../helpers/loadSessionMessages', () => ({
  loadSessionMessages: vi.fn(async () => undefined),
}))

const sessionTokens = {
  input: 1_000,
  output: 500,
  reasoning: 250,
  cacheRead: 125,
  cacheWrite: 125,
}

const baseSettings: EffectiveAppSettings = {
  selectedProviderId: 'openrouter',
  selectedModelId: 'gpt-4.1',
  providerCredentials: {},
  integrationCredentials: {},
  integrationEnabled: {},
  bashPermission: 'deny',
  fileWritePermission: 'deny',
  enableBash: false,
  enableFileWrite: false,
  runtimeToolingBridgeEnabled: true,
  automationLaunchAtLogin: false,
  automationRunInBackground: false,
  automationDesktopNotifications: true,
  automationQuietHoursStart: null,
  automationQuietHoursEnd: null,
  defaultAutomationAutonomyPolicy: 'review-first',
  defaultAutomationExecutionMode: 'planning_only',
  operationalMaxAutonomy: 'supervised',
  operationalWriteMaxParallel: 1,
  operationalMaxRunDurationMinutes: 120,
  operationalMaxCostUsd: null,
  operationalMaxRetries: 10,
  improvementProposalsEnabled: true,
  improvementProposalsDisabledAgents: {},
  improvementProposalsDisabledProjects: {},
  improvementProposalsDisabledCrews: {},
  effectiveProviderId: 'openrouter',
  effectiveModel: 'gpt-4.1',
}

const recentSession: SessionInfo = {
  id: 'session-recent',
  title: 'Quarterly plan',
  directory: '/tmp/acme/app',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-06T12:00:00.000Z',
}

const dashboardSummary: DashboardSummary = {
  range: {
    key: 'last7d',
    label: 'Last 7 days',
    startAt: '2026-04-30T00:00:00.000Z',
    endAt: '2026-05-07T00:00:00.000Z',
  },
  totals: {
    threads: 4,
    messages: 42,
    userMessages: 18,
    assistantMessages: 24,
    toolCalls: 7,
    taskRuns: 3,
    cost: 1.23,
    tokens: sessionTokens,
  },
  recentSessions: [
    {
      ...recentSession,
      providerId: 'openrouter',
      modelId: 'gpt-4.1',
      usage: {
        messages: 12,
        userMessages: 5,
        assistantMessages: 7,
        toolCalls: 2,
        taskRuns: 1,
        cost: 0.42,
        tokens: sessionTokens,
      },
    },
  ],
  topAgents: [
    {
      agent: 'researcher',
      taskRuns: 2,
      cost: 0.67,
      tokens: sessionTokens,
    },
  ],
  generatedAt: '2026-05-07T00:00:00.000Z',
  backfilledSessions: 1,
  backfillFailedCount: 1,
  backfillPendingCount: 2,
}

const perfSnapshot: PerfSnapshot = {
  capturedAt: '2026-05-07T00:00:00.000Z',
  counters: [
    {
      kind: 'counter',
      name: 'session.patch.published',
      value: 12,
      updatedAt: '2026-05-07T00:00:00.000Z',
    },
  ],
  distributions: [
    {
      kind: 'distribution',
      name: 'session.history.load',
      unit: 'ms',
      count: 5,
      samplesTracked: 5,
      total: 25,
      avg: 5,
      min: 2,
      max: 9,
      p50: 4,
      p95: 8,
      last: 7,
      slowCount: 1,
      updatedAt: '2026-05-07T00:00:00.000Z',
    },
    {
      kind: 'distribution',
      name: 'session.sync.cold',
      unit: 'ms',
      count: 2,
      samplesTracked: 2,
      total: 10,
      avg: 5,
      min: 4,
      max: 6,
      p50: 5,
      p95: 6,
      last: 6,
      slowCount: 0,
      updatedAt: '2026-05-07T00:00:00.000Z',
    },
  ],
}

const runtimeInputs: RuntimeInputDiagnostics = {
  opencodeVersion: '1.14.33',
  providerId: 'openrouter',
  providerName: 'OpenRouter',
  providerPackage: '@opencode-ai/provider-openrouter',
  modelId: 'gpt-4.1',
  runtimeModel: 'openrouter/gpt-4.1',
  defaultProviderId: 'openrouter',
  defaultModelId: 'gpt-4.1',
  providerSource: 'settings',
  modelSource: 'settings',
  providerOptions: {
    reasoning: 'medium',
  },
  credentialOverrideKeys: ['apiKey'],
}

const builtinAgents: BuiltInAgentDetail[] = [
  {
    name: 'build',
    label: 'Build',
    source: 'open-cowork',
    mode: 'primary',
    hidden: false,
    disabled: false,
    color: 'primary',
    description: 'Builds changes',
    instructions: 'Build',
    skills: [],
    toolAccess: [],
    nativeToolIds: [],
    configuredToolIds: [],
  },
  {
    name: 'researcher',
    label: 'Researcher',
    source: 'open-cowork',
    mode: 'subagent',
    hidden: false,
    disabled: false,
    color: 'accent',
    description: 'Researches',
    instructions: 'Research',
    skills: [],
    toolAccess: [],
    nativeToolIds: [],
    configuredToolIds: [],
  },
]

const customAgents: CustomAgentSummary[] = [
  {
    scope: 'machine',
    name: 'writer',
    description: 'Writes',
    instructions: 'Write',
    skillNames: [],
    toolIds: [],
    enabled: true,
    color: 'accent',
    writeAccess: false,
    valid: true,
    issues: [],
  },
]

const tools: CapabilityTool[] = [
  {
    id: 'tool-github',
    name: 'github',
    description: 'GitHub tools',
    kind: 'mcp',
    source: 'builtin',
    patterns: ['mcp__github__*'],
    agentNames: ['build'],
  },
  {
    id: 'tool-local',
    name: 'local-tool',
    description: 'Custom local tool',
    kind: 'mcp',
    source: 'custom',
    patterns: ['mcp__local__*'],
    agentNames: ['writer'],
  },
]

const skills: CapabilitySkill[] = [
  {
    name: 'chart-creator',
    label: 'Chart Creator',
    description: 'Builds charts',
    source: 'builtin',
    agentNames: ['build'],
  },
]

const queueAlerts: OperationalQueueAlert[] = [
  {
    schemaVersion: 1,
    queueItemId: 'queue-1',
    severity: 'critical',
    kind: 'budget_exceeded',
    message: 'Run exceeded $5.00 queue budget cap.',
    createdAt: '2026-05-07T00:00:00.000Z',
  },
]

const queueItems: OperationalQueueItem[] = [
  {
    schemaVersion: 1,
    id: 'queue-1',
    runKind: 'crew',
    runId: 'crew-run-1',
    title: 'Publish quarterly deck',
    status: 'running',
    requestedAutonomy: 'bounded-auto',
    effectiveAutonomy: 'approve',
    workspaceProfileId: 'project-workspace',
    authority: {
      schemaVersion: 1,
      filesystem: {
        mode: 'project',
        roots: ['/workspace/acme'],
        writeAllowed: true,
      },
      externalSystems: [{
        id: 'github',
        displayName: 'GitHub',
        writeAllowed: true,
        risk: 'high',
      }],
      cleanup: {
        retentionDays: 90,
        deletesUnreferencedArtifacts: false,
      },
      isolation: {
        projectBound: true,
        channelBound: false,
        highRiskIsolated: false,
      },
    },
    queueKeys: ['project:/workspace/acme', 'external_system:github'],
    caps: {
      schemaVersion: 1,
      maxParallel: 1,
      maxRunDurationMinutes: 60,
      maxCostUsd: 5,
      maxRetries: 1,
    },
    costUsd: 1.2,
    attempt: 1,
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:02.000Z',
    startedAt: '2026-05-07T00:00:01.000Z',
    finishedAt: null,
    error: null,
  },
]

const capabilityRisks: CapabilityRiskMetadata[] = [
  {
    schemaVersion: 1,
    capabilityId: 'native:bash',
    toolPattern: 'bash',
    risk: 'high',
    writeCapable: true,
    approvalRequired: true,
    reason: 'Runs shell commands.',
  },
  {
    schemaVersion: 1,
    capabilityId: 'tool:charts',
    toolPattern: 'mcp__charts__*',
    risk: 'low',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Charts are read-only.',
  },
  {
    schemaVersion: 1,
    capabilityId: 'tool:skills',
    toolPattern: 'mcp__skills__save_skill_bundle',
    risk: 'high',
    writeCapable: true,
    approvalRequired: true,
    reason: 'Skills can save bundles.',
  },
  {
    schemaVersion: 1,
    capabilityId: 'tool:skills',
    toolPattern: 'mcp__skills__delete_skill_bundle',
    risk: 'high',
    writeCapable: true,
    approvalRequired: true,
    reason: 'Skills can delete bundles.',
  },
]

const improvementSummary: ImprovementDiagnosticsSummary = {
  memory: {
    proposed: 1,
    approved: 3,
    rejected: 0,
    archived: 0,
    approvedRestrictedCount: 1,
    injection: {
      consideredCount: 3,
      returnedCount: 2,
      limit: 12,
      excludedRestrictedCount: 1,
      scopeKeys: ['machine:*'],
    },
  },
  proposals: {
    proposed: 2,
    approved: 1,
    rejected: 0,
    archived: 0,
  },
  dreamRuns: {
    running: 1,
    completed: 2,
    failed: 1,
    cancelled: 0,
    archived: 0,
  },
  policy: {
    proposalsEnabled: true,
    disabledAgentCount: 1,
    disabledProjectCount: 1,
    disabledCrewCount: 0,
  },
}

const improvementInbox: ImprovementReviewQueue = {
  memory: [
    {
      schemaVersion: 1,
      id: 'memory-1',
      scopeKind: 'machine',
      scopeId: null,
      status: 'proposed',
      title: 'Prefer concise evidence notes',
      body: 'Keep weekly reporting recommendations concise.',
      summary: 'Use concise evidence notes in weekly reporting.',
      tags: ['reporting'],
      privacy: 'internal',
      provenance: [{
        schemaVersion: 1,
        kind: 'trace',
        id: 'trace-1',
        label: 'Trace 1',
        uri: null,
        hash: 'sha256:trace-1',
      }],
      sourceProposalId: null,
      contentHash: 'sha256:memory-1',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    },
  ],
  proposals: [
    {
      schemaVersion: 1,
      id: 'proposal-1',
      targetType: 'memory',
      targetId: 'memory-1',
      status: 'proposed',
      title: 'Tighten analyst memory',
      summary: 'Candidate improvement from the latest evaluated run.',
      evidence: [{
        schemaVersion: 1,
        kind: 'eval',
        id: 'eval-1',
        label: 'Eval 1',
        uri: null,
        hash: 'sha256:eval-1',
      }],
      candidateDiffs: [{
        schemaVersion: 1,
        targetType: 'memory',
        targetId: 'memory-1',
        operation: 'update',
        summary: 'Tighten the memory wording.',
        beforeHash: 'sha256:before',
        afterHash: 'sha256:after',
        payload: { body: 'Prefer concise evidence notes.' },
      }],
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    },
  ],
  dreamRuns: [
    {
      schemaVersion: 1,
      id: 'dream-1',
      status: 'failed',
      title: 'Consolidate reporting lessons',
      modelId: 'openrouter/example',
      instructionsHash: 'sha256:instructions',
      sourceMemoryEntryIds: ['memory-1'],
      sourceTraceEventIds: ['trace-1'],
      candidateProposalIds: [],
      tokenUsage: null,
      costUsd: null,
      error: 'Provider unavailable.',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
      startedAt: '2026-05-07T00:00:00.000Z',
      finishedAt: '2026-05-07T00:00:01.000Z',
    },
  ],
}

function resetSessionStore() {
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    globalErrors: [],
    mcpConnections: [
      { name: 'github', connected: true },
      { name: 'charts', connected: true },
      { name: 'sheets', connected: false },
    ],
    agentMode: 'build',
    totalCost: 0,
    sidebarCollapsed: false,
    busySessions: new Set(['session-recent']),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
}

function installPulseApi(options: {
  dashboardSummary?: () => Promise<DashboardSummary>
  selectDirectory?: () => Promise<string | null>
  createSession?: ReturnType<typeof vi.fn>
  activateSession?: ReturnType<typeof vi.fn>
  reportRendererError?: ReturnType<typeof vi.fn>
  queueAlerts?: ReturnType<typeof vi.fn>
  improvementSummary?: ReturnType<typeof vi.fn>
  improvementInbox?: ReturnType<typeof vi.fn>
  approveProposal?: ReturnType<typeof vi.fn>
  rejectMemory?: ReturnType<typeof vi.fn>
  startDreamRun?: ReturnType<typeof vi.fn>
  archiveDreamRun?: ReturnType<typeof vi.fn>
} = {}) {
  return installRendererTestCoworkApi({
    runtime: {
      status: vi.fn(async () => ({ ready: true })),
    },
    settings: {
      get: vi.fn(async () => baseSettings),
    },
    model: {
      info: vi.fn(async () => ({
        pricing: {},
        contextLimits: {
          'openrouter/gpt-4.1': 128_000,
        },
      })),
    },
    capabilities: {
      skills: vi.fn(async () => skills),
      tools: vi.fn(async () => tools),
    },
    custom: {
      listMcps: vi.fn(async () => [{ name: 'local-mcp', type: 'stdio', command: 'node', args: [] }]),
      listSkills: vi.fn(async () => [{ name: 'custom-skill', content: 'Custom skill' }]),
    },
    app: {
      builtinAgents: vi.fn(async () => builtinAgents),
      dashboardSummary: vi.fn(options.dashboardSummary ?? (async () => dashboardSummary)),
      runtimeInputs: vi.fn(async () => runtimeInputs),
    },
    agents: {
      list: vi.fn(async () => customAgents),
    },
    diagnostics: {
      perf: vi.fn(async () => perfSnapshot),
      reportRendererError: options.reportRendererError || vi.fn(),
    },
    operations: {
      queueItems: vi.fn(async () => queueItems),
      queueAlerts: options.queueAlerts || vi.fn(async () => queueAlerts),
      capabilityRisks: vi.fn(async () => capabilityRisks),
    },
    improvements: {
      summary: options.improvementSummary || vi.fn(async () => improvementSummary),
      inbox: options.improvementInbox || vi.fn(async () => improvementInbox),
      approveMemory: vi.fn(async () => null),
      rejectMemory: options.rejectMemory || vi.fn(async () => null),
      archiveMemory: vi.fn(async () => null),
      updateProposal: vi.fn(async () => null),
      approveProposal: options.approveProposal || vi.fn(async () => null),
      rejectProposal: vi.fn(async () => null),
      archiveProposal: vi.fn(async () => null),
      startDreamRun: options.startDreamRun || vi.fn(async () => null),
      cancelDreamRun: vi.fn(async () => null),
      archiveDreamRun: options.archiveDreamRun || vi.fn(async () => null),
    },
    session: {
      create: options.createSession || vi.fn(async (directory?: string) => ({
        id: directory ? 'session-directory' : 'session-new',
        title: directory ? 'Directory thread' : 'New thread',
        directory: directory ?? null,
        createdAt: '2026-05-07T00:00:00.000Z',
        updatedAt: '2026-05-07T00:00:00.000Z',
      })),
      activate: options.activateSession || vi.fn(async () => ({
        messages: [],
        toolCalls: [],
        taskRuns: [],
        compactions: [],
        pendingApprovals: [],
        pendingQuestions: [],
        errors: [],
        todos: [],
        executionPlan: [],
        sessionCost: 0,
        sessionTokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        lastInputTokens: 0,
        contextState: 'idle',
        compactionCount: 0,
        lastCompactedAt: null,
        activeAgent: null,
        lastItemWasTool: false,
        revision: 0,
        lastEventAt: 0,
        isGenerating: false,
        isAwaitingPermission: false,
        isAwaitingQuestion: false,
      })),
    },
    dialog: {
      selectDirectory: vi.fn(options.selectDirectory ?? (async () => '/tmp/acme/app')),
    },
    on: {
      runtimeReady: vi.fn(() => vi.fn()),
      sessionPatch: vi.fn(() => vi.fn()),
      sessionUpdated: vi.fn(() => vi.fn()),
      sessionDeleted: vi.fn(() => vi.fn()),
      dashboardSummaryUpdated: vi.fn(() => vi.fn()),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSessionStore()
})

describe('PulsePage', () => {
  it('loads runtime diagnostics, dashboard totals, inventory, and recent work', async () => {
    const api = installPulseApi()

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('Openrouter / gpt-4.1')).toBeInTheDocument()
    expect(screen.getAllByText('128K tokens').length).toBeGreaterThan(0)
    expect(screen.getByText('2/3 connected')).toBeInTheDocument()
    expect(screen.getByText('2 tools · 1 skills')).toBeInTheDocument()
    expect(screen.getByText('Quarterly plan')).toBeInTheDocument()
    expect(screen.getByText(/app ·/)).toBeInTheDocument()
    expect(screen.getAllByText('Researcher').length).toBeGreaterThan(0)
    expect(screen.getByText('reasoning: medium')).toBeInTheDocument()
    expect(screen.getByText('apiKey')).toBeInTheDocument()
    expect(screen.getByText('Run exceeded $5.00 queue budget cap.')).toBeInTheDocument()
    expect(screen.getByText('Publish quarterly deck')).toBeInTheDocument()
    expect(screen.getByText(/project write · 1 external · 1 write · \/workspace\/acme/)).toBeInTheDocument()
    expect(screen.getByText('Parallel')).toBeInTheDocument()
    expect(screen.getByText('Duration')).toBeInTheDocument()
    expect(screen.getByText('Budget')).toBeInTheDocument()
    expect(screen.getByText('Retries')).toBeInTheDocument()
    expect(screen.getByText('60m')).toBeInTheDocument()
    expect(screen.getAllByText('$5.00').length).toBeGreaterThan(0)
    expect(screen.getByText(/Attempt 1/)).toBeInTheDocument()
    expect(screen.getByText(/Cost \$1.20/)).toBeInTheDocument()
    expect(screen.getByText(/project:\/workspace\/acme/)).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getAllByText('Skills')).toHaveLength(1)
    expect(screen.getByText('High risk caps').parentElement?.textContent).toContain('2')
    expect(screen.getByText('Governed improvements')).toBeInTheDocument()
    expect(screen.getByText('Tighten analyst memory')).toBeInTheDocument()
    expect(screen.getByText('Prefer concise evidence notes')).toBeInTheDocument()
    expect(screen.getByText('Consolidate reporting lessons')).toBeInTheDocument()
    expect(screen.getByText('Learning stays proposal-only: memories and dream runs can surface candidates, but approved runtime behavior changes still require review.')).toBeInTheDocument()
    expect(screen.getByText(/1 session\(s\) couldn't be reconstructed/)).toBeInTheDocument()
    expect(screen.getByText(/Still loading 2 older session\(s\)/)).toBeInTheDocument()

    expect(api.app.dashboardSummary).toHaveBeenCalledWith('last7d')
    expect(api.runtime.status).toHaveBeenCalledTimes(1)
    expect(api.diagnostics.perf).toHaveBeenCalledTimes(1)
    expect(api.operations.queueAlerts).toHaveBeenCalledTimes(1)
    expect(api.operations.queueItems).toHaveBeenCalledTimes(1)
    expect(api.operations.capabilityRisks).toHaveBeenCalledTimes(1)
    expect(api.improvements.summary).toHaveBeenCalledTimes(1)
    expect(api.improvements.inbox).toHaveBeenCalledTimes(1)
  })

  it('reviews Improvement Inbox items and refreshes diagnostics', async () => {
    const user = userEvent.setup()
    const approveProposal = vi.fn(async () => null)
    const rejectMemory = vi.fn(async () => null)
    const archiveDreamRun = vi.fn(async () => null)
    const api = installPulseApi({ approveProposal, rejectMemory, archiveDreamRun })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Tighten analyst memory')

    const approveButtons = screen.getAllByRole('button', { name: 'Approve' })
    await user.click(approveButtons[0]!)
    await waitFor(() => expect(approveProposal).toHaveBeenCalledWith('proposal-1'))
    expect(api.improvements.summary).toHaveBeenCalledTimes(2)
    expect(api.improvements.inbox).toHaveBeenCalledTimes(2)

    const rejectButtons = screen.getAllByRole('button', { name: 'Reject' })
    await user.click(rejectButtons[1]!)
    await waitFor(() => expect(rejectMemory).toHaveBeenCalledWith('memory-1'))

    await user.click(screen.getAllByRole('button', { name: 'Archive' }).at(-1)!)
    await waitFor(() => expect(archiveDreamRun).toHaveBeenCalledWith('dream-1'))
  })

  it('starts a manual dream consolidation from the learning card', async () => {
    const user = userEvent.setup()
    const startDreamRun = vi.fn(async () => null)
    installPulseApi({
      startDreamRun,
      improvementSummary: vi.fn(async () => ({
        ...improvementSummary,
        dreamRuns: {
          ...improvementSummary.dreamRuns,
          running: 0,
        },
      })),
    })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Run consolidation' }))

    await waitFor(() => expect(startDreamRun).toHaveBeenCalledTimes(1))
  })

  it('opens recent threads through the existing session-loading path', async () => {
    const user = userEvent.setup()
    const onOpenThread = vi.fn()
    installPulseApi()

    render(<PulsePage brandName="Open Cowork" onOpenThread={onOpenThread} />)
    await screen.findByText('Quarterly plan')

    await user.click(screen.getByRole('button', { name: /Quarterly plan/ }))

    expect(onOpenThread).toHaveBeenCalledTimes(1)
    expect(loadSessionMessages).toHaveBeenCalledWith('session-recent')
  })

  it('creates new threads and directory-scoped threads from the action cards', async () => {
    const user = userEvent.setup()
    const onOpenThread = vi.fn()
    const api = installPulseApi()

    render(<PulsePage brandName="Open Cowork" onOpenThread={onOpenThread} />)
    await screen.findByText('Ready')

    await user.click(screen.getByRole('button', { name: /New thread/ }))
    await waitFor(() => expect(api.session.create).toHaveBeenCalledWith(undefined))
    expect(api.session.activate).toHaveBeenCalledWith('session-new')
    expect(useSessionStore.getState().currentSessionId).toBe('session-new')

    await user.click(screen.getByRole('button', { name: /Open directory/ }))
    await waitFor(() => expect(api.dialog.selectDirectory).toHaveBeenCalledTimes(1))
    expect(api.session.create).toHaveBeenLastCalledWith('/tmp/acme/app')
    expect(api.session.activate).toHaveBeenLastCalledWith('session-directory')
    expect(useSessionStore.getState().currentSessionId).toBe('session-directory')
    expect(onOpenThread).toHaveBeenCalledTimes(2)
  })

  it('surfaces thread creation failures through the chat error channel and diagnostics', async () => {
    const user = userEvent.setup()
    const createSession = vi.fn(async () => {
      throw new Error('runtime offline')
    })
    const reportRendererError = vi.fn()
    const api = installPulseApi({ createSession, reportRendererError })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Ready')

    await user.click(screen.getByRole('button', { name: /New thread/ }))

    await waitFor(() => expect(createSession).toHaveBeenCalledWith(undefined))
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not create a thread from Pulse. Please try again.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('runtime offline'),
      view: 'pulse',
    }))
  })

  it('clears a partially selected thread when Pulse activation fails', async () => {
    const user = userEvent.setup()
    const activateSession = vi.fn(async () => {
      throw new Error('activation failed')
    })
    installPulseApi({
      activateSession,
      reportRendererError: vi.fn(() => {
        throw new Error('diagnostics unavailable')
      }),
    })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Ready')

    await user.click(screen.getByRole('button', { name: /New thread/ }))

    await waitFor(() => expect(activateSession).toHaveBeenCalledWith('session-new'))
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not create a thread from Pulse. Please try again.')
    expect(useSessionStore.getState().currentSessionId).toBeNull()
  })

  it('persists range changes and surfaces dashboard load failures', async () => {
    const user = userEvent.setup()
    const api = installPulseApi({
      dashboardSummary: vi.fn(async (range = 'last7d') => {
        if (range === 'all') throw new Error('summary unavailable')
        return dashboardSummary
      }),
    })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Ready')

    await user.click(screen.getByRole('button', { name: 'All time' }))

    await waitFor(() => expect(api.app.dashboardSummary).toHaveBeenCalledWith('all'))
    expect(window.localStorage.getItem(DASHBOARD_RANGE_STORAGE_KEY)).toBe('all')
    expect(await screen.findByText(/Dashboard totals failed to load: summary unavailable/)).toBeInTheDocument()
  })
})
