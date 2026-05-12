import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  AgentCatalog,
  AgentMemoryEntry,
  BuiltInAgentDetail,
  ChannelDefinition,
  CrewListPayload,
  CustomAgentSummary,
  EvalSuite,
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

function memoryEntry(overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return {
    schemaVersion: 1,
    id: 'memory-agent-analyst',
    scopeKind: 'agent',
    scopeId: 'data-analyst',
    status: 'approved',
    title: 'Analyst reporting memory',
    body: 'Prefer concise evidence notes in reporting.',
    summary: 'Use concise evidence notes.',
    tags: ['reporting'],
    privacy: 'internal',
    provenance: [{
      schemaVersion: 1,
      kind: 'trace',
      id: 'trace-1',
      label: 'Trace evidence',
      uri: null,
      hash: 'sha256:trace-1',
    }],
    sourceProposalId: 'proposal-memory-1',
    contentHash: 'sha256:memory-1',
    createdAt: generatedAt,
    updatedAt: generatedAt,
    reviewedAt: generatedAt,
    reviewedBy: 'local-user',
    reviewNote: 'Evidence checked.',
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

function evalSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    schemaVersion: 1,
    id: 'eval-suite-analytics',
    name: 'Analytics certification',
    description: 'Certifies analytics crew outputs.',
    status: 'active',
    createdAt: generatedAt,
    updatedAt: generatedAt,
    ...overrides,
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
    secretStorageMode: 'encrypted',
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
  assert.deepEqual(payload.executionNodes.map((node) => `${node.id}:${node.kind}:${node.status}:${node.scope.kind}`), [
    'execution-node:local-desktop:desktop:active:machine',
    'execution-node:managed-worker:managed_worker:planned:system',
  ])
  assert.deepEqual(payload.secretVaults.map((vault) => `${vault.id}:${vault.kind}:${vault.status}:${vault.storageMode}`), [
    'secret-vault:local-os:local_os:active:encrypted',
    'secret-vault:managed-external:managed_external:planned:external',
  ])
  assert.deepEqual(payload.secretVaults[0]?.storedSecretKinds, [
    'provider_credentials',
    'integration_credentials',
    'oauth_tokens',
  ])
  const localNode = payload.executionNodes[0]
  assert.ok(localNode)
  assert.equal(localNode.lastSeenAt, generatedAt)
  assert.equal(localNode.capabilities.find((capability) => capability.kind === 'scheduling')?.available, true)
  assert.equal(localNode.capabilities.find((capability) => capability.kind === 'background_execution')?.available, false)
  assert.match(localNode.limitations.join(' '), /desktop app/)
  const managedNode = payload.executionNodes[1]
  assert.ok(managedNode)
  assert.equal(managedNode.lastSeenAt, null)
  assert.equal(managedNode.capabilities.find((capability) => capability.kind === 'background_execution')?.available, false)
  assert.match(managedNode.limitations.join(' '), /roadmap placeholder/)

  const agent = payload.subjects.find((subject) => subject.name === 'data-analyst')
  assert.ok(agent)
  assert.equal(agent.lifecycle, 'paused')
  assert.equal(agent.scope.kind, 'project')
  assert.equal(agent.scope.directory, '/workspace/acme')
  assert.equal(agent.owner.id, 'local-user')
  assert.deepEqual(agent.approvers.map((approver) => approver.id), ['local-user', 'local-admins'])
  assert.equal(agent.memoryBoundary.kind, 'agent')
  assert.match(agent.evalSuiteId || '', /^eval-suite:agent:/)
  assert.equal(agent.incidentControls.some((control) => control.kind === 'retire_agent' && control.available), true)
  assert.deepEqual(
    agent.incidentControls.find((control) => control.kind === 'retire_agent')?.requiredRoles,
    ['admin', 'owner', 'approver'],
  )
  assert.deepEqual(
    agent.dependencies.map((dependency) => `${dependency.kind}:${dependency.id}:${dependency.source}`),
    [
      `eval_suite:${agent.evalSuiteId}:direct`,
      'skill:analyst:direct',
      'tool:charts:transitive',
      'tool:filesystem:direct',
    ],
  )
  const agentEvalDependency = agent.dependencies.find((dependency) => dependency.kind === 'eval_suite')
  assert.equal(agentEvalDependency?.required, false)
  assert.equal(agentEvalDependency?.lifecycle, 'review')

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
    secretStorageMode: 'encrypted',
    generatedAt,
  })

  const agent = payload.subjects.find((subject) => subject.name === 'data-analyst')
  assert.ok(agent)
  assert.equal(hasDependency(agent, 'credential', 'integration:filesystem', 'direct'), true)
  assert.equal(hasDependency(agent, 'sop', 'sop-weekly-report', 'direct'), true)
  assert.equal(hasDependency(agent, 'channel', 'channel-analytics', 'transitive'), true)
  assert.equal(agent.dependencies.some((dependency) => dependency.label.includes('secret')), false)
  assert.deepEqual(agent.credentialBindings, [{
    id: 'integration:filesystem',
    label: 'Filesystem integration credentials',
    source: 'direct',
    required: true,
    secretVaultId: 'secret-vault:local-os',
  }])

  const crew = payload.subjects.find((subject) => subject.subjectKind === 'crew' && subject.name === 'crew-analytics')
  assert.ok(crew)
  assert.equal(hasDependency(crew, 'credential', 'integration:filesystem', 'transitive'), true)
  assert.equal(hasDependency(crew, 'channel', 'channel-crew', 'direct'), true)
  assert.deepEqual(crew.credentialBindings, [{
    id: 'integration:filesystem',
    label: 'Filesystem integration credentials',
    source: 'transitive',
    required: true,
    secretVaultId: 'secret-vault:local-os',
  }])

  const credentialIndex = payload.dependencyIndex.find(
    (entry) => entry.dependency.kind === 'credential' && entry.dependency.id === 'integration:filesystem',
  )
  assert.deepEqual(credentialIndex?.subjectIds.sort(), [
    payload.subjects.find((subject) => subject.name === 'build')?.subjectId,
    agent.subjectId,
    crew.subjectId,
  ].sort())
})

