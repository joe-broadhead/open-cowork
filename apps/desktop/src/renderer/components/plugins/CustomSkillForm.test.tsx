import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../../test/setup'
import { CustomSkillForm } from './CustomSkillForm'

function installCustomSkillFormApi(overrides: {
  addSkill?: ReturnType<typeof vi.fn>
  importSkillDirectory?: ReturnType<typeof vi.fn>
  selectSkillDirectoryImport?: ReturnType<typeof vi.fn>
} = {}) {
  return installRendererTestCoworkApi({
    capabilities: {
      tools: vi.fn(async () => []),
    },
    custom: {
      listSkills: vi.fn(async () => []),
      addSkill: overrides.addSkill || vi.fn(async () => true),
      selectSkillDirectoryImport: overrides.selectSkillDirectoryImport || vi.fn(async () => null),
      importSkillDirectory: overrides.importSkillDirectory || vi.fn(async () => ({
        name: 'imported-skill',
        path: '/tmp/imported-skill',
        directory: null,
        scope: 'machine',
        toolIds: [],
      })),
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CustomSkillForm', () => {
  it('shows an explicit unsigned skill trust warning', () => {
    installCustomSkillFormApi()

    render(<CustomSkillForm onSave={vi.fn()} onCancel={vi.fn()} />)

    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('Unsigned skill bundle')
    expect(note).toHaveTextContent('Only save or import bundles you wrote or trust')
  })

  it('does not close when main cancels a new unsigned skill bundle save', async () => {
    const addSkill = vi.fn(async () => false)
    const onSave = vi.fn()
    installCustomSkillFormApi({ addSkill })

    render(<CustomSkillForm onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('e.g. code-review, data-pipeline'), {
      target: { value: 'trusted-skill' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))

    await waitFor(() => {
      expect(addSkill).toHaveBeenCalledWith(expect.objectContaining({
        name: 'trusted-skill',
        scope: 'machine',
      }))
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves a new skill after main accepts the unsigned skill warning', async () => {
    const addSkill = vi.fn(async () => true)
    const onSave = vi.fn()
    installCustomSkillFormApi({ addSkill })

    render(<CustomSkillForm onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('e.g. code-review, data-pipeline'), {
      target: { value: 'trusted-skill' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))

    await waitFor(() => {
      expect(addSkill).toHaveBeenCalledWith(expect.objectContaining({
        name: 'trusted-skill',
        scope: 'machine',
      }))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('does not close when main cancels a directory import', async () => {
    const importSkillDirectory = vi.fn(async () => null)
    const onSave = vi.fn()
    installCustomSkillFormApi({
      importSkillDirectory,
      selectSkillDirectoryImport: vi.fn(async () => ({
        token: 'selection-token',
        directory: '/tmp/imported-skill',
      })),
    })

    render(<CustomSkillForm onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Import directory' }))

    await waitFor(() => {
      expect(importSkillDirectory).toHaveBeenCalledWith('selection-token', expect.objectContaining({
        scope: 'machine',
      }))
    })
    expect(onSave).not.toHaveBeenCalled()
  })
})
