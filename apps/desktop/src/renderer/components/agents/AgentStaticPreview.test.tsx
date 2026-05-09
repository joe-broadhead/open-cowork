import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AgentCatalog, CustomAgentConfig } from '@open-cowork/shared'
import { AgentStaticPreview } from './AgentStaticPreview'

const catalog: AgentCatalog = {
  reservedNames: [],
  colors: ['accent', 'info'],
  tools: [
    {
      id: 'charts',
      name: 'Charts',
      icon: 'chart',
      description: 'Render charts.',
      source: 'builtin',
      supportsWrite: false,
      patterns: ['mcp__charts__*'],
    },
  ],
  skills: [
    {
      name: 'analyst',
      label: 'Analyst',
      description: 'Canonical data analysis workflow.',
      source: 'builtin',
      toolIds: ['charts'],
    },
  ],
}

function draft(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    scope: 'project',
    directory: '/workspace',
    name: 'data-analyst',
    description: 'Analyze data.',
    instructions: 'Read the analyst skill before answering.',
    skillNames: ['analyst', 'missing-skill'],
    toolIds: ['charts', 'missing-tool'],
    enabled: true,
    color: 'info',
    avatar: null,
    model: null,
    variant: null,
    temperature: null,
    top_p: null,
    steps: null,
    options: null,
    ...overrides,
  }
}

describe('AgentStaticPreview', () => {
  it('renders the compiled agent surface and missing reference warnings', () => {
    render(<AgentStaticPreview draft={draft()} catalog={catalog} />)

    expect(screen.getByText('Static preview')).toBeInTheDocument()
    expect(screen.getByText('Read only scope')).toBeInTheDocument()
    expect(screen.getByText('@data-analyst')).toBeInTheDocument()
    expect(screen.getAllByText('1 of 2')).toHaveLength(2)
    expect(screen.getByText('Missing tools: missing-tool')).toBeInTheDocument()
    expect(screen.getByText('Missing skills: missing-skill')).toBeInTheDocument()
    expect(screen.getByText('Read the analyst skill before answering.')).toBeInTheDocument()
    expect(screen.getByText('mcp__charts__*')).toBeInTheDocument()
    expect(screen.getByText('Canonical data analysis workflow.')).toBeInTheDocument()
  })

  it('omits optional sections when no tools or skills resolve', () => {
    render(
      <AgentStaticPreview
        draft={draft({ toolIds: [], skillNames: [], scope: 'machine', directory: null })}
        catalog={catalog}
      />,
    )

    expect(screen.getByText('Read only scope')).toBeInTheDocument()
    expect(screen.getAllByText('0 of 0')).toHaveLength(2)
    expect(screen.queryByText('Tool patterns')).not.toBeInTheDocument()
    expect(screen.queryByText('Skills available to load')).not.toBeInTheDocument()
  })
})
