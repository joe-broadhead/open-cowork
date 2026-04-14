import { useState } from 'react'

export function CustomSkillForm({ onSave, onCancel }: { onSave: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [content, setContent] = useState(`---
name: my-skill
description: "Describe what this skill does and when to use it."
compatibility: opencode
---

# My Skill

## Mission

Describe the skill's purpose.

## Workflow

1. Step one
2. Step two

## Tool reference

| Tool | When to use |
|---|---|
| tool_name | Description |
`)
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([])
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name || !content) return
    setSaving(true)
    await window.openCowork.custom.addSkill({
      name,
      content,
      files: files
        .filter((file) => file.path.trim() && file.content.trim())
        .map((file) => ({ path: file.path.trim(), content: file.content })),
    })
    setSaving(false)
    onSave()
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[14px] font-semibold text-text">Add Skill Bundle</h3>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-muted">Skill directory</span>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. code-review, data-pipeline"
          className="w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border" />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-muted">SKILL.md Content</span>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={24}
          className="w-full min-h-[560px] px-3 py-2 rounded-lg text-[11px] font-mono bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y leading-relaxed"
        />
      </label>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] text-text-muted">Additional files</div>
            <div className="text-[10px] text-text-muted">Add optional references, examples, templates, or helper files inside this skill bundle.</div>
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
              <div key={index} className="rounded-xl border border-border-subtle bg-surface p-3">
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
                    className="w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
                  />
                  <textarea
                    value={file.content}
                    onChange={(event) => setFiles((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, content: event.target.value } : entry))}
                    rows={8}
                    placeholder="File contents"
                    className="w-full min-h-[180px] px-3 py-2 rounded-lg text-[11px] font-mono bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y leading-relaxed"
                  />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">Cancel</button>
        <button
          onClick={handleSave}
          disabled={!name || !content || saving}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-accent cursor-pointer disabled:opacity-40"
          style={{ color: 'var(--color-accent-foreground)' }}
        >
          {saving ? 'Saving...' : 'Add Skill'}
        </button>
      </div>

      <p className="text-[10px] text-text-muted">Open Cowork will reload the runtime automatically after saving.</p>
    </div>
  )
}
