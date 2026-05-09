import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { McpStatus } from './McpStatus'

function setConnections() {
  useSessionStore.setState({
    mcpConnections: [
      { name: 'charts', connected: true },
      { name: 'github', connected: false, rawStatus: 'disconnected' },
      { name: 'google-drive', connected: false, rawStatus: 'auth_required' },
    ],
  })
}

describe('McpStatus', () => {
  it('renders nothing without MCP connections', () => {
    useSessionStore.setState({ mcpConnections: [] })

    const { container } = render(<McpStatus />)

    expect(container).toBeEmptyDOMElement()
  })

  it('summarizes and expands MCP connection state', () => {
    setConnections()
    render(<McpStatus />)

    expect(screen.getByRole('button', { name: /1 2 3 connections/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /3 connections/i }))
    expect(screen.getByText('charts')).toBeInTheDocument()
    expect(screen.getByText('github')).toBeInTheDocument()
    expect(screen.getByText('auth required')).toBeInTheDocument()
  })

  it('uses connect for disconnected MCPs and auth for auth-required MCPs', async () => {
    const connect = vi.fn(async () => undefined)
    const auth = vi.fn(async () => true)
    installRendererTestCoworkApi({ mcp: { connect, auth } })
    setConnections()
    render(<McpStatus />)

    fireEvent.click(screen.getByRole('button', { name: /3 connections/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Re-auth' }))

    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith('github')
      expect(auth).toHaveBeenCalledWith('google-drive')
    })
  })

  it('clears reconnecting state after failed reconnect attempts', async () => {
    const connect = vi.fn(async () => {
      throw new Error('offline')
    })
    installRendererTestCoworkApi({ mcp: { connect } })
    useSessionStore.setState({
      mcpConnections: [{ name: 'github', connected: false, rawStatus: 'disconnected' }],
    })
    render(<McpStatus />)

    fireEvent.click(screen.getByRole('button', { name: /1 connections/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled()
  })
})
