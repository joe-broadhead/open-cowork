import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentCatalog, CustomMcpConfig } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { McpRestrictionPanel } from './McpRestrictionPanel'

const catalog: AgentCatalog = {
  tools: [
    {
      id: 'warehouse',
      name: 'Warehouse',
      icon: 'db',
      description: 'Query governed warehouse data.',
      supportsWrite: false,
      source: 'custom',
      patterns: ['mcp__warehouse__*'],
    },
    {
      id: 'bash',
      name: 'Bash',
      icon: 'code',
      description: 'Run shell commands.',
      supportsWrite: true,
      source: 'builtin',
      patterns: ['bash'],
    },
  ],
  skills: [],
  reservedNames: [],
  colors: ['accent'],
}

const warehouseMcp: CustomMcpConfig = {
  scope: 'project',
  directory: '/repo',
  name: 'warehouse',
  label: 'Warehouse',
  description: 'Query governed warehouse data.',
  type: 'http',
  url: 'https://warehouse.example/mcp',
}

describe('McpRestrictionPanel', () => {
  it('renders nothing without selected custom MCP tools', () => {
    const { container } = render(
      <McpRestrictionPanel
        catalog={catalog}
        selectedToolIds={['bash']}
        deniedToolPatterns={[]}
        projectDirectory={null}
        onTogglePattern={vi.fn()}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('introspects custom MCP methods and toggles method restrictions', async () => {
    const onTogglePattern = vi.fn()
    const listMcps = vi.fn(async () => [warehouseMcp])
    const testMcp = vi.fn(async () => ({
      ok: true,
      methods: [
        { id: 'query', description: 'Run a query' },
        { id: 'delete_dataset', description: 'Delete a dataset' },
      ],
      error: null,
    }))
    installRendererTestCoworkApi({ custom: { listMcps, testMcp } })

    render(
      <McpRestrictionPanel
        catalog={catalog}
        selectedToolIds={['warehouse']}
        deniedToolPatterns={['mcp__warehouse__delete_dataset']}
        projectDirectory="/repo"
        onTogglePattern={onTogglePattern}
      />,
    )

    await waitFor(() => expect(listMcps).toHaveBeenCalledWith({ directory: '/repo' }))
    fireEvent.click(screen.getByRole('button', { name: /Warehouse/i }))

    expect(await screen.findByText('query')).toBeInTheDocument()
    expect(testMcp).toHaveBeenCalledWith(warehouseMcp)

    fireEvent.click(screen.getByLabelText(/Run a query/i))
    expect(onTogglePattern).toHaveBeenCalledWith('mcp__warehouse__query')

    fireEvent.click(screen.getByLabelText(/Delete a dataset/i))
    expect(onTogglePattern).toHaveBeenCalledWith('mcp__warehouse__delete_dataset')
  })

  it('falls back to manual restriction entry when introspection fails', async () => {
    const onTogglePattern = vi.fn()
    const listMcps = vi.fn(async () => [warehouseMcp])
    installRendererTestCoworkApi({
      custom: {
        listMcps,
        testMcp: vi.fn(async () => ({
          ok: false,
          methods: [],
          error: 'OAuth required',
        })),
      },
    })

    render(
      <McpRestrictionPanel
        catalog={catalog}
        selectedToolIds={['warehouse']}
        deniedToolPatterns={['mcp__warehouse__old_method']}
        projectDirectory="/repo"
        onTogglePattern={onTogglePattern}
      />,
    )

    await waitFor(() => expect(listMcps).toHaveBeenCalledWith({ directory: '/repo' }))
    fireEvent.click(screen.getByRole('button', { name: /Warehouse/i }))
    expect(await screen.findByText(/OAuth required/)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('e.g. delete_repo'), {
      target: { value: 'drop_table' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Block' }))
    expect(onTogglePattern).toHaveBeenCalledWith('mcp__warehouse__drop_table')

    fireEvent.click(screen.getByTitle('Click to remove this restriction'))
    expect(onTogglePattern).toHaveBeenCalledWith('mcp__warehouse__old_method')
  })

  it('reports missing MCP configuration and supports retry', async () => {
    const testMcp = vi.fn()
    installRendererTestCoworkApi({
      custom: {
        listMcps: vi.fn(async () => []),
        testMcp,
      },
    })

    render(
      <McpRestrictionPanel
        catalog={catalog}
        selectedToolIds={['warehouse']}
        deniedToolPatterns={[]}
        projectDirectory={null}
        onTogglePattern={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Warehouse/i }))
    expect(await screen.findByText(/MCP config not found/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(testMcp).not.toHaveBeenCalled()
  })
})
