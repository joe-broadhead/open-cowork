import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  AgentCatalog,
  BuiltInAgentDetail,
  ChannelDefinition,
  CrewListPayload,
  CustomAgentSummary,
  SopListPayload,
} from '@open-cowork/shared'
import {
  buildGovernanceRegistry,
  buildGovernanceToolCredentialDependencies,
} from '../apps/desktop/src/main/governance-registry.ts'

const generatedAt = '2026-05-11T12:00:00.000Z'

function catalog(): AgentCatalog {
  return {
    tools: [
      {
        id: 'charts',
        name: 'Charts',
        icon: 'bar-chart',
        description: 'Create charts.',
        supportsWrite: false,
        source: 'builtin',
        patterns: ['mcp__charts__*'],
      },
      {
        id: 'filesystem',
        name: 'Filesystem',
        icon: 'folder',
        description: 'Read and write project files.',
        supportsWrite: true,
        source: 'builtin',
        patterns: ['write', 'edit'],
      },
    ],
    skills: [
      {
        name: 'analyst',
        label: 'Analyst',
        description: 'Analyze metrics.',
        source: 'custom',
        origin: 'custom',
        scope: 'project',
        location: '/workspace/acme/.opencode/skill/analyst',
        toolIds: ['charts'],
      },
    ],
    reservedNames: ['build', 'plan'],
    colors: ['primary', 'accent', 'success', 'warning', 'info', 'secondary'],
  }
}

function builtInAgent(overrides: Partial<BuiltInAgentDetail> = {}): BuiltInAgentDetail {
  return {
    name: 'build',
    label: 'Build',
    source: 'opencode',
    mode: 'primary',
    surface: 'chat',
    hidden: false,
    disabled: false,
    color: 'primary',
    description: 'Default builder.',
    instructions: '',
    skills: [],
    toolAccess: ['Filesystem'],
    nativeToolIds: ['filesystem'],
    configuredToolIds: [],
    ...overrides,
  }
}

function customAgent(overrides: Partial<CustomAgentSummary> = {}): CustomAgentSummary {
  return {
    scope: 'project',
    directory: '/workspace/acme',
    name: 'data-analyst',
    description: 'Analyzes business metrics.',
    instructions: 'Use the analyst skill.',
    skillNames: ['analyst'],
    toolIds: ['filesystem'],
    enabled: true,
    color: 'accent',
    writeAccess: true,
    valid: true,
    issues: [],
    ...overrides,
  }
}

function crewCatalog(overrides: Partial<CrewListPayload['crews'][number]> = {}): CrewListPayload {
  return {
    crews: [
      {
        definition: {
          schemaVersion: 1,
          id: 'crew-analytics',
          name: 'Analytics crew',
          description: 'Handles weekly analytics.',
          status: 'active',
          activeVersionId: 'crew-version-1',
          createdAt: generatedAt,
          updatedAt: generatedAt,
        },
        activeVersion: {
          schemaVersion: 1,
          id: 'crew-version-1',
          crewId: 'crew-analytics',
          version: 1,
          members: [
            {
              schemaVersion: 1,
              id: 'member-1',
              role: 'lead',
              agentName: 'data-analyst',
              displayName: 'Data Analyst',
              description: 'Analyze the metrics.',
              required: true,
            },
          ],
          workspaceProfileId: 'project-workspace',
          outcomeRubricId: null,
          evalSuiteId: 'eval-suite-analytics',
          certificationStatus: 'required',
          certifiedAt: null,
          budgetCapUsd: 5,
          workflow: ['plan', 'delegate', 'join', 'evaluate', 'deliver'],
          createdAt: generatedAt,
          createdBy: 'local-user',
        },
        latestRun: null,
        ...overrides,
      },
    ],
  }
}

