import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CapabilitySkill, CapabilityTool } from '@open-cowork/shared'
import { SkillSelectionCard, ToolSelectionCard } from './CapabilitySelectionCard'

const tool: CapabilityTool = {
  id: 'warehouse.query',
  name: 'Warehouse Query',
  icon: 'db',
  description: 'Run bounded analytical queries.',
  kind: 'mcp',
  source: 'custom',
  origin: 'custom',
  scope: 'project',
  namespace: 'warehouse',
  patterns: ['mcp__warehouse__query'],
  availableTools: [
    { id: 'query', description: 'Query data' },
    { id: 'schema', description: 'Inspect schema' },
  ],
  agentNames: ['Analyst', 'BI Engineer'],
}

const skill: CapabilitySkill = {
  name: 'analyst',
  label: 'Analyst',
  description: 'Resolve canonical metrics before querying.',
  source: 'builtin',
  origin: 'open-cowork',
  scope: 'machine',
  toolIds: ['warehouse.query'],
  agentNames: ['Analyst'],
}

describe('CapabilitySelectionCard', () => {
  it('renders tool metadata, linked skills, and opens the tool', () => {
    const onOpen = vi.fn()
    render(
      <ToolSelectionCard
        tool={tool}
        methodsCount={2}
        isCustom
        linkedSkills={[skill]}
        onOpen={onOpen}
      />,
    )

    expect(screen.getByText('Warehouse Query')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()
    expect(screen.getByText('Custom')).toBeInTheDocument()
    expect(screen.getByText('Analyst')).toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()

    const details = screen.getByRole('button', { name: 'Details for Warehouse Query' })
    expect(details).toHaveAccessibleDescription('Run bounded analytical queries.')
    fireEvent.click(details)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders custom tool removal without opening the card', () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    render(
      <ToolSelectionCard
        tool={tool}
        methodsCount={2}
        isCustom
        linkedSkills={[]}
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('renders skill metadata, linked tools, and custom removal', () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    render(
      <SkillSelectionCard
        skill={{ ...skill, source: 'custom', origin: 'custom', scope: 'project' }}
        isCustom
        linkedTools={[{ id: tool.id, name: tool.name }]}
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    )

    expect(screen.getByText('Analyst')).toBeInTheDocument()
    expect(screen.getByText('Custom')).toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByText('Warehouse Query')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Details for Analyst' }))
    expect(onOpen).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('announces only a concise summary until Details is opened', () => {
    const longInstructions = `Run bounded analytical queries. ${'Never announce these operator instructions on initial traversal. '.repeat(8)}`
    render(
      <ToolSelectionCard
        tool={{ ...tool, description: longInstructions }}
        methodsCount={2}
        isCustom={false}
        onOpen={vi.fn()}
      />,
    )

    const details = screen.getByRole('button', { name: 'Details for Warehouse Query' })
    expect(details).toHaveAccessibleDescription('Run bounded analytical queries.')
    expect(screen.queryByText(/Never announce these operator instructions/)).not.toBeInTheDocument()
  })
})
