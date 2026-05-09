import { describe, expect, it } from 'vitest'
import type { AgentCatalog } from '@open-cowork/shared'
import { buildSkillGroups } from './AgentCapabilitiesTab'

const catalog: AgentCatalog = {
  reservedNames: [],
  colors: ['accent'],
  tools: [
    {
      id: 'github',
      name: 'GitHub',
      icon: 'github',
      description: 'Repository workflows.',
      supportsWrite: true,
      source: 'builtin',
      patterns: ['mcp__github__*'],
    },
    {
      id: 'charts',
      name: 'Charts',
      icon: 'chart',
      description: 'Chart rendering.',
      supportsWrite: false,
      source: 'builtin',
      patterns: ['mcp__charts__*'],
    },
  ],
  skills: [
    {
      name: 'repo-review',
      label: 'Repo Review',
      description: 'Review repository work.',
      source: 'builtin',
      toolIds: ['github'],
    },
    {
      name: 'chart-creator',
      label: 'Chart Creator',
      description: 'Create visual summaries.',
      source: 'builtin',
      toolIds: ['charts'],
    },
    {
      name: 'release-brief',
      label: 'Release Brief',
      description: 'Prepare release notes with charts.',
      source: 'builtin',
      toolIds: ['github', 'charts'],
    },
    {
      name: 'plain-writer',
      label: 'Plain Writer',
      description: 'Draft prose without tool coupling.',
      source: 'builtin',
    },
  ],
}

describe('buildSkillGroups', () => {
  it('prioritizes skills linked to selected tools, then groups remaining skills by tool relationship', () => {
    const groups = buildSkillGroups(catalog, ['github'])
    expect(groups.map((group) => group.id)).toEqual([
      'recommended:github',
      'linked:charts',
      'standalone',
    ])
    expect(groups[0]?.skills.map((skill) => skill.name)).toEqual(['repo-review', 'release-brief'])
    expect(groups[1]?.skills.map((skill) => skill.name)).toEqual(['chart-creator'])
    expect(groups[2]?.skills.map((skill) => skill.name)).toEqual(['plain-writer'])
  })

  it('searches skills through their linked tool names', () => {
    const groups = buildSkillGroups(catalog, [], 'github')
    expect(groups.flatMap((group) => group.skills.map((skill) => skill.name))).toEqual([
      'repo-review',
      'release-brief',
    ])
  })
})