function sopCatalog(agentName = 'data-analyst'): SopListPayload {
  return {
    sops: [
      {
        definition: {
          schemaVersion: 1,
          id: 'sop-weekly-report',
          name: 'Weekly report SOP',
          description: 'Prepare weekly analytics.',
          status: 'active',
          activeVersionId: 'sop-version-1',
          sourceAutomationId: null,
          createdAt: generatedAt,
          updatedAt: generatedAt,
        },
        activeVersion: {
          schemaVersion: 1,
          id: 'sop-version-1',
          sopId: 'sop-weekly-report',
          version: 1,
          sourceAutomationId: null,
          sourceRunId: null,
          triggerTypes: ['manual', 'webhook'],
          requiredInputs: [],
          workflow: [
            {
              schemaVersion: 1,
              id: 'execute',
              kind: 'execute',
              title: 'Analyze the numbers',
              agentName,
              approvalRequired: true,
            },
          ],
          approvalPolicy: {
            schemaVersion: 1,
            reviewFirst: true,
            approvalBoundary: 'Review before delivery.',
          },
          retryPolicy: {
            maxRetries: 2,
            baseDelayMinutes: 1,
            maxDelayMinutes: 5,
          },
          runPolicy: {
            maxRunDurationMinutes: 30,
            dailyRunCap: 5,
          },
          deliveryPolicy: {
            schemaVersion: 1,
            provider: 'in_app',
            target: 'automation-inbox',
            draftFirst: true,
          },
          outcomeRubricId: 'rubric-weekly-report',
          createdAt: generatedAt,
          createdBy: 'local-user',
        },
      },
    ],
  }
}

function channel(overrides: Partial<ChannelDefinition> = {}): ChannelDefinition {
  return {
    schemaVersion: 1,
    id: 'channel-analytics',
    provider: 'local_webhook',
    name: 'Analytics webhook',
    description: 'Inbound analytics requests.',
    sourceKey: 'analytics',
    enabled: true,
    senderAllowlist: ['ops@example.com'],
    allowedCapabilityIds: ['charts'],
    route: {
      schemaVersion: 1,
      activationMode: 'run_sop',
      targetSopId: 'sop-weekly-report',
      targetCrewId: null,
    },
    workspaceProfileId: 'channel-sandbox',
    createdAt: generatedAt,
    updatedAt: generatedAt,
    ...overrides,
  }
}

function hasDependency(
  subject: NonNullable<ReturnType<typeof buildGovernanceRegistry>['subjects'][number]>,
  kind: string,
  id: string,
  source?: string,
) {
  return subject.dependencies.some((dependency) => (
    dependency.kind === kind
    && dependency.id === id
    && (source === undefined || dependency.source === source)
  ))
}

test('governance registry maps custom agent lifecycle, scope, and skill-linked tools', () => {
  const payload = buildGovernanceRegistry({
    builtinAgents: [builtInAgent()],
    customAgents: [customAgent({ enabled: false })],
    agentCatalog: catalog(),
    crewCatalog: { crews: [] },
    generatedAt,
  })

  assert.equal(payload.organization.mode, 'local')
  assert.equal(payload.organization.tenantId, 'local-tenant')
  assert.deepEqual(payload.principals.map((principal) => `${principal.id}:${principal.roles.join(',')}:${principal.groupIds.join(',')}`), [
    'local-user:admin,approver,owner:local-admins',
  ])
  assert.deepEqual(payload.groups.map((group) => `${group.id}:${group.roles.join(',')}`), [
    'local-admins:admin,owner,approver',
  ])

  const agent = payload.subjects.find((subject) => subject.name === 'data-analyst')
  assert.ok(agent)
  assert.equal(agent.lifecycle, 'paused')
  assert.equal(agent.scope.kind, 'project')
  assert.equal(agent.scope.directory, '/workspace/acme')
  assert.equal(agent.owner.id, 'local-user')
  assert.deepEqual(agent.approvers.map((approver) => approver.id), ['local-user', 'local-admins'])
  assert.equal(agent.memoryBoundary.kind, 'agent')
  assert.equal(agent.incidentControls.some((control) => control.kind === 'retire_agent' && control.available), true)
  assert.deepEqual(
    agent.incidentControls.find((control) => control.kind === 'retire_agent')?.requiredRoles,
    ['admin', 'owner', 'approver'],
  )
  assert.deepEqual(
    agent.dependencies.map((dependency) => `${dependency.kind}:${dependency.id}:${dependency.source}`),
    [
      'skill:analyst:direct',
      'tool:charts:transitive',
      'tool:filesystem:direct',
    ],
  )

  const chartsIndex = payload.dependencyIndex.find((entry) => entry.dependency.kind === 'tool' && entry.dependency.id === 'charts')
  assert.deepEqual(chartsIndex?.subjectIds, [agent.subjectId])
})

