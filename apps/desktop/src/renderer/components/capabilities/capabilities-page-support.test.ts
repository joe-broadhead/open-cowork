import { describe, expect, it } from 'vitest'
import type {
  AutomationListPayload,
  CapabilityRiskMetadata,
  CapabilitySkill,
  CapabilityTool,
  ChannelListPayload,
  CrewListPayload,
  CustomAgentSummary,
  GovernanceRegistryPayload,
} from '@open-cowork/shared'
import {
  CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY,
  buildCapabilityMapGroups,
  buildCapabilityRelationshipRows,
  isCapabilityRelationshipGraphEnabled,
  linkedSkillsForTool,
  linkedToolsForSkill,
  skillMatchesCapabilityQuery,
  toolMatchesCapabilityQuery,
} from './capabilities-page-support'

const chartTool: CapabilityTool = {
  id: 'charts',
  name: 'Chart MCP',
  description: 'Creates report visuals.',
  kind: 'mcp',
  source: 'custom',
  origin: 'custom',
  patterns: ['mcp__charts__*'],
  availableTools: [],
  agentNames: ['chart-agent'],
}

const browserTool: CapabilityTool = {
  id: 'browser',
  name: 'Browser Tool',
  description: 'Reads public web pages.',
  kind: 'mcp',
  source: 'builtin',
  origin: 'open-cowork',
  patterns: ['mcp__browser__*'],
  availableTools: [],
  agentNames: [],
}

const researchSkill: CapabilitySkill = {
  name: 'research',
  label: 'Research Skill',
  description: 'Collects sources for analysis.',
  source: 'builtin',
  origin: 'open-cowork',
  toolIds: ['charts'],
  agentNames: ['research-agent'],
}

const reportSkill: CapabilitySkill = {
  name: 'report',
  label: 'Report Builder',
  description: 'Turns research into a charted report.',
  source: 'custom',
  origin: 'custom',
  toolIds: ['charts', 'browser'],
  agentNames: [],
}

const standaloneSkill: CapabilitySkill = {
  name: 'planner',
  label: 'Planner',
  description: 'Plans work without a specific tool.',
  source: 'builtin',
  origin: 'open-cowork',
  toolIds: ['missing-tool'],
  agentNames: [],
}

