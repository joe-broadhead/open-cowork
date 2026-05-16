import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentCatalog } from '@open-cowork/shared'
import { SkillLibraryTab } from './SkillLibraryTab'

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
  ],
  skills: [
    {
      name: 'repo-review',
      label: 'Repo Review',
      description: 'Review repository changes.',
      source: 'builtin',
      toolIds: ['github'],
    },
    {
      name: 'custom-brief',
      label: 'Custom Brief',
      description: 'Prepare a custom brief.',
      source: 'custom',
      toolIds: [],
    },
  ],
}

describe('SkillLibraryTab', () => {
  it('renders an empty-state prompt when no skills are available', () => {
    render(
      <SkillLibraryTab
        catalog={{ ...catalog, skills: [] }}
        selectedSkillNames={[]}
        selectedToolIds={[]}
        onToggle={() => undefined}
        onAutoAttachTools={() => undefined}
      />,
    )

    expect(screen.getByText('No skills available yet. Add a skill bundle from the Tools & Skills page.')).toBeInTheDocument()
  })

  it('toggles skills and offers to attach missing linked tools', () => {
    const onToggle = vi.fn()
    const onAutoAttachTools = vi.fn()
    render(
      <SkillLibraryTab
        catalog={catalog}
        selectedSkillNames={['repo-review', 'custom-brief']}
        selectedToolIds={[]}
        onToggle={onToggle}
        onAutoAttachTools={onAutoAttachTools}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Repo Review/i }))
    expect(onToggle).toHaveBeenCalledWith('repo-review')
    expect(screen.getByText('Custom')).toBeInTheDocument()
    expect(screen.getByText('Needs: GitHub')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add tools' }))
    expect(onAutoAttachTools).toHaveBeenCalledWith(['github'])
  })

  it('does not fire toggles in read-only mode', () => {
    const onToggle = vi.fn()
    render(
      <SkillLibraryTab
        catalog={catalog}
        selectedSkillNames={[]}
        selectedToolIds={[]}
        onToggle={onToggle}
        onAutoAttachTools={() => undefined}
        readOnly
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Repo Review/i }))
    expect(onToggle).not.toHaveBeenCalled()
  })
})
