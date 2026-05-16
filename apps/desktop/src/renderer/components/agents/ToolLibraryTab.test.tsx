import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentCatalog } from '@open-cowork/shared'
import { ToolLibraryTab } from './ToolLibraryTab'

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
  skills: [],
}

describe('ToolLibraryTab', () => {
  it('renders an empty-state prompt when no tools are available', () => {
    render(
      <ToolLibraryTab
        catalog={{ ...catalog, tools: [] }}
        selectedToolIds={[]}
        onToggle={() => undefined}
        deniedToolPatterns={[]}
        onToggleDeniedPattern={() => undefined}
        projectDirectory={null}
      />,
    )

    expect(screen.getByText('No tools available yet. Add an MCP from the Tools & Skills page.')).toBeInTheDocument()
  })

  it('renders write-capable marks and toggles selected tools', () => {
    const onToggle = vi.fn()
    render(
      <ToolLibraryTab
        catalog={catalog}
        selectedToolIds={['github']}
        onToggle={onToggle}
        deniedToolPatterns={[]}
        onToggleDeniedPattern={() => undefined}
        projectDirectory={null}
      />,
    )

    expect(screen.getByText('W')).toHaveAttribute('title', "This tool can write — adds to the agent's footprint")
    fireEvent.click(screen.getByRole('button', { name: /Charts/i }))
    expect(onToggle).toHaveBeenCalledWith('charts')
  })

  it('does not fire toggles in read-only mode', () => {
    const onToggle = vi.fn()
    render(
      <ToolLibraryTab
        catalog={catalog}
        selectedToolIds={[]}
        onToggle={onToggle}
        deniedToolPatterns={[]}
        onToggleDeniedPattern={() => undefined}
        projectDirectory={null}
        readOnly
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /GitHub/i }))
    expect(onToggle).not.toHaveBeenCalled()
  })
})
