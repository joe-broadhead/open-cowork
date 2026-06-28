import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RestrictedState } from './RestrictedState'

describe('RestrictedState', () => {
  it('renders the canonical shield affordance with title and body', () => {
    const { container } = render(
      <RestrictedState
        title="Switch to Local for desktop Knowledge"
        body="Open Cloud Web to review or capture Knowledge for a Cloud workspace."
      />,
    )

    expect(screen.getByText('Switch to Local for desktop Knowledge')).toBeInTheDocument()
    expect(
      screen.getByText('Open Cloud Web to review or capture Knowledge for a Cloud workspace.'),
    ).toBeInTheDocument()
    // Defaults to the protected/shield glyph so every restricted panel reads the same.
    expect(container.querySelector('.lucide-shield-check')).toBeInTheDocument()
  })

  it('renders an optional reason line and action slot', () => {
    render(
      <RestrictedState
        title="Restricted here"
        body="This workspace is cloud-managed."
        reason="Cloud workspace gating is enforced by your organisation."
        action={<button type="button">Open Cloud Web</button>}
      />,
    )

    expect(
      screen.getByText('Cloud workspace gating is enforced by your organisation.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Cloud Web' })).toBeInTheDocument()
  })

  it('honours an explicit icon override', () => {
    const { container } = render(
      <RestrictedState icon="info" title="Heads up" body="Custom glyph." />,
    )

    expect(container.querySelector('.lucide-info')).toBeInTheDocument()
    expect(container.querySelector('.lucide-shield-check')).not.toBeInTheDocument()
  })
})
