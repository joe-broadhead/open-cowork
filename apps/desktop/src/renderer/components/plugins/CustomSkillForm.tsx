import { useEffect, useMemo, useState } from 'react'

function extractFrontmatterField(content: string, field: string) {
  const match = content.match(new RegExp(`^---\\n[\\s\\S]*?\\n${field}:\\s*["']?(.+?)["']?\\s*(?:\\n|$)`, 'm'))
  return match?.[1]?.trim() || ''
}

function isSafeRelativePath(value: string) {
  if (!value.trim()) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..' || segment === '')
}

export function CustomSkillForm({
  onSave,
  onCancel,
  projectDirectory,
}: {
  onSave: () => void
  onCancel: () => void
  projectDirectory?: string | null
}) {
  const [scope, setScope] = useState<'machine' | 'project'>(projectDirectory ? 'project' : 'machine')
  const [name, setName] = useState('')
  const [content, setContent] = useState(`---
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
`)
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([])
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [existingNames, setExistingNames] = useState<string[]>([])
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    window.openCowork.custom.listSkills(projectDirectory ? { directory: projectDirectory } : undefined).then((skills) => {
      setExistingNames((skills || []).map((skill) => skill.name))
    }).catch(() => setExistingNames([]))
  }, [projectDirectory])

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
    if (normalizedName && existingNames.includes(normalizedName)) {
      next.push(`A custom skill bundle named "${normalizedName}" already exists.`)
    }
    if (scope === 'project' && !projectDirectory) {
      next.push('Project scope requires an active project thread.')
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
  }, [content, existingNames, frontmatterDescription, frontmatterName, name, populatedFiles, projectDirectory, scope])

  const handleSave = async () => {
    if (issues.length > 0) return
    setSaving(true)
    await window.openCowork.custom.addSkill({
      scope,
      directory: scope === 'project' ? projectDirectory || null : null,
      name: name.trim(),
      content,
      files: populatedFiles
        .filter((file) => file.path.trim() && file.content.trim())
        .map((file) => ({ path: file.path.trim(), content: file.content })),
    })
    setSaving(false)
    onSave()
  }

  const handleImportDirectory = async () => {
    setImportError(null)
    setImporting(true)
    try {
      const directory = await window.openCowork.dialog.selectDirectory()
      if (!directory) return
      await window.openCowork.custom.importSkillDirectory(directory, {
        name,
        scope,
        directory: scope === 'project' ? projectDirectory || null : null,
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
          Capabilities
        </button>

        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text mb-1">Add skill bundle</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">
              Create a real OpenCode skill bundle with `SKILL.md` plus any supporting references, examples, or templates it needs.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleImportDirectory}
              disabled={importing}
              className="px-3 py-1.5 rounded-lg text-[12px] text-accent border border-border-subtle cursor-pointer disabled:opacity-40"
            >
              {importing ? 'Importing…' : 'Import directory'}
            </button>
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">Cancel</button>
            <button
              onClick={handleSave}
              disabled={issues.length > 0 || saving}
              className="px-4 py-2 rounded-lg text-[13px] font-medium bg-accent cursor-pointer disabled:opacity-40"
              style={{ color: 'var(--color-accent-foreground)' }}
            >
              {saving ? 'Saving…' : 'Add skill'}
            </button>
          </div>
        </div>

        {issues.length > 0 ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3">
            <div className="text-[12px] font-medium text-text mb-2">Complete these before saving</div>
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
              <div className="text-[14px] font-semibold text-text mb-3">Where to save it</div>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                <button
                  onClick={() => setScope('machine')}
                  className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${scope === 'machine' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                >
                  This machine
                </button>
                <button
                  onClick={() => setScope('project')}
                  disabled={!projectDirectory}
                  className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${scope === 'project' ? 'bg-surface-active text-text' : 'text-text-muted'} disabled:opacity-40`}
                >
                  This project
                </button>
              </div>
              <div className="mt-2 text-[11px] text-text-muted">
                {scope === 'project'
                  ? (projectDirectory || 'Open a project thread first to save a project-scoped skill bundle.')
                  : 'Saved into your machine-scoped OpenCode skills directory for Open Cowork.'}
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-[14px] font-semibold text-text mb-3">Bundle identity</div>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-muted">Skill directory</span>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. code-review, data-pipeline"
                  className="w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
                />
                <span className="text-[10px] text-text-muted">Saved as a skill bundle directory. Keep it lowercase and stable.</span>
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
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <div className="text-[14px] font-semibold text-text">Additional files</div>
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
                          placeholder="File contents"
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
              <div className="text-[12px] font-semibold text-text mb-3">Bundle preview</div>
              <div className="rounded-xl border border-border-subtle bg-elevated p-4 mb-4">
                <div className="text-[11px] text-text-secondary mb-1">Bundle id</div>
                <div className="text-[13px] font-medium text-text">{name.trim() || 'new-skill'}</div>
                <div className="mt-3 text-[11px] text-text-secondary mb-1">Frontmatter name</div>
                <div className="text-[12px] text-text">{frontmatterName || 'Missing'}</div>
                <div className="mt-3 text-[11px] text-text-secondary mb-1">Description</div>
                <div className="text-[11px] text-text-muted leading-relaxed">{frontmatterDescription || 'Add a frontmatter description so the bundle is discoverable.'}</div>
              </div>

              <div className="flex flex-col gap-3 text-[11px] text-text-muted">
                <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
                  <div className="text-text-secondary mb-1">What will be saved</div>
                  <div>`SKILL.md` + {populatedFiles.length} additional {populatedFiles.length === 1 ? 'file' : 'files'}</div>
                </div>
                <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
                  <div className="text-text-secondary mb-2">Bundle files</div>
                  {populatedFiles.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {populatedFiles.map((file) => (
                        <div key={file.path || file.content} className="text-[10px] text-text-muted">{file.path || 'Unnamed file'}</div>
                      ))}
                    </div>
                  ) : (
                    <div>No extra bundle files yet.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-5 text-[10px] text-text-muted">Open Cowork reloads the runtime automatically after saving.</p>
      </div>
    </div>
  )
}
