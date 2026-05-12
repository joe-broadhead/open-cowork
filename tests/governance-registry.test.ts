import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  AgentCatalog,
  BuiltInAgentDetail,
  CrewListPayload,
  CustomAgentSummary,
} from '@open-cowork/shared'
import { buildGovernanceRegistry } from '../apps/desktop/src/main/governance-registry.ts'

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

test('governance registry maps custom agent lifecycle, scope, and skill-linked tools', () => {
  const payload = buildGovernanceRegistry({
    builtinAgents: [builtInAgent()],
    customAgents: [customAgent({ enabled: false })],
    agentCatalog: catalog(),
    crewCatalog: { crews: [] },
    generatedAt,
  })

  const agent = payload.subjects.find((subject) => subject.name === 'data-analyst')
  assert.ok(agent)
  assert.equal(agent.lifecycle, 'paused')
  assert.equal(agent.scope.kind, 'project')
  assert.equal(agent.scope.directory, '/workspace/acme')
  assert.equal(agent.owner.id, 'local-user')
  assert.equal(agent.memoryBoundary.kind, 'agent')
  assert.equal(agent.incidentControls.some((control) => control.kind === 'retire_agent' && control.available), true)
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
  assert.equal(crew.incidentControls.some((control) => control.kind === 'pause_crew' && control.available), true)
  assert.equal(crew.incidentControls.some((control) => control.kind === 'retire_crew' && control.available), true)
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