test('governance registry exposes credential, SOP, and channel dependencies without secret values', () => {
  const payload = buildGovernanceRegistry({
    builtinAgents: [builtInAgent()],
    customAgents: [customAgent()],
    agentCatalog: catalog(),
    crewCatalog: crewCatalog(),
    sopCatalog: sopCatalog(),
    channels: [
      channel(),
      channel({
        id: 'channel-crew',
        name: 'Crew webhook',
        route: {
          schemaVersion: 1,
          activationMode: 'run_crew',
          targetSopId: null,
          targetCrewId: 'crew-analytics',
        },
      }),
    ],
    toolCredentialDependencies: [
      {
        toolId: 'filesystem',
        dependency: {
          kind: 'credential',
          id: 'integration:filesystem',
          label: 'Filesystem integration credentials',
          source: 'direct',
          required: true,
        },
      },
    ],
    generatedAt,
  })

  const agent = payload.subjects.find((subject) => subject.name === 'data-analyst')
  assert.ok(agent)
  assert.equal(hasDependency(agent, 'credential', 'integration:filesystem', 'direct'), true)
  assert.equal(hasDependency(agent, 'sop', 'sop-weekly-report', 'direct'), true)
  assert.equal(hasDependency(agent, 'channel', 'channel-analytics', 'transitive'), true)
  assert.equal(agent.dependencies.some((dependency) => dependency.label.includes('secret')), false)

  const crew = payload.subjects.find((subject) => subject.subjectKind === 'crew' && subject.name === 'crew-analytics')
  assert.ok(crew)
  assert.equal(hasDependency(crew, 'credential', 'integration:filesystem', 'transitive'), true)
  assert.equal(hasDependency(crew, 'channel', 'channel-crew', 'direct'), true)

  const credentialIndex = payload.dependencyIndex.find(
    (entry) => entry.dependency.kind === 'credential' && entry.dependency.id === 'integration:filesystem',
  )
  assert.deepEqual(credentialIndex?.subjectIds.sort(), [
    payload.subjects.find((subject) => subject.name === 'build')?.subjectId,
    agent.subjectId,
    crew.subjectId,
  ].sort())
})

test('governance credential dependencies are derived from configured MCP credential surfaces', () => {
  const entries = buildGovernanceToolCredentialDependencies({
    tools: [
      {
        id: 'github',
        name: 'GitHub',
        description: 'GitHub MCP.',
        kind: 'mcp',
        namespace: 'github',
        patterns: ['mcp__github__*'],
      },
      {
        id: 'charts',
        name: 'Charts',
        description: 'Charts MCP.',
        kind: 'mcp',
        namespace: 'charts',
        patterns: ['mcp__charts__*'],
      },
    ],
    mcps: [
      {
        name: 'github',
        type: 'remote',
        description: 'GitHub MCP.',
        authMode: 'api_token',
        url: 'https://example.com/mcp',
        headerSettings: [{ header: 'Authorization', key: 'token', prefix: 'Bearer ' }],
        credentials: [
          {
            key: 'token',
            label: 'Token',
            description: 'Personal access token.',
            secret: true,
            required: true,
          },
        ],
      },
      {
        name: 'charts',
        type: 'local',
        description: 'Charts MCP.',
        authMode: 'none',
      },
    ],
  })

  assert.deepEqual(entries.map((entry) => `${entry.toolId}:${entry.dependency.id}:${entry.dependency.required}`), [
    'github:integration:github:true',
  ])
})

