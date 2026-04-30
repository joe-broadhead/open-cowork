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
            logoUrl: 'open-cowork-asset://branding/acme-logo.svg',
            title: 'Acme AI',
          },
        }}
      />,
    )

    expect(document.querySelector('img[src="open-cowork-asset://branding/acme-logo.svg"]')).toHaveStyle({
      height: '28px',
      width: '28px',
    })
    expect(screen.getByText('Acme AI')).toBeTruthy()
  })

  it('applies configured top branding media size, fit, and icon-only alignment', () => {
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            logoUrl: 'open-cowork-asset://branding/acme-logo.svg',
            mediaSize: 40,
            mediaFit: 'horizontal',
            mediaAlign: 'end',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toHaveClass('justify-end')
    expect(document.querySelector('img[src="open-cowork-asset://branding/acme-logo.svg"]')).toHaveStyle({
      width: '40px',
      height: 'auto',
      maxHeight: '40px',
    })

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            logoUrl: 'open-cowork-asset://branding/acme-logo.svg',
            mediaSize: 36,
            mediaFit: 'vertical',
            mediaAlign: 'start',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toHaveClass('justify-start')
    expect(document.querySelector('img[src="open-cowork-asset://branding/acme-logo.svg"]')).toHaveStyle({
      height: '36px',
      width: 'auto',
    })
  })

  it('clamps direct top branding media sizes to renderer-safe bounds', () => {
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'icon',
            icon: 'AC',
            mediaSize: 8,
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByText('AC')).toHaveStyle({
      width: '16px',
      height: '16px',
    })

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'icon',
            icon: 'AC',
            mediaSize: 120,
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByText('AC')).toHaveStyle({
      width: '96px',
      height: '96px',
    })
  })

  it('keeps legacy logo data URLs as a fallback', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            logoDataUrl: 'data:image/png;base64,AAAA',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeTruthy()
  })

  it('prefers resolved logo URLs over legacy logo data URLs', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            logoUrl: 'open-cowork-asset://branding/acme-logo.svg',
            logoDataUrl: 'data:image/png;base64,AAAA',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(document.querySelector('img[src="open-cowork-asset://branding/acme-logo.svg"]')).toBeTruthy()
    expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeNull()
  })

  it('falls back instead of rendering an empty top-brand card for incompatible variants', () => {
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'text',
            icon: 'AC',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toBeTruthy()
    expect(screen.getByText('AC')).toBeTruthy()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            title: 'Acme AI',
          },
        }}
      />,
    )

    expect(screen.getByText('Acme AI')).toBeTruthy()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo-text',
            icon: 'AC',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toBeTruthy()
    expect(screen.getByText('AC')).toBeTruthy()
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
