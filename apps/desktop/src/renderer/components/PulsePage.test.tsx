import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BuiltInAgentDetail,
  CapabilitySkill,
  CapabilityTool,
  ChannelListPayload,
  CustomAgentSummary,
  DashboardSummary,
  EffectiveAppSettings,
  GovernanceAuditEvent,
  GovernanceRegistryPayload,
  ImprovementDiagnosticsSummary,
  ImprovementReviewQueue,
  CapabilityRiskMetadata,
  LocalWebhookReceiverStatus,
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
  dreamConsolidationScheduleEnabled: false,
  dreamConsolidationIntervalHours: 168,
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

const governanceRegistry: GovernanceRegistryPayload = {
  schemaVersion: 1,
  generatedAt: '2026-05-07T00:00:00.000Z',
  organization: {
    schemaVersion: 1,
    id: 'local-organization',
    tenantId: 'local',
    displayName: 'Acme Local Ops',
    mode: 'local',
  },
  principals: [{
    kind: 'user',
    id: 'local-user',
    displayName: 'Local operator',
    roles: ['admin', 'owner', 'approver'],
    groupIds: ['local-admins'],
  }],
  groups: [{
    kind: 'group',
    id: 'local-admins',
    displayName: 'Local administrators',
    roles: ['admin', 'owner', 'approver'],
  }],
  secretVaults: [
    {
      schemaVersion: 1,
      id: 'secret-vault:local-os',
      kind: 'local_os',
      label: 'Local OS credential vault',
      status: 'active',
      scope: { kind: 'machine', id: 'machine', label: 'This device', directory: null },
      storageMode: 'encrypted',
      storedSecretKinds: ['provider_credentials', 'integration_credentials', 'oauth_tokens'],
      limitations: ['Protected by this operating-system account.'],
      lastVerifiedAt: '2026-05-07T00:00:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'secret-vault:managed-external',
      kind: 'managed_external',
      label: 'Managed external secret vault',
      status: 'planned',
      scope: { kind: 'system', id: 'managed-secret-vault', label: 'Future organization vault', directory: null },
      storageMode: 'external',
      storedSecretKinds: ['provider_credentials', 'integration_credentials', 'oauth_tokens'],
      limitations: ['Roadmap integration point.'],
      lastVerifiedAt: null,
    },
  ],
  executionNodes: [
    {
      schemaVersion: 1,
      id: 'execution-node:local-desktop',
      kind: 'desktop',
      label: 'Local desktop runtime',
      status: 'active',
      scope: { kind: 'machine', id: 'machine', label: 'This device', directory: null },
      capabilities: [
        { kind: 'scheduling', label: 'Durable local scheduling', available: true, reason: null },
        { kind: 'queue_recovery', label: 'Queue recovery after app restart', available: true, reason: null },
        { kind: 'trigger_execution', label: 'Channel and manual trigger dispatch', available: true, reason: null },
        { kind: 'cost_governance', label: 'Run-level cost and token accounting', available: true, reason: null },
        { kind: 'background_execution', label: 'Execution independent of this desktop app', available: false, reason: 'Requires a future managed worker.' },
      ],
      limitations: ['Requires the desktop app to be running.'],
      lastSeenAt: '2026-05-07T00:00:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'execution-node:managed-worker',
      kind: 'managed_worker',
      label: 'Managed worker plane',
      status: 'planned',
      scope: { kind: 'system', id: 'managed-worker-plane', label: 'Future managed service plane', directory: null },
      capabilities: [
        { kind: 'background_execution', label: 'Execution independent of this desktop app', available: false, reason: 'No managed worker is registered yet.' },
      ],
      limitations: ['This node is a roadmap placeholder, not an active execution backend.'],
      lastSeenAt: null,
    },
  ],
  subjects: [
    {
      schemaVersion: 1,
      subjectKind: 'agent',
      subjectId: 'agent:system:build',
      name: 'build',
      displayName: 'Build',
      description: 'Builds changes',
      owner: { kind: 'system', id: 'open-cowork', displayName: 'Open Cowork' },
      approvers: [{ kind: 'group', id: 'local-admins', displayName: 'Local administrators' }],
      lifecycle: 'active',
      scope: { kind: 'system', id: 'runtime', label: 'Runtime', directory: null },
      memoryBoundary: { kind: 'session', id: 'build', label: 'Session context' },
      evalSuiteId: null,
      offboardingPath: 'Disable through config.',
      credentialBindings: [],
      dependencies: [{
        kind: 'tool',
        id: 'tool-github',
        label: 'GitHub',
        source: 'direct',
        required: true,
      }],
      incidentControls: [],
    },
    {
      schemaVersion: 1,
      subjectKind: 'crew',
      subjectId: 'crew:research',
      name: 'research',
      displayName: 'Research crew',
      description: 'Runs research jobs',
      owner: { kind: 'user', id: 'local-user', displayName: 'Local operator' },
      approvers: [{ kind: 'group', id: 'local-admins', displayName: 'Local administrators' }],
      lifecycle: 'active',
      scope: { kind: 'workspace_profile', id: 'workspace:research', label: 'Research workspace', directory: null },
      memoryBoundary: { kind: 'crew', id: 'research', label: 'Crew traces and evals' },
      evalSuiteId: 'eval-suite-analytics',
      offboardingPath: 'Pause or retire the crew.',
      credentialBindings: [],
      dependencies: [{
        kind: 'eval_suite',
        id: 'eval-suite-analytics',
        label: 'Analytics certification',
        source: 'direct',
        required: true,
        lifecycle: 'active',
      }],
      incidentControls: [
        {
          kind: 'pause_crew',
          label: 'Pause crew',
          available: true,
          requiresConfirmation: true,
          requiredRoles: ['admin', 'owner', 'approver'],
          reason: null,
        },
        {
          kind: 'export_audit',
          label: 'Export crew run trace',
          available: true,
          requiresConfirmation: false,
          requiredRoles: ['admin', 'approver', 'viewer'],
          reason: null,
        },
      ],
    },
  ],
  dependencyIndex: [
    {
      dependency: {
        kind: 'tool',
        id: 'tool-github',
        label: 'GitHub',
        source: 'direct',
        required: true,
      },
      subjectIds: ['agent:system:build'],
    },
    {
      dependency: {
        kind: 'credential',
        id: 'integration:github',
        label: 'GitHub integration credentials',
        source: 'direct',
        required: true,
      },
      subjectIds: ['agent:system:build'],
    },
    {
      dependency: {
        kind: 'eval_suite',
        id: 'eval-suite-analytics',
        label: 'Analytics certification',
        source: 'direct',
        required: true,
        lifecycle: 'active',
      },
      subjectIds: ['crew:research'],
    },
    {
      dependency: {
        kind: 'channel',
        id: 'channel-ops',
        label: 'Ops webhook',
        source: 'direct',
        required: true,
      },
      subjectIds: ['crew:research'],
    },
    {
      dependency: {
        kind: 'memory',
        id: 'memory:memory-analyst',
        label: 'Analyst memory',
        source: 'direct',
        required: true,
        lifecycle: 'approved',
      },
      subjectIds: ['agent:system:build'],
    },
  ],
}

