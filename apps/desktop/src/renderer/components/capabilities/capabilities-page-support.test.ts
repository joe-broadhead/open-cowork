import { describe, expect, it } from 'vitest'
import type { CapabilitySkill, CapabilityTool } from '@open-cowork/shared'
import {
  buildCapabilityMapGroups,
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
})
