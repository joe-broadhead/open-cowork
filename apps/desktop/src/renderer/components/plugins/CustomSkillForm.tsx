import { useState } from 'react'

export function CustomSkillForm({ onSave, onCancel }: { onSave: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [content, setContent] = useState(`---
name: my-skill
description: "Describe what this skill does and when to use it."
allowed-tools: ""
metadata:
  owner: "custom"
  version: "1.0.0"
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
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name || !content) return
    setSaving(true)
    await window.cowork.custom.addSkill({ name, content })
    setSaving(false)
    onSave()
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[14px] font-semibold text-text">Add Custom Skill</h3>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-muted">Skill Name</span>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. code-review, data-pipeline"
          className="w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border" />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-muted">SKILL.md Content</span>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={16}
          className="w-full px-3 py-2 rounded-lg text-[11px] font-mono bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y leading-relaxed"
        />
      </label>

      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">Cancel</button>
        <button onClick={handleSave} disabled={!name || !content || saving} className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-accent cursor-pointer disabled:opacity-40">
          {saving ? 'Saving...' : 'Add Skill'}
        </button>
      </div>

      <p className="text-[10px] text-text-muted">Cowork will reload the runtime automatically after saving.</p>
    </div>
  )
}