const governanceAuditEvents: GovernanceAuditEvent[] = [
  {
    schemaVersion: 1,
    id: 'audit-1',
    kind: 'incident_control',
    subjectKind: 'crew',
    subjectId: 'crew:research',
    action: 'pause_crew',
    outcome: 'succeeded',
    actor: { kind: 'user', id: 'local-user', displayName: 'Local operator' },
    reason: 'Ops freeze while the certification gate is refreshed.',
    beforeLifecycle: 'active',
    afterLifecycle: 'paused',
    metadata: {},
    createdAt: '2026-05-07T00:05:00.000Z',
  },
]

const channelState: ChannelListPayload = {
  channels: [
    {
      schemaVersion: 1,
      id: 'channel-ops',
      provider: 'local_webhook',
      name: 'Ops webhook',
      description: 'Routes trusted operational messages.',
      sourceKey: 'ops',
      enabled: true,
      senderAllowlist: ['ops@example.com'],
      allowedCapabilityIds: ['skill:chart-creator'],
      route: {
        schemaVersion: 1,
        activationMode: 'run_sop',
        targetSopId: 'sop-weekly-digest',
        targetCrewId: null,
      },
      workspaceProfileId: 'channel-sandbox',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'channel-triage',
      provider: 'email',
      name: 'Triage inbox',
      description: null,
      sourceKey: 'triage',
      enabled: false,
      senderAllowlist: ['triage@example.com'],
      allowedCapabilityIds: [],
      route: {
        schemaVersion: 1,
        activationMode: 'draft_reply',
        targetSopId: null,
        targetCrewId: null,
      },
      workspaceProfileId: 'default',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
    },
  ],
  inboundItems: [
    {
      schemaVersion: 1,
      id: 'channel-item-1',
      channelId: 'channel-ops',
      provider: 'local_webhook',
      source: {
        schemaVersion: 1,
        provider: 'local_webhook',
        sourceKey: 'ops',
        externalMessageId: 'msg-1',
        replyTarget: 'https://callback.example/hooks/open-cowork',
      },
      sender: 'ops@example.com',
      subject: 'Weekly support digest',
      body: 'Summarize support pressure.',
      route: {
        schemaVersion: 1,
        activationMode: 'run_sop',
        targetSopId: 'sop-weekly-digest',
        targetCrewId: null,
      },
      status: 'queued',
      auditState: 'queued_for_review',
      allowedCapabilityIds: ['skill:chart-creator'],
      workspaceProfileId: 'channel-sandbox',
      queueItemId: 'queue-channel-1',
      deliveryRecordId: 'delivery-1',
      workItemId: null,
      runKind: null,
      runId: null,
      runStatus: null,
      approvedAt: null,
      approvedBy: null,
      reviewNote: null,
      receivedAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:01.000Z',
      error: null,
    },
    {
      schemaVersion: 1,
      id: 'channel-item-2',
      channelId: 'channel-ops',
      provider: 'local_webhook',
      source: {
        schemaVersion: 1,
        provider: 'local_webhook',
        sourceKey: 'ops',
        externalMessageId: 'msg-2',
        replyTarget: null,
      },
      sender: 'unknown@example.net',
      subject: 'Untrusted sender',
      body: 'Should be blocked.',
      route: {
        schemaVersion: 1,
        activationMode: 'ignore',
        targetSopId: null,
        targetCrewId: null,
      },
      status: 'denied',
      auditState: 'denied_unknown_sender',
      allowedCapabilityIds: [],
      workspaceProfileId: 'channel-sandbox',
      queueItemId: null,
      deliveryRecordId: null,
      workItemId: null,
      runKind: null,
      runId: null,
      runStatus: null,
      approvedAt: null,
      approvedBy: null,
      reviewNote: null,
      receivedAt: '2026-05-07T00:01:00.000Z',
      updatedAt: '2026-05-07T00:01:00.000Z',
      error: null,
    },
  ],
  deliveries: [
    {
      schemaVersion: 1,
      id: 'delivery-1',
      channelId: 'channel-ops',
      inboundItemId: 'channel-item-1',
      provider: 'slack',
      target: '#ops',
      status: 'draft',
      title: 'Slack digest draft',
      body: 'Draft support digest.',
      draftFirst: true,
      workItemId: 'work-1',
      runKind: 'sop',
      runId: 'sop-run-1',
      artifactIds: [],
      policyDecisionIds: [],
      approvalIds: [],
      createdAt: '2026-05-07T00:02:00.000Z',
      updatedAt: '2026-05-07T00:02:00.000Z',
      error: null,
    },
  ],
}

