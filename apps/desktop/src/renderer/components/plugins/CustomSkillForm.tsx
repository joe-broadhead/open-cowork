import { useEffect, useMemo, useState } from 'react'
import type { CapabilityTool, CustomSkillConfig } from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'
import { PluginIcon } from './PluginIcon'

function extractFrontmatterField(content: string, field: string) {
  const match = content.match(new RegExp(`^---\\n[\\s\\S]*?\\n${field}:\\s*["']?(.+?)["']?\\s*(?:\\n|$)`, 'm'))
  return match?.[1]?.trim() || ''
}

function isSafeRelativePath(value: string) {
  if (!value.trim()) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..' || segment === '')
}

const VALID_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const DEFAULT_SKILL_CONTENT = `---
name: my-skill
description: "Describe what this skill does and when to use it."
compatibility: opencode
---

# My Skill

## Purpose

Describe the skill's job and the user problem it solves.

## Workflow

1. Step one
2. Step two

## Guardrails

- Add any important constraints or misuse cases here.
`

export function CustomSkillForm({
  onSave,
  onCancel,
  projectDirectory,
  existing,
}: {
  onSave: () => void
  onCancel: () => void
  projectDirectory?: string | null
  // When provided, the form opens in edit mode — pre-populated from the
  // existing bundle and overwriting it on save. Name is read-only in
  // edit mode because the bundle's directory id is the storage key.
  existing?: CustomSkillConfig | null
}) {
  const isEditing = Boolean(existing)
  const [scope, setScope] = useState<'machine' | 'project'>(
    existing?.scope || (projectDirectory ? 'project' : 'machine'),
  )
  const [projectTargetDirectory, setProjectTargetDirectory] = useState<string | null>(
    existing?.scope === 'project' ? existing?.directory || null : projectDirectory || null,
  )
  const [name, setName] = useState(existing?.name || '')
  const [content, setContent] = useState(existing?.content || DEFAULT_SKILL_CONTENT)
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>(existing?.files?.map((file) => ({ ...file })) || [])
  // Ids of tools this skill needs. Persisted into SKILL.md frontmatter
  // on save; loaded back from frontmatter when the form is used to edit
  // an existing skill. The agent builder reads this list via the
  // capability catalog to show a "skill needs these tools" hint when a
  // user attaches this skill to an agent without the required tools.
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>(existing?.toolIds || [])
  const [availableTools, setAvailableTools] = useState<CapabilityTool[]>([])
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [existingNames, setExistingNames] = useState<string[]>([])
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    if (projectDirectory) {
      setProjectTargetDirectory(projectDirectory)
    }
  }, [projectDirectory])

  useEffect(() => {
    const options = scope === 'project' && projectTargetDirectory
      ? { directory: projectTargetDirectory }
      : undefined

    window.coworkApi.custom.listSkills(options).then((skills) => {
      setExistingNames((skills || []).map((skill) => skill.name))
    }).catch(() => setExistingNames([]))
  }, [projectTargetDirectory, scope])

  // Populate the tool picker from the live capability catalog so users see
  // both bundled tools (charts, skills) and custom MCPs they've added.
  useEffect(() => {
    const options = scope === 'project' && projectTargetDirectory
      ? { directory: projectTargetDirectory }
      : undefined
    window.coworkApi.capabilities.tools(options)
      .then((tools) => setAvailableTools(tools || []))
      .catch(() => setAvailableTools([]))
  }, [projectTargetDirectory, scope])

  const frontmatterName = useMemo(() => extractFrontmatterField(content, 'name'), [content])
  const frontmatterDescription = useMemo(() => extractFrontmatterField(content, 'description'), [content])
  const populatedFiles = useMemo(
    () => files.filter((file) => file.path.trim() || file.content.trim()),
    [files],
  )

  const issues = useMemo(() => {
    const next: string[] = []
    const normalizedName = name.trim()
    if (!normalizedName) {
      next.push('Add a skill directory id so the bundle can be saved.')
    }
    if (normalizedName && !VALID_SKILL_NAME.test(normalizedName)) {
      next.push('Skill directory ids must use 1-64 lowercase letters, numbers, and single hyphens only.')
    }
    if (normalizedName && !isEditing && existingNames.includes(normalizedName)) {
      next.push(`A custom skill bundle named "${normalizedName}" already exists.`)
    }
    if (scope === 'project' && !projectTargetDirectory) {
      next.push('Choose a project directory for this project-scoped skill bundle.')
    }
    if (!content.trim()) {
      next.push('Add SKILL.md content.')
    }
    if (!frontmatterName) {
      next.push('Add a frontmatter name in SKILL.md.')
    }
    if (!frontmatterDescription) {
      next.push('Add a frontmatter description in SKILL.md.')
    }
    for (const file of populatedFiles) {
      if (!file.path.trim()) {
        next.push('Every additional file needs a relative path.')
        break
      }
      if (!isSafeRelativePath(file.path)) {
        next.push(`"${file.path}" is not a safe relative path inside the skill bundle.`)
        break
      }
    }
    return next
  }, [content, existingNames, frontmatterDescription, frontmatterName, isEditing, name, populatedFiles, projectTargetDirectory, scope])

  const chooseProjectDirectory = async () => {
    const selected = await window.coworkApi.dialog.selectDirectory()
    if (!selected) return
    setProjectTargetDirectory(selected)
    setScope('project')
  }

  const handleSave = async () => {
    if (issues.length > 0) return
    setSaving(true)
    await window.coworkApi.custom.addSkill({
      scope,
      directory: scope === 'project' ? projectTargetDirectory || null : null,
      name: name.trim(),
      content,
      files: populatedFiles
        .filter((file) => file.path.trim() && file.content.trim())
        .map((file) => ({ path: file.path.trim(), content: file.content })),
      toolIds: selectedToolIds,
    })
    setSaving(false)
    onSave()
  }

  const toggleTool = (toolId: string) => {
    setSelectedToolIds((current) => (
      current.includes(toolId)
        ? current.filter((id) => id !== toolId)
        : [...current, toolId]
    ))
  }

  const handleImportDirectory = async () => {
    setImportError(null)
    setImporting(true)
    try {
      const selection = await window.coworkApi.custom.selectSkillDirectoryImport()
      if (!selection) return
      await window.coworkApi.custom.importSkillDirectory(selection.token, {
        name,
        scope,
        directory: scope === 'project' ? projectTargetDirectory || null : null,
      })
      onSave()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not import this skill directory.'
      setImportError(message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-8 py-8">
        <button onClick={onCancel} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          {t('capabilities.title', 'Capabilities')}
        </button>

        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text mb-1">
              {isEditing ? t('skillForm.titleEdit', 'Edit skill bundle — {{name}}', { name: existing?.name || '' }) : t('skillForm.titleAdd', 'Add skill bundle')}
            </h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">
              {t('skillForm.subtitle', 'Create a real OpenCode skill bundle with `SKILL.md` plus any supporting references, examples, or templates it needs.')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isEditing ? (
              <button
                onClick={handleImportDirectory}
                disabled={importing}
                className="px-3 py-1.5 rounded-lg text-[12px] text-accent border border-border-subtle cursor-pointer disabled:opacity-40"
              >
                {importing ? t('skillForm.importing', 'Importing…') : t('skillForm.importDirectory', 'Import directory')}
              </button>
            ) : null}
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">{t('common.cancel', 'Cancel')}</button>
            <button
              onClick={handleSave}
              disabled={issues.length > 0 || saving}
              className="px-4 py-2 rounded-lg text-[13px] font-medium bg-accent cursor-pointer disabled:opacity-40"
              style={{ color: 'var(--color-accent-foreground)' }}
            >
              {saving ? t('mcpForm.saving', 'Saving…') : isEditing ? t('mcpForm.saveChanges', 'Save changes') : t('skillForm.addSkill', 'Add skill')}
            </button>
          </div>
        </div>

        {issues.length > 0 ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3">
            <div className="text-[12px] font-medium text-text mb-2">{t('mcpForm.completeBeforeSave', 'Complete these before saving')}</div>
            <div className="flex flex-col gap-1 text-[11px] text-text-muted">
              {issues.map((issue) => (
                <div key={issue}>{issue}</div>
              ))}
            </div>
          </div>
        ) : null}

        {importError ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3 text-[11px] text-red">
            {importError}
          </div>
        ) : null}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-5">
          <div className="flex flex-col gap-5">
            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-[14px] font-semibold text-text mb-3">{t('mcpForm.whereToSave', 'Where to save it')}</div>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                <button
                  onClick={() => setScope('machine')}
                  className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${scope === 'machine' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                >
                  Cowork only (private)
                </button>
                <button
                  onClick={() => setScope('project')}
                  className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${scope === 'project' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                >
                  Project (Cowork only)
                </button>
              </div>
              <div className="mt-2 text-[11px] text-text-muted">
                {scope === 'project'
                  ? (projectTargetDirectory || 'Choose a project directory to save this into Cowork’s private project skill bundle directory.')
                  : 'Saved into Cowork’s private machine skill directory. This stays separate from your normal CLI OpenCode machine config.'}
              </div>
              {scope === 'project' ? (
                <button
                  onClick={() => void chooseProjectDirectory()}
                  className="mt-3 px-3 py-1.5 rounded-lg text-[11px] font-medium border border-border-subtle text-accent hover:bg-surface-hover cursor-pointer"
                >
                  {projectTargetDirectory ? 'Change directory' : 'Choose directory'}
                </button>
              ) : null}
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-[14px] font-semibold text-text mb-3">{t('skillForm.bundleIdentity', 'Bundle identity')}</div>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-muted">{t('skillForm.skillDirectory', 'Skill directory')}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('skillForm.skillDirectoryPlaceholder', 'e.g. code-review, data-pipeline')}
                  disabled={isEditing}
                  className={`w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border ${isEditing ? 'opacity-60 cursor-not-allowed' : ''}`}
                />
                <span className="text-[10px] text-text-muted">{t('skillForm.skillDirectoryHint', 'Saved as a skill bundle directory. Keep it lowercase and stable.')}</span>
              </label>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-[14px] font-semibold text-text mb-3">SKILL.md</div>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={24}
                className="w-full min-h-[560px] px-3 py-2 rounded-lg text-[11px] font-mono bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y leading-relaxed"
              />
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="mb-3">
                <div className="text-[14px] font-semibold text-text">{t('skillForm.requiredTools', 'Required tools')}</div>
                <div className="text-[11px] text-text-muted mt-1">
                  When you attach this skill to an agent, the agent builder surfaces a
                  <span className="font-mono"> Needs tools </span> hint with a one-click
                  button to add anything listed here that the agent doesn't already have.
                  Persisted in SKILL.md frontmatter as <span className="font-mono">toolIds</span>.
                </div>
              </div>
              {availableTools.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {availableTools.map((tool) => {
                    const selected = selectedToolIds.includes(tool.id)
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => toggleTool(tool.id)}
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] border cursor-pointer transition-colors"
                        style={{
                          color: selected ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                          background: selected
                            ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
                            : 'var(--color-elevated)',
                          borderColor: selected
                            ? 'color-mix(in srgb, var(--color-accent) 40%, transparent)'
                            : 'var(--color-border-subtle)',
                        }}
                        title={tool.description}
                      >
                        <PluginIcon icon={tool.icon || tool.namespace || tool.id} size={14} />
                        {tool.name}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="text-[11px] text-text-muted italic">
                  No tools discovered yet. Add a custom MCP from the Capabilities page and it
                  will show up here.
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <div className="text-[14px] font-semibold text-text">{t('skillForm.additionalFiles', 'Additional files')}</div>
                  <div className="text-[11px] text-text-muted mt-1">Add optional references, examples, templates, or helper files inside this bundle.</div>
                </div>
                <button
                  onClick={() => setFiles((current) => [...current, { path: '', content: '' }])}
                  className="text-[11px] text-accent cursor-pointer"
                >
                  + Add file
                </button>
              </div>

              {files.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {files.map((file, index) => (
                    <div key={index} className="rounded-xl border border-border-subtle bg-elevated p-3">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div className="text-[11px] text-text-secondary">File {index + 1}</div>
                        <button
                          onClick={() => setFiles((current) => current.filter((_, entryIndex) => entryIndex !== index))}
                          className="text-[11px] text-text-muted hover:text-red cursor-pointer"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="flex flex-col gap-2">
                        <input
                          type="text"
                          value={file.path}
                          onChange={(event) => setFiles((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, path: event.target.value } : entry))}
                          placeholder="references/example.md"
                          className="w-full px-3 py-2 rounded-lg text-[12px] bg-surface border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
                        />
                        <textarea
                          value={file.content}
                          onChange={(event) => setFiles((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, content: event.target.value } : entry))}
                          rows={8}
                          placeholder={t('skillForm.fileContents', 'File contents')}
                          className="w-full min-h-[180px] px-3 py-2 rounded-lg text-[11px] font-mono bg-surface border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y leading-relaxed"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-border-subtle border-dashed px-4 py-6 text-[12px] text-text-muted text-center">
                  No extra files yet. Keep the bundle simple unless a reference, example, or template genuinely helps.
                </div>
              )}
            </div>
          </div>

          <div className="xl:sticky xl:top-6 self-start flex flex-col gap-4">
            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[12px] font-semibold text-text mb-3">{t('skillForm.bundlePreview', 'Bundle preview')}</div>
              <div className="rounded-xl border border-border-subtle bg-elevated p-4 mb-4">
                <div className="text-[11px] text-text-secondary mb-1">{t('skillForm.bundleId', 'Bundle id')}</div>
                <div className="text-[13px] font-medium text-text">{name.trim() || 'new-skill'}</div>
                <div className="mt-3 text-[11px] text-text-secondary mb-1">{t('skillForm.frontmatterName', 'Frontmatter name')}</div>
                <div className="text-[12px] text-text">{frontmatterName || 'Missing'}</div>
                <div className="mt-3 text-[11px] text-text-secondary mb-1">{t('mcpForm.description', 'Description')}</div>
                <div className="text-[11px] text-text-muted leading-relaxed">{frontmatterDescription || 'Add a frontmatter description so the bundle is discoverable.'}</div>
              </div>

              <div className="flex flex-col gap-3 text-[11px] text-text-muted">
                <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
                  <div className="text-text-secondary mb-1">{t('skillForm.whatWillBeSaved', 'What will be saved')}</div>
                  <div>`SKILL.md` + {populatedFiles.length} additional {populatedFiles.length === 1 ? 'file' : 'files'}</div>
                </div>
                <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
                  <div className="text-text-secondary mb-2">{t('capabilities.bundleFiles', 'Bundle files')}</div>
                  {populatedFiles.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {populatedFiles.map((file) => (
                        <div key={file.path || file.content} className="text-[10px] text-text-muted">{file.path || 'Unnamed file'}</div>
                      ))}
                    </div>
                  ) : (
                    <div>{t('skillForm.noExtraBundleFiles', 'No extra bundle files yet.')}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-5 text-[10px] text-text-muted">{getBrandName()} reloads the runtime automatically after saving.</p>
      </div>
    </div>
  )
}
