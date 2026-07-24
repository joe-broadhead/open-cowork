import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ProductMcpLinkPanel } from './ProductMcpLinkPanel'

describe('ProductMcpLinkPanel', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows missing empty state when binaries are absent', async () => {
    const productMcpProbe = vi.fn(async () => [
      {
        kind: 'gateway' as const,
        name: 'cowork-gateway',
        label: 'Gateway',
        found: false,
        linked: false,
        installHint: 'Install Gateway standalone.',
        docsPath: 'docs/opencode-gateway.md',
      },
      {
        kind: 'wiki' as const,
        name: 'cowork-wiki',
        label: 'Wiki',
        found: false,
        linked: false,
        installHint: 'Install Wiki standalone.',
        docsPath: 'docs/openwiki.md',
      },
    ])
    installRendererTestCoworkApi({
      custom: { productMcpProbe, productMcpLink: vi.fn(), removeMcp: vi.fn() },
    })

    render(<ProductMcpLinkPanel />)
    expect(await screen.findByText('Link local durable Gateway / Wiki CLIs')).toBeTruthy()
    expect(screen.getAllByText('Not found on PATH.').length).toBe(2)
    expect(screen.getByText(/Install Gateway standalone/)).toBeTruthy()
  })

  it('links gateway when binary is found', async () => {
    const productMcpProbe = vi.fn()
      .mockResolvedValueOnce([
        {
          kind: 'gateway' as const,
          name: 'cowork-gateway',
          label: 'Gateway',
          found: true,
          resolvedBinary: '/usr/local/bin/cowork-gateway',
          linked: false,
          installHint: '',
          docsPath: 'docs/opencode-gateway.md',
        },
        {
          kind: 'wiki' as const,
          name: 'cowork-wiki',
          label: 'Wiki',
          found: false,
          linked: false,
          installHint: 'Install Wiki standalone.',
          docsPath: 'docs/openwiki.md',
        },
      ])
      .mockResolvedValueOnce([
        {
          kind: 'gateway' as const,
          name: 'cowork-gateway',
          label: 'Gateway',
          found: true,
          resolvedBinary: '/usr/local/bin/cowork-gateway',
          linked: true,
          installHint: '',
          docsPath: 'docs/opencode-gateway.md',
        },
        {
          kind: 'wiki' as const,
          name: 'cowork-wiki',
          label: 'Wiki',
          found: false,
          linked: false,
          installHint: 'Install Wiki standalone.',
          docsPath: 'docs/openwiki.md',
        },
      ])
    const productMcpLink = vi.fn(async () => ({
      ok: true as const,
      name: 'cowork-gateway',
      label: 'Gateway',
      description: 'linked',
      resolvedBinary: '/usr/local/bin/cowork-gateway',
      customMcp: {
        scope: 'machine' as const,
        name: 'cowork-gateway',
        type: 'stdio' as const,
        command: '/usr/local/bin/cowork-gateway',
      },
      saved: true,
    }))
    installRendererTestCoworkApi({
      custom: { productMcpProbe, productMcpLink, removeMcp: vi.fn() },
    })

    const onChanged = vi.fn()
    render(<ProductMcpLinkPanel onChanged={onChanged} />)
    expect(await screen.findByText(/Found:/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]!)
    await waitFor(() => {
      expect(productMcpLink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gateway' }))
    })
    await waitFor(() => {
      expect(screen.getByText(/Linked as custom MCP/)).toBeTruthy()
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('requires wiki root before linking wiki', async () => {
    installRendererTestCoworkApi({
      custom: {
        productMcpProbe: vi.fn(async () => [
          {
            kind: 'gateway' as const,
            name: 'cowork-gateway',
            label: 'Gateway',
            found: false,
            linked: false,
            installHint: '',
            docsPath: 'docs/opencode-gateway.md',
          },
          {
            kind: 'wiki' as const,
            name: 'cowork-wiki',
            label: 'Wiki',
            found: true,
            resolvedBinary: '/usr/local/bin/cowork-wiki',
            linked: false,
            installHint: '',
            docsPath: 'docs/openwiki.md',
          },
        ]),
        productMcpLink: vi.fn(),
        removeMcp: vi.fn(),
      },
    })

    render(<ProductMcpLinkPanel />)
    await screen.findByTestId('product-mcp-wiki')
    const wikiLink = screen.getAllByRole('button', { name: 'Link' }).find((button) => {
      return button.closest('[data-testid="product-mcp-wiki"]')
    })
    expect(wikiLink).toBeTruthy()
    expect(wikiLink).toBeDisabled()
  })
})