test('governance registry marks unavailable local secret vaults without dropping bindings', () => {
  const payload = buildGovernanceRegistry({
    builtinAgents: [],
    customAgents: [customAgent()],
    agentCatalog: catalog(),
    crewCatalog: { crews: [] },
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
    secretStorageMode: 'unavailable',
    generatedAt,
  })

  const localVault = payload.secretVaults.find((vault) => vault.id === 'secret-vault:local-os')
  assert.ok(localVault)
  assert.equal(localVault.status, 'unavailable')
  assert.equal(localVault.storageMode, 'unavailable')
  assert.match(localVault.limitations.join(' '), /refuse to persist credentials/i)

  const agent = payload.subjects.find((subject) => subject.name === 'data-analyst')
  assert.ok(agent)
  assert.deepEqual(agent.credentialBindings, [{
    id: 'integration:filesystem',
    label: 'Filesystem integration credentials',
    source: 'direct',
    required: true,
    secretVaultId: 'secret-vault:local-os',
  }])
})

test('governance registry maps governed memory subjects and agent or crew dependencies', () => {
  const agentMemory = memoryEntry()
  const projectMemory = memoryEntry({
    id: 'memory-project-acme',
    scopeKind: 'project',
    scopeId: '/workspace/acme',
    title: 'Project reporting convention',
    summary: 'Mention the current sprint in project reports.',
  })
  const crewMemory = memoryEntry({
    id: 'memory-crew-analytics',
    scopeKind: 'crew',
    scopeId: 'crew-analytics',
    title: 'Crew delivery lesson',
    summary: 'Always include evaluator pass notes.',
  })
  const quarantinedMemory = memoryEntry({
    id: 'memory-quarantined',
    status: 'quarantined',
    title: 'Quarantined lesson',
    summary: 'Do not inject this lesson.',
  })
  const proposedMemory = memoryEntry({
    id: 'memory-proposed',
    status: 'proposed',
    title: 'Proposed lesson',
    summary: 'Not approved yet.',
  })
  const payload = buildGovernanceRegistry({
    builtinAgents: [builtInAgent()],
    customAgents: [customAgent()],
    agentCatalog: catalog(),
    crewCatalog: crewCatalog(),
    memoryEntries: [agentMemory, projectMemory, crewMemory, quarantinedMemory, proposedMemory],
    secretStorageMode: 'encrypted',
    generatedAt,
  })

  const analyst = payload.subjects.find((subject) => subject.name === 'data-analyst')
  assert.ok(analyst)
  assert.equal(hasDependency(analyst, 'memory', 'memory:memory-agent-analyst'), true)
  assert.equal(hasDependency(analyst, 'memory', 'memory:memory-project-acme'), true)
  assert.equal(hasDependency(analyst, 'memory', 'memory:memory-quarantined'), true)
  assert.equal(hasDependency(analyst, 'memory', 'memory:memory-proposed'), false)

  const crew = payload.subjects.find((subject) => subject.subjectId === 'crew:crew-analytics')
  assert.ok(crew)
  assert.equal(hasDependency(crew, 'memory', 'memory:memory-crew-analytics'), true)
  assert.equal(hasDependency(crew, 'memory', 'memory:memory-agent-analyst', 'transitive'), true)
  assert.equal(hasDependency(crew, 'memory', 'memory:memory-project-acme', 'transitive'), true)
  assert.equal(hasDependency(crew, 'memory', 'memory:memory-quarantined', 'transitive'), true)
  assert.equal(hasDependency(crew, 'memory', 'memory:memory-proposed'), false)

  const memorySubject = payload.subjects.find((subject) => subject.subjectId === 'memory:memory-agent-analyst')
  assert.ok(memorySubject)
  assert.equal(memorySubject.subjectKind, 'memory')
  assert.equal(memorySubject.lifecycle, 'approved')
  assert.equal(memorySubject.scope.label, 'Agent memory: data-analyst')
  assert.equal(memorySubject.memoryBoundary.kind, 'agent')
  assert.equal(memorySubject.incidentControls.find((control) => control.kind === 'quarantine_memory')?.available, true)

  const quarantinedSubject = payload.subjects.find((subject) => subject.subjectId === 'memory:memory-quarantined')
  assert.ok(quarantinedSubject)
  assert.equal(quarantinedSubject.lifecycle, 'quarantined')
  assert.equal(quarantinedSubject.incidentControls.find((control) => control.kind === 'quarantine_memory')?.available, false)

  const memoryIndex = payload.dependencyIndex.find((entry) => entry.dependency.kind === 'memory' && entry.dependency.id === 'memory:memory-agent-analyst')
  assert.deepEqual(memoryIndex?.subjectIds.sort(), [analyst.subjectId, crew.subjectId].sort())
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
    secretStorageMode: 'encrypted',
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
    evalSuites: [evalSuite()],
    secretStorageMode: 'encrypted',
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
  const evalSuiteDependency = crew.dependencies.find((dependency) => dependency.kind === 'eval_suite')
  assert.equal(evalSuiteDependency?.label, 'Analytics certification')
  assert.equal(evalSuiteDependency?.lifecycle, 'active')

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

test('governance registry gives crews without stored suites an explicit baseline eval hook', () => {
  const crews = crewCatalog()
  const crewEntry = crews.crews[0]
  assert.ok(crewEntry?.activeVersion)
  crewEntry.activeVersion = {
    ...crewEntry.activeVersion,
    evalSuiteId: null,
    certificationStatus: 'not_required',
    certifiedAt: null,
  }
  const payload = buildGovernanceRegistry({
    builtinAgents: [builtInAgent()],
    customAgents: [customAgent()],
    agentCatalog: catalog(),
    crewCatalog: crews,
    secretStorageMode: 'encrypted',
    generatedAt,
  })

  const crew = payload.subjects.find((subject) => subject.subjectKind === 'crew' && subject.name === 'crew-analytics')
  assert.ok(crew)
  assert.match(crew.evalSuiteId || '', /^eval-suite:crew:/)
  const evalDependency = crew.dependencies.find((dependency) => dependency.kind === 'eval_suite')
  assert.equal(evalDependency?.id, crew.evalSuiteId)
  assert.equal(evalDependency?.required, false)
  assert.equal(evalDependency?.lifecycle, 'review')
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
    secretStorageMode: 'encrypted',
    generatedAt,
  })

  const agent = payload.subjects[0]
  assert.equal(agent?.name, 'broken-agent')
  assert.equal(agent?.lifecycle, 'draft')
  assert.equal(agent?.offboardingPath, 'Disable or remove the project custom agent from the Agents surface.')
  assert.equal(agent?.incidentControls.some((control) => control.kind === 'pause_agent' && control.available), false)
  assert.equal(agent?.incidentControls.some((control) => control.kind === 'retire_agent' && control.available), true)
})