describe('capabilities-page-support', () => {
  it('builds deterministic tool-first map groups with standalone fallback', () => {
    const groups = buildCapabilityMapGroups(
      [browserTool, chartTool],
      [standaloneSkill, reportSkill, researchSkill],
    )

    expect(groups.map((group) => group.label)).toEqual([
      'Browser Tool',
      'Chart MCP',
      'Standalone skills',
    ])
    expect(groups[0]?.skills.map((skill) => skill.name)).toEqual(['report'])
    expect(groups[1]?.skills.map((skill) => skill.name)).toEqual(['report', 'research'])
    expect(groups[2]?.skills.map((skill) => skill.name)).toEqual(['planner'])
  })

  it('searches across linked skill and tool text', () => {
    expect(toolMatchesCapabilityQuery(chartTool, [researchSkill], 'sources')).toBe(true)
    expect(skillMatchesCapabilityQuery(researchSkill, [chartTool], 'chart mcp')).toBe(true)

    const groups = buildCapabilityMapGroups([browserTool, chartTool], [reportSkill, researchSkill], 'sources')
    expect(groups.map((group) => group.label)).toEqual(['Chart MCP'])
    expect(groups[0]?.matchedSkillNames.has('research')).toBe(true)
    expect(groups[0]?.skills.map((skill) => skill.name)).toEqual(['research'])
  })

  it('resolves linked tools and skills with stable display ordering', () => {
    expect(linkedToolsForSkill(reportSkill, [chartTool, browserTool])).toEqual([
      { id: 'browser', name: 'Browser Tool' },
      { id: 'charts', name: 'Chart MCP' },
    ])
    expect(linkedSkillsForTool(chartTool, [standaloneSkill, reportSkill, researchSkill]).map((skill) => skill.name)).toEqual([
      'report',
      'research',
    ])
  })

  it('keeps the relationship graph behind an explicit default-off feature gate', () => {
    window.localStorage.removeItem(CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY)
    try {
      expect(isCapabilityRelationshipGraphEnabled()).toBe(false)
      window.localStorage.setItem(CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY, 'true')
      expect(isCapabilityRelationshipGraphEnabled()).toBe(true)
    } finally {
      window.localStorage.removeItem(CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY)
    }
  })

  it('builds relationship rows from risk metadata, credentials, linked skills, and governance consumers', () => {
    const risks: CapabilityRiskMetadata[] = [
      {
        schemaVersion: 1,
        capabilityId: 'tool:charts',
        toolPattern: 'mcp__charts__*',
        risk: 'high',
        writeCapable: true,
        approvalRequired: false,
        reason: 'Charts can publish external reports.',
      },
      {
        schemaVersion: 1,
        capabilityId: 'skill:research',
        toolPattern: null,
        risk: 'medium',
        writeCapable: false,
        approvalRequired: true,
        reason: 'Research inherits browser access.',
      },
    ]
    const governanceRegistry: GovernanceRegistryPayload = {
      schemaVersion: 1,
      generatedAt: '2026-05-13T00:00:00.000Z',
      organization: {
        schemaVersion: 1,
        id: 'local',
        tenantId: 'local',
        displayName: 'Local',
        mode: 'local',
      },
      principals: [],
      groups: [],
      secretVaults: [],
      executionNodes: [],
      subjects: [
        {
          schemaVersion: 1,
          subjectKind: 'crew',
          subjectId: 'crew:reporting',
          name: 'reporting',
          displayName: 'Reporting Crew',
          description: 'Builds reports.',
          owner: { kind: 'user', id: 'local-user', displayName: 'Local user' },
          approvers: [],
          lifecycle: 'active',
          scope: { kind: 'machine', id: 'machine', label: 'Machine' },
          memoryBoundary: { kind: 'none', id: null, label: 'No memory' },
          evalSuiteId: null,
          offboardingPath: 'Retire crew.',
          credentialBindings: [],
          dependencies: [],
          incidentControls: [],
        },
      ],
      dependencyIndex: [
        {
          dependency: {
            kind: 'tool',
            id: 'charts',
            label: 'Charts',
            source: 'direct',
            required: true,
          },
          subjectIds: ['crew:reporting'],
        },
      ],
    }
    const credentialTool: CapabilityTool = {
      ...chartTool,
      credentials: [{
        key: 'apiKey',
        label: 'Charts API key',
        description: 'Token for chart publishing.',
        secret: true,
        required: true,
      }],
      credentialReady: false,
    }

    const rows = buildCapabilityRelationshipRows({
      tools: [credentialTool, browserTool],
      skills: [researchSkill],
      runtimeTools: [{ id: 'mcp__charts__bar', description: 'Bar chart' }],
      capabilityRisks: risks,
      governanceRegistry,
    })

    const chartRow = rows.find((row) => row.id === 'tool:charts')
    expect(chartRow).toMatchObject({
      risk: 'high',
      writeCapable: true,
      accessPolicy: { state: 'credential_missing' },
      credentialHealth: { state: 'missing' },
      methodsCount: 1,
    })
    expect(chartRow?.consumers.map((consumer) => consumer.name)).toEqual([
      'Agent: chart-agent',
      'Crew: Reporting Crew',
      'Skill: Research Skill',
    ])

    const researchRow = rows.find((row) => row.id === 'skill:research')
    expect(researchRow).toMatchObject({
      risk: 'medium',
      accessPolicy: { state: 'inherited' },
      requiredCapabilities: ['Chart MCP'],
    })
    expect(researchRow?.edges.some((edge) => edge.toId === 'tool:charts')).toBe(true)
  })

  it('projects agents, crews, automations, and channels into relationship consumers', () => {
    const agent: CustomAgentSummary = {
      scope: 'project',
      directory: '/work/project',
      name: 'reporter',
      description: 'Reporting specialist',
      instructions: 'Build recurring reports.',
      skillNames: ['research'],
      toolIds: ['browser'],
      enabled: true,
      color: 'primary',
      writeAccess: false,
      valid: true,
      issues: [],
    }
    const disabledAgent: CustomAgentSummary = {
      ...agent,
      name: 'disabled-reporter',
      toolIds: ['charts'],
      skillNames: [],
      enabled: false,
    }
    const invalidAgent: CustomAgentSummary = {
      ...agent,
      name: 'invalid-reporter',
      toolIds: ['charts'],
      skillNames: [],
      valid: false,
      issues: [{ code: 'invalid', message: 'Invalid agent configuration.' }],
    }
    const crews: CrewListPayload = {
      crews: [
        {
          definition: {
            schemaVersion: 1,
            id: 'crew-field',
            name: 'Field Crew',
            description: 'Runs field reporting.',
            status: 'active',
            activeVersionId: 'crew-version-field',
            createdAt: '2026-05-13T00:00:00.000Z',
            updatedAt: '2026-05-13T00:00:00.000Z',
          },
          activeVersion: {
            schemaVersion: 1,
            id: 'crew-version-field',
            crewId: 'crew-field',
            version: 1,
            members: [{
              schemaVersion: 1,
              id: 'member-reporter',
              role: 'lead',
              agentName: 'reporter',
              displayName: 'Reporter',
              description: 'Owns the report.',
              required: true,
            }],
            workspaceProfileId: null,
            outcomeRubricId: null,
            evalSuiteId: null,
            certificationStatus: 'not_required',
            certifiedAt: null,
            budgetCapUsd: null,
            approvalPolicy: 'review-before-delivery',
            workflow: ['plan', 'delegate', 'join', 'deliver'],
            createdAt: '2026-05-13T00:00:00.000Z',
            createdBy: 'local-user',
          },
          latestRun: null,
        },
      ],
    }
    const dailyAutomation: AutomationListPayload['automations'][number] = {
      id: 'automation-daily',
      title: 'Daily Report',
      goal: 'Publish the daily report.',
      kind: 'recurring',
      status: 'ready',
      schedule: { type: 'daily', timezone: 'UTC', runAtHour: 9, runAtMinute: 0 },
      heartbeatMinutes: 60,
      retryPolicy: { maxRetries: 3, baseDelayMinutes: 10, maxDelayMinutes: 60 },
      runPolicy: { dailyRunCap: 1, maxRunDurationMinutes: 60 },
      executionMode: 'scoped_execution',
      autonomyPolicy: 'review-first',
      projectDirectory: '/work/project',
      preferredAgentNames: ['reporter'],
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
      nextRunAt: null,
      lastRunAt: null,
      nextHeartbeatAt: null,
      lastHeartbeatAt: null,
      latestRunStatus: null,
      latestRunId: null,
    }
    const automations: AutomationListPayload = {
      automations: [
        dailyAutomation,
        {
          ...dailyAutomation,
          id: 'automation-daily-copy',
        },
        {
          ...dailyAutomation,
          id: 'automation-disabled-agent',
          title: 'Disabled Agent Report',
          preferredAgentNames: ['disabled-reporter'],
        },
      ],
      inbox: [],
      workItems: [],
      runs: [],
      deliveries: [],
    }
    const channels: ChannelListPayload = {
      channels: [{
        schemaVersion: 1,
        id: 'channel-ops',
        provider: 'local_webhook',
        name: 'Ops Intake',
        description: 'Receives reporting requests.',
        sourceKey: 'ops',
        enabled: true,
        senderAllowlist: ['ops@example.com'],
        allowedCapabilityIds: ['tool:charts', 'skill:research'],
        route: {
          schemaVersion: 1,
          activationMode: 'run_crew',
          targetCrewId: 'crew-field',
          targetSopId: null,
        },
        workspaceProfileId: 'channel-sandbox',
        createdAt: '2026-05-13T00:00:00.000Z',
        updatedAt: '2026-05-13T00:00:00.000Z',
      }],
      inboundItems: [],
      deliveries: [],
    }
    const governanceRegistry: GovernanceRegistryPayload = {
      schemaVersion: 1,
      generatedAt: '2026-05-13T00:00:00.000Z',
      organization: {
        schemaVersion: 1,
        id: 'local',
        tenantId: 'local',
        displayName: 'Local',
        mode: 'local',
      },
      principals: [],
      groups: [],
      secretVaults: [],
      executionNodes: [],
      subjects: [
        {
          schemaVersion: 1,
          subjectKind: 'agent',
          subjectId: 'agent:project:test-hash:reporter',
          name: 'reporter',
          displayName: 'reporter',
          description: 'Reporting specialist',
          owner: { kind: 'user', id: 'local-user', displayName: 'Local user' },
          approvers: [],
          lifecycle: 'active',
          scope: { kind: 'project', id: 'project', label: 'Project' },
          memoryBoundary: { kind: 'none', id: null, label: 'No memory' },
          evalSuiteId: null,
          offboardingPath: 'Retire agent.',
          credentialBindings: [],
          dependencies: [],
          incidentControls: [],
        },
      ],
      dependencyIndex: [
        {
          dependency: {
            kind: 'tool',
            id: 'browser',
            label: 'Browser',
            source: 'direct',
            required: true,
          },
          subjectIds: ['agent:project:test-hash:reporter'],
        },
      ],
    }

    const rows = buildCapabilityRelationshipRows({
      tools: [chartTool, browserTool],
      skills: [researchSkill],
      runtimeTools: [],
      capabilityRisks: [],
      governanceRegistry,
      customAgents: [agent, disabledAgent, invalidAgent],
      crews,
      automations,
      channels,
    })

    const chartRow = rows.find((row) => row.id === 'tool:charts')
    expect(chartRow?.consumers.map((consumer) => consumer.name)).toEqual(expect.arrayContaining([
      'Agent: reporter',
      'Automation: Daily Report',
      'Channel: Ops Intake',
      'Crew: Field Crew',
    ]))
    expect(chartRow?.consumers
      .filter((consumer) => consumer.kind === 'automation' && consumer.name === 'Automation: Daily Report')
      .map((consumer) => consumer.id)
      .sort()).toEqual(['automation:automation-daily', 'automation:automation-daily-copy'])
    expect(chartRow?.consumers.map((consumer) => consumer.name)).not.toEqual(expect.arrayContaining([
      'Agent: disabled-reporter',
      'Agent: invalid-reporter',
      'Automation: Disabled Agent Report',
    ]))

    const browserRow = rows.find((row) => row.id === 'tool:browser')
    expect(browserRow?.consumers.map((consumer) => consumer.name)).toEqual(expect.arrayContaining([
      'Agent: reporter',
      'Automation: Daily Report',
      'Channel: Ops Intake',
      'Crew: Field Crew',
    ]))
    expect(browserRow?.consumers.filter((consumer) => consumer.name === 'Agent: reporter')).toHaveLength(1)

    const researchRow = rows.find((row) => row.id === 'skill:research')
    expect(researchRow?.consumers.map((consumer) => consumer.name)).toEqual(expect.arrayContaining([
      'Agent: reporter',
      'Automation: Daily Report',
      'Channel: Ops Intake',
      'Crew: Field Crew',
    ]))
  })

  it('dedupes direct and projected agent consumers without a governance registry', () => {
    const agent: CustomAgentSummary = {
      scope: 'project',
      directory: '/work/project',
      name: 'reporter',
      description: 'Reporting specialist',
      instructions: 'Build recurring reports.',
      skillNames: [],
      toolIds: ['browser'],
      enabled: true,
      color: 'primary',
      writeAccess: false,
      valid: true,
      issues: [],
    }
    const rows = buildCapabilityRelationshipRows({
      tools: [{ ...browserTool, agentNames: ['Reporter'] }],
      skills: [],
      runtimeTools: [],
      capabilityRisks: [],
      governanceRegistry: null,
      customAgents: [agent],
    })

    const browserRow = rows.find((row) => row.id === 'tool:browser')
    const reporterConsumers = browserRow?.consumers.filter((consumer) => consumer.name === 'Agent: reporter') || []
    expect(reporterConsumers).toHaveLength(1)
    expect(reporterConsumers[0]?.id).toBe('agent:reporter')
  })
})