const localWebhookStatus: LocalWebhookReceiverStatus = {
  schemaVersion: 1,
  enabled: true,
  listening: true,
  host: '127.0.0.1',
  port: 64200,
  url: 'http://127.0.0.1:64200',
  pairedChannels: 1,
  lastError: null,
}

const improvementSummary: ImprovementDiagnosticsSummary = {
  memory: {
    proposed: 1,
    approved: 3,
    rejected: 0,
    archived: 0,
    quarantined: 0,
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
  updateProposal?: ReturnType<typeof vi.fn>
  approveProposal?: ReturnType<typeof vi.fn>
  rejectMemory?: ReturnType<typeof vi.fn>
  startDreamRun?: ReturnType<typeof vi.fn>
  archiveDreamRun?: ReturnType<typeof vi.fn>
  governanceRegistry?: ReturnType<typeof vi.fn>
  governanceAuditEvents?: ReturnType<typeof vi.fn>
  exportGovernanceAudit?: ReturnType<typeof vi.fn>
  pauseCrew?: ReturnType<typeof vi.fn>
  retireCrew?: ReturnType<typeof vi.fn>
  pauseAgent?: ReturnType<typeof vi.fn>
  retireAgent?: ReturnType<typeof vi.fn>
  quarantineMemory?: ReturnType<typeof vi.fn>
  revokeTool?: ReturnType<typeof vi.fn>
  channelState?: ChannelListPayload
  localWebhookStatus?: LocalWebhookReceiverStatus
  approveInboundItem?: ReturnType<typeof vi.fn>
  dismissInboundItem?: ReturnType<typeof vi.fn>
  createDeliveryDraft?: ReturnType<typeof vi.fn>
  sendDelivery?: ReturnType<typeof vi.fn>
  cancelDelivery?: ReturnType<typeof vi.fn>
} = {}) {
  const testChannelState = options.channelState ?? channelState
  const testLocalWebhookStatus = options.localWebhookStatus ?? localWebhookStatus
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
      governanceRegistry: options.governanceRegistry || vi.fn(async () => governanceRegistry),
      governanceAuditEvents: options.governanceAuditEvents || vi.fn(async () => governanceAuditEvents),
      exportGovernanceAudit: options.exportGovernanceAudit || vi.fn(async () => ({
        schemaVersion: 2,
        format: 'ndjson',
        contentType: 'application/x-ndjson',
        filename: 'open-cowork-governance-audit.ndjson',
        exportedAt: '2026-05-07T00:00:00.000Z',
        eventCount: 1,
        body: '{"recordType":"governance_incident"}',
      })),
      pauseCrew: options.pauseCrew || vi.fn(async () => null),
      retireCrew: options.retireCrew || vi.fn(async () => null),
      pauseAgent: options.pauseAgent || vi.fn(async () => true),
      retireAgent: options.retireAgent || vi.fn(async () => true),
      quarantineMemory: options.quarantineMemory || vi.fn(async () => null),
      revokeTool: options.revokeTool || vi.fn(async () => null),
    },
    channels: {
      list: vi.fn(async () => testChannelState),
      definitions: vi.fn(async () => testChannelState.channels),
      inboundItems: vi.fn(async () => testChannelState.inboundItems),
      deliveries: vi.fn(async () => testChannelState.deliveries),
      localWebhookStatus: vi.fn(async () => testLocalWebhookStatus),
      localWebhookPairings: vi.fn(async () => []),
      createLocalWebhook: vi.fn(),
      rotateLocalWebhookToken: vi.fn(async () => null),
      approveInboundItem: options.approveInboundItem || vi.fn(async () => null),
      dismissInboundItem: options.dismissInboundItem || vi.fn(async () => null),
      createDeliveryDraft: options.createDeliveryDraft || vi.fn(async () => null),
      sendDelivery: options.sendDelivery || vi.fn(async () => null),
      cancelDelivery: options.cancelDelivery || vi.fn(async () => null),
    },
    improvements: {
      summary: options.improvementSummary || vi.fn(async () => improvementSummary),
      inbox: options.improvementInbox || vi.fn(async () => improvementInbox),
      approveMemory: vi.fn(async () => null),
      rejectMemory: options.rejectMemory || vi.fn(async () => null),
      archiveMemory: vi.fn(async () => null),
      updateProposal: options.updateProposal || vi.fn(async () => null),
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
    expect(screen.getByText('Governance map')).toBeInTheDocument()
    expect(screen.getByText('Acme Local Ops')).toBeInTheDocument()
    expect(screen.getByText(/1 principal · 1 group/)).toBeInTheDocument()
    expect(screen.getByText('Vaults').parentElement?.textContent).toContain('1/2')
    expect(screen.getByText('Nodes').parentElement?.textContent).toContain('1/2')
    expect(screen.getByText('Credentials · 1')).toBeInTheDocument()
    expect(screen.getByText('Channels · 1')).toBeInTheDocument()
    expect(screen.getByText('Eval gates · 1')).toBeInTheDocument()
    expect(screen.getByText('Memory · 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Governance dependency map')).toBeInTheDocument()
    expect(screen.getByText('GitHub integration credentials')).toBeInTheDocument()
    expect(screen.getByText('Ops webhook')).toBeInTheDocument()
    expect(screen.getByText('Analytics certification')).toBeInTheDocument()
    expect(screen.getByText('Analyst memory')).toBeInTheDocument()
    expect(screen.getAllByText('Agent · Build').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Crew · Research crew').length).toBeGreaterThan(0)
    expect(screen.getByText('Background workers planned')).toBeInTheDocument()
    expect(screen.getByText('Local vault active')).toBeInTheDocument()
    expect(screen.getByText('Recent governance incidents')).toBeInTheDocument()
    expect(screen.getByText('Pause Crew')).toBeInTheDocument()
    expect(screen.getByText(/Ops freeze while the certification gate is refreshed/)).toBeInTheDocument()
    expect(screen.getByText('Channel inbox and delivery')).toBeInTheDocument()
    expect(screen.getByText('Ops webhook · SOP')).toBeInTheDocument()
    expect(screen.getByText('Weekly support digest')).toBeInTheDocument()
    expect(screen.getByText(/unknown@example\.net/)).toBeInTheDocument()
    expect(screen.getByText('Slack digest draft')).toBeInTheDocument()
    expect(screen.getByText('Listening')).toBeInTheDocument()
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
    expect(api.operations.governanceRegistry).toHaveBeenCalledTimes(1)
    expect(api.operations.governanceAuditEvents).toHaveBeenCalledWith({ limit: 5 })
    expect(api.channels.list).toHaveBeenCalledTimes(1)
    expect(api.channels.localWebhookStatus).toHaveBeenCalledTimes(1)
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

  it('approves and dismisses channel review items from Pulse', async () => {
    const user = userEvent.setup()
    const approveInboundItem = vi.fn(async () => null)
    const dismissInboundItem = vi.fn(async () => null)
    const api = installPulseApi({ approveInboundItem, dismissInboundItem })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Weekly support digest')

    await user.click(screen.getByRole('button', { name: 'Approve run' }))
    await waitFor(() => expect(approveInboundItem).toHaveBeenCalledWith('channel-item-1'))
    expect(api.channels.list).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(dismissInboundItem).toHaveBeenCalledWith('channel-item-1', 'Dismissed from Pulse.'))
  })

  it('copies governance audit exports from Pulse', async () => {
    const user = userEvent.setup()
    const exportGovernanceAudit = vi.fn(async ({ format }: { format: 'ndjson' | 'otel-json' }) => ({
      schemaVersion: 2,
      format,
      contentType: format === 'otel-json' ? 'application/json' : 'application/x-ndjson',
      filename: format === 'otel-json'
        ? 'open-cowork-governance-audit.otel.json'
        : 'open-cowork-governance-audit.ndjson',
      exportedAt: '2026-05-07T00:00:00.000Z',
      eventCount: 1,
      body: format === 'otel-json'
        ? '{"resourceLogs":[]}'
        : '{"recordType":"governance_incident"}',
    }))
    const api = installPulseApi({ exportGovernanceAudit })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Governance map')

    await user.click(screen.getByRole('button', { name: 'Copy audit NDJSON' }))
    await waitFor(() => expect(exportGovernanceAudit).toHaveBeenCalledWith({ format: 'ndjson' }))
    expect(api.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('governance_incident'))
    expect(await screen.findByText('Copied')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy OTel JSON' }))
    await waitFor(() => expect(exportGovernanceAudit).toHaveBeenCalledWith({ format: 'otel-json' }))
    expect(api.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('resourceLogs'))
  })

  it('runs governance incident controls from Pulse and refreshes the registry', async () => {
    const user = userEvent.setup()
    const pauseCrew = vi.fn(async () => null)
    const governanceRegistryMock = vi.fn(async () => governanceRegistry)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const api = installPulseApi({
      pauseCrew,
      governanceRegistry: governanceRegistryMock,
    })

    try {
      render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
      await screen.findByText('Governance incident controls')

      await user.click(screen.getByRole('button', { name: 'Pause crew' }))

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Research crew'))
      await waitFor(() => expect(pauseCrew).toHaveBeenCalledWith({
        crewId: 'research',
        reason: 'Triggered from Pulse governance operations.',
      }))
      expect(api.operations.governanceRegistry).toHaveBeenCalledTimes(2)
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('reviews channel delivery drafts from Pulse', async () => {
    const user = userEvent.setup()
    const sendDelivery = vi.fn(async () => null)
    const cancelDelivery = vi.fn(async () => null)
    const api = installPulseApi({
      sendDelivery,
      cancelDelivery,
      channelState: {
        ...channelState,
        deliveries: [{
          ...channelState.deliveries[0]!,
          provider: 'webhook',
          target: 'https://callback.example/hooks/open-cowork',
        }],
      },
    })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Slack digest draft')

    await user.click(screen.getByRole('button', { name: 'Send webhook' }))
    await waitFor(() => expect(sendDelivery).toHaveBeenCalledWith('delivery-1'))
    expect(api.channels.list).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Cancel draft' }))
    await waitFor(() => expect(cancelDelivery).toHaveBeenCalledWith('delivery-1', 'Cancelled from Pulse.'))
  })

  it('creates channel delivery drafts for dispatched runs from Pulse', async () => {
    const user = userEvent.setup()
    const createDeliveryDraft = vi.fn(async () => null)
    const dispatchedItem = {
      ...channelState.inboundItems[0]!,
      status: 'dispatched' as const,
      auditState: 'execution_dispatched' as const,
      runKind: 'sop' as const,
      runId: 'automation-run-1',
      runStatus: 'completed' as const,
      deliveryRecordId: null,
      approvedAt: '2026-05-07T00:03:00.000Z',
      approvedBy: 'local-user',
    }
    const api = installPulseApi({
      createDeliveryDraft,
      channelState: {
        ...channelState,
        inboundItems: [dispatchedItem],
        deliveries: [],
      },
    })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Weekly support digest')

    await user.click(screen.getByRole('button', { name: 'Draft delivery' }))
    await waitFor(() => expect(createDeliveryDraft).toHaveBeenCalledWith('channel-item-1'))
    expect(api.channels.list).toHaveBeenCalledTimes(2)
  })

  it('waits for dispatched channel runs to complete before showing delivery draft actions', async () => {
    const createDeliveryDraft = vi.fn(async () => null)
    const dispatchedItem = {
      ...channelState.inboundItems[0]!,
      status: 'dispatched' as const,
      auditState: 'execution_dispatched' as const,
      runKind: 'sop' as const,
      runId: 'automation-run-1',
      runStatus: 'running' as const,
      deliveryRecordId: null,
      approvedAt: '2026-05-07T00:03:00.000Z',
      approvedBy: 'local-user',
    }
    installPulseApi({
      createDeliveryDraft,
      channelState: {
        ...channelState,
        inboundItems: [dispatchedItem],
        deliveries: [],
      },
    })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Weekly support digest')

    expect(screen.queryByRole('button', { name: 'Draft delivery' })).toBeNull()
    expect(createDeliveryDraft).not.toHaveBeenCalled()
  })

  it('updates Improvement Inbox proposals and refreshes diagnostics', async () => {
    const user = userEvent.setup()
    const updateProposal = vi.fn(async () => null)
    const api = installPulseApi({ updateProposal })

    render(<PulsePage brandName="Open Cowork" onOpenThread={vi.fn()} />)
    await screen.findByText('Tighten analyst memory')

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Proposal summary'))
    await user.type(screen.getByLabelText('Proposal summary'), 'Edited proposal summary.')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateProposal).toHaveBeenCalledWith('proposal-1', expect.objectContaining({
      summary: 'Edited proposal summary.',
    })))
    expect(api.improvements.summary).toHaveBeenCalledTimes(2)
    expect(api.improvements.inbox).toHaveBeenCalledTimes(2)
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
