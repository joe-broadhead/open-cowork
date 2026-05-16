import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../../test/setup'
import { CustomMcpForm } from './CustomMcpForm'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CustomMcpForm', () => {
  it('blocks invalid drafts before calling the main process', async () => {
    const addMcp = vi.fn(async () => true)
    installRendererTestCoworkApi({
      custom: {
        addMcp,
        listMcps: vi.fn(async () => []),
        listSkills: vi.fn(async () => []),
      },
    })

    render(<CustomMcpForm onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByText('Add an MCP id so the runtime can register it.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add MCP' })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('e.g. github, jira, slack'), {
      target: { value: 'bad id with spaces' },
    })

    expect(await screen.findByText('Use alphanumeric characters, hyphens, or underscores only for the MCP id.')).toBeInTheDocument()
    expect(addMcp).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation before allowing private network MCP URLs', async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<CustomMcpForm onSave={onSave} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'HTTP / SSE (remote)' }))
    const checkbox = await screen.findByLabelText(/Allow private network/)
    fireEvent.click(checkbox)

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(checkbox).not.toBeChecked()

    confirm.mockReturnValue(true)
    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
  })

  it('saves HTTP MCP headers and trusted approval mode through IPC', async () => {
    const addMcp = vi.fn(async () => true)
    installRendererTestCoworkApi({
      custom: {
        addMcp,
        listMcps: vi.fn(async () => []),
        listSkills: vi.fn(async () => []),
      },
    })

    render(<CustomMcpForm onSave={vi.fn()} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'HTTP / SSE (remote)' }))
    fireEvent.change(screen.getByPlaceholderText('e.g. github, jira, slack'), {
      target: { value: 'jira' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/sse'), {
      target: { value: 'https://mcp.example.com/sse' },
    })
    fireEvent.change(screen.getByPlaceholderText('Authorization'), {
      target: { value: 'Authorization' },
    })
    fireEvent.change(screen.getByPlaceholderText('Bearer ...'), {
      target: { value: 'Bearer test-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Trusted, auto-approve/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP' }))

    await waitFor(() => {
      expect(addMcp).toHaveBeenCalledWith(expect.objectContaining({
        name: 'jira',
        type: 'http',
        url: 'https://mcp.example.com/sse',
        headers: { Authorization: 'Bearer test-token' },
        permissionMode: 'allow',
      }))
    })
  })

  it('persists selected skill links by updating skill toolIds after saving the MCP', async () => {
    const addMcp = vi.fn(async () => true)
    const addSkill = vi.fn(async () => true)
    installRendererTestCoworkApi({
      custom: {
        addMcp,
        addSkill,
        listMcps: vi.fn(async () => []),
        listSkills: vi.fn(async () => [{
          name: 'triage',
          path: '/tmp/triage',
          directory: null,
          scope: 'machine',
          content: '---\nname: triage\ndescription: Triage\n---\n',
          files: [],
          toolIds: ['gmail'],
        }]),
      },
    })

    render(<CustomMcpForm onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByText('triage')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('e.g. github, jira, slack'), {
      target: { value: 'jira' },
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. npx, node, python'), {
      target: { value: 'node' },
    })
    fireEvent.click(screen.getByText('triage'))
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP' }))

    await waitFor(() => {
      expect(addSkill).toHaveBeenCalledWith(expect.objectContaining({
        name: 'triage',
        toolIds: ['gmail', 'jira'],
      }))
    })
  })
})
