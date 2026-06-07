import { describe, expect, it } from 'vitest'
import type {
  BuiltInAgentDetail,
  CapabilityRiskMetadata,
  CapabilitySkill,
  CapabilityTool,
  CustomAgentSummary,
  WorkflowListPayload,
} from '@open-cowork/shared'
import {
  CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY,
  buildCapabilityMapGroups,
  buildCapabilityMapSections,
  buildCapabilityToolSections,
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

const shellTool: CapabilityTool = {
  id: 'bash',
  name: 'Shell',
  description: 'Run shell commands through OpenCode.',
  kind: 'built-in',
  source: 'builtin',
  origin: 'opencode',
  patterns: ['bash'],
  availableTools: [],
  agentNames: ['build'],
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

const customStandaloneSkill: CapabilitySkill = {
  name: 'project-playbook',
  label: 'Project Playbook',
  description: 'Project-specific instructions.',
  source: 'custom',
  origin: 'custom',
  scope: 'project',
  toolIds: [],
  agentNames: [],
}

describe('capabilities-page-support', () => {
  it('builds source-tiered map groups with custom first and OpenCode defaults last', () => {
    const groups = buildCapabilityMapGroups(
      [browserTool, shellTool, chartTool],
      [standaloneSkill, customStandaloneSkill, reportSkill, researchSkill],
    )

    expect(groups.map((group) => group.label)).toEqual([
      'Chart MCP',
      'Custom standalone skills',
      'Browser Tool',
      'Built-in standalone skills',
      'Shell',
    ])
    expect(groups[0]?.skills.map((skill) => skill.name)).toEqual(['report', 'research'])
    expect(groups[1]?.skills.map((skill) => skill.name)).toEqual(['project-playbook'])
    expect(groups[2]?.skills.map((skill) => skill.name)).toEqual(['report'])
    expect(groups[3]?.skills.map((skill) => skill.name)).toEqual(['planner'])
    expect(groups[4]?.skills).toEqual([])

    const sections = buildCapabilityMapSections(groups)
    expect(sections.map((section) => section.id)).toEqual(['custom', 'builtin', 'opencode'])
    expect(sections.map((section) => section.groups.map((group) => group.label))).toEqual([
      ['Chart MCP', 'Custom standalone skills'],
      ['Browser Tool', 'Built-in standalone skills'],
      ['Shell'],
    ])

    const toolSections = buildCapabilityToolSections([browserTool, shellTool, chartTool])
    expect(toolSections.map((section) => section.id)).toEqual(['custom', 'builtin', 'opencode'])
    expect(toolSections.map((section) => section.tools.map((tool) => tool.name))).toEqual([
      ['Chart MCP'],
      ['Browser Tool'],
      ['Shell'],
    ])
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

  it('builds relationship rows from risk metadata, credentials, linked skills, and agent consumers', () => {
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
    const agent: CustomAgentSummary = {
      scope: 'project',
      directory: '/work/project',
      name: 'reporter',
      description: 'Reporting specialist',
      instructions: 'Build recurring reports.',
      skillNames: ['research'],
      toolIds: ['charts'],
      enabled: true,
      color: 'primary',
      writeAccess: false,
      valid: true,
      issues: [],
    }

    const rows = buildCapabilityRelationshipRows({
      tools: [credentialTool, browserTool],
      skills: [researchSkill],
      runtimeTools: [{ id: 'mcp__charts__bar', description: 'Bar chart' }],
      capabilityRisks: risks,
      customAgents: [agent],
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
      'Coworker: chart-agent',
      'Coworker: reporter',
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

  it('projects agents and workflows into relationship consumers', () => {
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
    const dailyWorkflow: WorkflowListPayload['workflows'][number] = {
      id: 'workflow-daily',
      title: 'Daily Report',
      instructions: 'Publish the daily report.',
      agentName: 'reporter',
      skillNames: ['research'],
      toolIds: ['charts'],
      status: 'active',
      projectDirectory: '/work/project',
      draftSessionId: null,
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
      nextRunAt: null,
      lastRunAt: null,
      latestRunId: null,
      latestRunStatus: null,
      latestRunSessionId: null,
      latestRunSummary: null,
      webhookUrl: null,
    }
    const workflows: WorkflowListPayload = {
      workflows: [
        dailyWorkflow,
        {
          ...dailyWorkflow,
          id: 'workflow-daily-copy',
        },
        {
          ...dailyWorkflow,
          id: 'workflow-disabled-agent',
          title: 'Disabled Agent Report',
          agentName: 'disabled-reporter',
          skillNames: [],
        },
      ],
      runs: [],
    }
    const rows = buildCapabilityRelationshipRows({
      tools: [chartTool, browserTool],
      skills: [researchSkill],
      runtimeTools: [],
      capabilityRisks: [],
      customAgents: [agent, disabledAgent, invalidAgent],
      workflows,
    })

    const chartRow = rows.find((row) => row.id === 'tool:charts')
    expect(chartRow?.consumers.map((consumer) => consumer.name)).toEqual(expect.arrayContaining([
      'Coworker: reporter',
      'Playbook: Daily Report',
    ]))
    expect(chartRow?.consumers
      .filter((consumer) => consumer.kind === 'workflow' && consumer.name === 'Playbook: Daily Report')
      .map((consumer) => consumer.id)
      .sort()).toEqual(['workflow:workflow-daily', 'workflow:workflow-daily-copy'])
    expect(chartRow?.consumers.map((consumer) => consumer.name)).not.toEqual(expect.arrayContaining([
      'Coworker: disabled-reporter',
      'Coworker: invalid-reporter',
      'Playbook: Disabled Agent Report',
    ]))

    const browserRow = rows.find((row) => row.id === 'tool:browser')
    expect(browserRow?.consumers.map((consumer) => consumer.name)).toEqual(expect.arrayContaining([
      'Coworker: reporter',
      'Playbook: Daily Report',
    ]))
    expect(browserRow?.consumers.filter((consumer) => consumer.name === 'Coworker: reporter')).toHaveLength(1)

    const researchRow = rows.find((row) => row.id === 'skill:research')
    expect(researchRow?.consumers.map((consumer) => consumer.name)).toEqual(expect.arrayContaining([
      'Coworker: reporter',
      'Playbook: Daily Report',
    ]))
  })

  it('dedupes direct and projected agent consumers', () => {
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
      customAgents: [agent],
    })

    const browserRow = rows.find((row) => row.id === 'tool:browser')
    const reporterConsumers = browserRow?.consumers.filter((consumer) => consumer.name === 'Coworker: reporter') || []
    expect(reporterConsumers).toHaveLength(1)
    expect(reporterConsumers[0]?.id).toBe('agent:reporter')
  })

  it('dedupes humanized direct agent names against canonical projected agents', () => {
    const agent: CustomAgentSummary = {
      scope: 'project',
      directory: '/work/project',
      name: 'data-ops',
      description: 'Data operations specialist',
      instructions: 'Prepare operational data reports.',
      skillNames: [],
      toolIds: ['browser'],
      enabled: true,
      color: 'primary',
      writeAccess: false,
      valid: true,
      issues: [],
    }
    const rows = buildCapabilityRelationshipRows({
      tools: [{ ...browserTool, agentNames: ['Data Ops'] }],
      skills: [],
      runtimeTools: [],
      capabilityRisks: [],
      customAgents: [agent],
    })

    const browserRow = rows.find((row) => row.id === 'tool:browser')
    const dataOpsConsumers = browserRow?.consumers.filter((consumer) => consumer.name === 'Coworker: data-ops') || []
    expect(dataOpsConsumers).toHaveLength(1)
    expect(dataOpsConsumers[0]?.id).toBe('agent:data-ops')
  })

  it('excludes disabled built-in agents from direct and projected relationship consumers', () => {
    const disabledBuiltIn: BuiltInAgentDetail = {
      name: 'researcher',
      label: 'Researcher',
      source: 'open-cowork',
      mode: 'subagent',
      hidden: false,
      disabled: true,
      color: 'primary',
      description: 'Disabled research agent.',
      instructions: 'Research safely.',
      skills: ['disabled-research'],
      toolAccess: [],
      nativeToolIds: [],
      configuredToolIds: ['browser'],
    }
    const disabledResearchSkill: CapabilitySkill = {
      name: 'disabled-research',
      label: 'Disabled Research',
      description: 'Would be used by a disabled built-in agent.',
      source: 'builtin',
      origin: 'open-cowork',
      toolIds: [],
      agentNames: ['Researcher'],
    }

    const rows = buildCapabilityRelationshipRows({
      tools: [{ ...browserTool, agentNames: ['Researcher'] }],
      skills: [disabledResearchSkill],
      runtimeTools: [],
      capabilityRisks: [],
      builtInAgents: [disabledBuiltIn],
    })

    const browserRow = rows.find((row) => row.id === 'tool:browser')
    expect(browserRow?.consumers.filter((consumer) => consumer.kind === 'agent')).toEqual([])

    const skillRow = rows.find((row) => row.id === 'skill:disabled-research')
    expect(skillRow?.consumers.filter((consumer) => consumer.kind === 'agent')).toEqual([])
  })
})