test('governance registry matches SOP exposure to mixed-case configured agent names', () => {
  const payload = buildGovernanceRegistry({
    builtinAgents: [
      builtInAgent({
        name: 'ReportAgent',
        label: 'Report Agent',
        nativeToolIds: [],
        configuredToolIds: [],
      }),
    ],
    customAgents: [],
    agentCatalog: catalog(),
    crewCatalog: { crews: [] },
    sopCatalog: sopCatalog('reportagent'),
    channels: [channel()],
    generatedAt,
  })

  const agent = payload.subjects.find((subject) => subject.name === 'ReportAgent')
  assert.ok(agent)
  assert.equal(hasDependency(agent, 'sop', 'sop-weekly-report', 'direct'), true)
  assert.equal(hasDependency(agent, 'channel', 'channel-analytics', 'transitive'), true)
})

test('governance registry projects crew member and transitive capability dependencies', () => {
  const payload = buildGovernanceRegistry({
    builtinAgents: [builtInAgent()],
    customAgents: [customAgent()],
    agentCatalog: catalog(),
    crewCatalog: crewCatalog(),
    generatedAt,
  })

  const crew = payload.subjects.find((subject) => subject.subjectKind === 'crew' && subject.name === 'crew-analytics')
  assert.ok(crew)
  assert.equal(crew.lifecycle, 'active')
  assert.equal(crew.scope.kind, 'workspace_profile')
  assert.equal(crew.evalSuiteId, 'eval-suite-analytics')
  assert.deepEqual(crew.approvers.map((approver) => approver.id), ['local-user', 'local-admins'])
  assert.equal(crew.incidentControls.some((control) => control.kind === 'pause_crew' && control.available), true)
  assert.equal(crew.incidentControls.some((control) => control.kind === 'retire_crew' && control.available), true)
  assert.deepEqual(
    crew.incidentControls.find((control) => control.kind === 'export_audit')?.requiredRoles,
    ['admin', 'approver', 'viewer'],
  )
  assert.deepEqual(
    crew.dependencies.map((dependency) => `${dependency.kind}:${dependency.id}:${dependency.source}`),
    [
      'agent:data-analyst:direct',
      'eval_suite:eval-suite-analytics:direct',
      'skill:analyst:transitive',
      'tool:charts:transitive',
      'tool:filesystem:transitive',
      'workspace_profile:project-workspace:direct',
    ],
  )

  const workspaceIndex = payload.dependencyIndex.find(
    (entry) => entry.dependency.kind === 'workspace_profile' && entry.dependency.id === 'project-workspace',
  )
  assert.deepEqual(workspaceIndex?.subjectIds, [crew.subjectId])

  const filesystemIndex = payload.dependencyIndex.find(
    (entry) => entry.dependency.kind === 'tool' && entry.dependency.id === 'filesystem',
  )
  assert.deepEqual(filesystemIndex?.subjectIds.sort(), [
    payload.subjects.find((subject) => subject.name === 'build')?.subjectId,
    payload.subjects.find((subject) => subject.name === 'data-analyst')?.subjectId,
    crew.subjectId,
  ].sort())
})

test('invalid custom agents stay visible as draft governance records', () => {
  const payload = buildGovernanceRegistry({
    builtinAgents: [],
    customAgents: [customAgent({
      name: 'broken-agent',
      valid: false,
      issues: [{ code: 'missing_instructions', message: 'Instructions are required.' }],
    })],
    agentCatalog: catalog(),
    crewCatalog: { crews: [] },
    generatedAt,
  })

  const agent = payload.subjects[0]
  assert.equal(agent?.name, 'broken-agent')
  assert.equal(agent?.lifecycle, 'draft')
  assert.equal(agent?.offboardingPath, 'Disable or remove the project custom agent from the Agents surface.')
  assert.equal(agent?.incidentControls.some((control) => control.kind === 'pause_agent' && control.available), false)
  assert.equal(agent?.incidentControls.some((control) => control.kind === 'retire_agent' && control.available), true)
})
