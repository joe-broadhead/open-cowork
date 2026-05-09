import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PluginIcon } from './PluginIcon'

describe('PluginIcon', () => {
  it('renders known provider glyphs at the requested size', () => {
    const { container } = render(<PluginIcon icon="github" size={48} />)

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).toHaveStyle({ width: '48px', height: '48px' })
    expect(wrapper.querySelector('svg')).toBeTruthy()
  })

  it.each([
    'google',
    'nova',
    'atlassian',
    'amplitude',
    'charts',
    'github',
    'perplexity',
    'github-mcp',
    'google-sheets',
    'google-docs',
    'google-slides',
    'google-drive',
    'gmail',
    'google-gmail',
    'google-calendar',
    'google-chat',
    'google-people',
    'google-forms',
    'google-keep',
    'google-tasks',
    'google-appscript',
    'search',
    'code',
  ])('renders the %s icon renderer', (icon) => {
    const { container } = render(<PluginIcon icon={icon} />)

    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('renders two-character custom icons literally', () => {
    render(<PluginIcon icon="db" />)

    expect(screen.getByText('db')).toBeInTheDocument()
  })

  it('falls back to the uppercase initial for long unknown icons', () => {
    render(<PluginIcon icon="warehouse" size={30} />)

    expect(screen.getByText('W')).toHaveStyle({ fontSize: '12px' })
  })
})
