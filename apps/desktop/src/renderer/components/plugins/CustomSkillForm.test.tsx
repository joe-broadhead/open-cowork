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

  it('persists selected required tools into the skill bundle draft', async () => {
    const addSkill = vi.fn(async () => true)
    installRendererTestCoworkApi({
      capabilities: {
        tools: vi.fn(async () => [{
          id: 'gmail',
          name: 'Gmail',
          kind: 'mcp',
          namespace: 'gmail',
          source: 'custom',
          origin: 'custom',
          description: 'Read and write mail.',
          icon: 'gmail',
          patterns: ['mcp__gmail__*'],
          agentNames: [],
        }]),
      },
      custom: {
        listSkills: vi.fn(async () => []),
        addSkill,
        selectSkillDirectoryImport: vi.fn(async () => null),
        importSkillDirectory: vi.fn(async () => null),
      },
    })

    render(<CustomSkillForm onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByRole('button', { name: 'Gmail' })).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('e.g. code-review, data-pipeline'), {
      target: { value: 'trusted-skill' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))

    await waitFor(() => {
      expect(addSkill).toHaveBeenCalledWith(expect.objectContaining({
        name: 'trusted-skill',
        toolIds: ['gmail'],
      }))
    })
  })

  it('blocks unsafe additional file paths before save', async () => {
    const addSkill = vi.fn(async () => true)
    installCustomSkillFormApi({ addSkill })

    render(<CustomSkillForm onSave={vi.fn()} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('e.g. code-review, data-pipeline'), {
      target: { value: 'trusted-skill' },
    })
    fireEvent.click(screen.getByRole('button', { name: '+ Add file' }))
    fireEvent.change(screen.getByPlaceholderText('references/example.md'), {
      target: { value: '../secret.md' },
    })

    expect(await screen.findByText('"../secret.md" is not a safe relative path inside the skill bundle.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add skill' })).toBeDisabled()
    expect(addSkill).not.toHaveBeenCalled()
  })

  it('surfaces main-process save errors without closing the form', async () => {
    const addSkill = vi.fn(async () => {
      throw new Error('Bundle is too large.')
    })
    const onSave = vi.fn()
    installCustomSkillFormApi({ addSkill })

    render(<CustomSkillForm onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('e.g. code-review, data-pipeline'), {
      target: { value: 'trusted-skill' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))

    expect(await screen.findByText('Bundle is too large.')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
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
