import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'

describe('Sidebar', () => {
  it('keeps the upstream sidebar layout when no branding config is provided', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'New Thread' })).toBeTruthy()
    expect(screen.getByText('Connections')).toBeTruthy()
    expect(screen.queryByText('Acme AI')).toBeNull()
  })

  it('renders configured top and lower downstream branding surfaces', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'icon-text',
            icon: 'AC',
            title: 'Acme AI',
            subtitle: 'Private workspace',
            ariaLabel: 'Acme AI workspace',
          },
          lower: {
            text: 'Acme internal build',
            secondaryText: 'Support from Data Platform.',
            linkLabel: 'Get help',
            linkUrl: 'https://internal.acme.example/help',
          },
        }}
      />,
    )

    expect(screen.getByText('Acme AI')).toBeTruthy()
    expect(screen.getByText('Private workspace')).toBeTruthy()
    expect(screen.getByText('Acme internal build')).toBeTruthy()
    expect(screen.getByText('Support from Data Platform.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Get help' })).toHaveAttribute('href', 'https://internal.acme.example/help')
    expect(screen.getByText('Connections')).toBeTruthy()
  })

  it('supports icon-only, text-only, and logo-backed top branding variants', () => {
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'icon',
            icon: 'AC',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toBeTruthy()
    expect(screen.queryByText('Acme AI')).toBeNull()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'text',
            title: 'Acme AI',
            subtitle: 'Private workspace',
          },
        }}
      />,
    )

    expect(screen.getByText('Acme AI')).toBeTruthy()
    expect(screen.getByText('Private workspace')).toBeTruthy()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo-text',
            logoDataUrl: 'data:image/png;base64,AAAA',
            title: 'Acme AI',
          },
        }}
      />,
    )

    expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeTruthy()
    expect(screen.getByText('Acme AI')).toBeTruthy()
  })

  it('does not render unsafe downstream sidebar links', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          lower: {
            text: 'Acme internal build',
            linkLabel: 'Unsafe help',
            linkUrl: 'http://internal.acme.example/help',
          },
        }}
      />,
    )

    expect(screen.getByText('Acme internal build')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Unsafe help' })).toBeNull()
  })
})
