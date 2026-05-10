import { useMemo, useState } from 'react'
import type { CrewDefinitionDraft, CrewDetail, CrewMemberDraft } from '@open-cowork/shared'

type CrewVersionEditorProps = {
  detail: CrewDetail
  busy: boolean
  onCancel: () => void
  onSave: (draft: CrewDefinitionDraft) => Promise<void>
}

const ROLE_OPTIONS: CrewMemberDraft['role'][] = ['lead', 'specialist', 'evaluator']

function draftFromDetail(detail: CrewDetail): CrewDefinitionDraft {
  return {
    name: detail.definition.name,
    description: detail.definition.description,
    members: (detail.activeVersion?.members || []).map((member) => ({
      role: member.role,
      agentName: member.agentName,
      displayName: member.displayName,
      description: member.description,
      required: member.required,
    })),
    workspaceProfileId: detail.activeVersion?.workspaceProfileId || null,
    outcomeRubricId: detail.activeVersion?.outcomeRubricId || null,
    budgetCapUsd: detail.activeVersion?.budgetCapUsd ?? null,
  }
}

function countRole(members: CrewMemberDraft[], role: CrewMemberDraft['role']) {
  return members.filter((member) => member.role === role).length
}

function canSaveDraft(draft: CrewDefinitionDraft) {
  return draft.name.trim().length > 0
    && draft.description.trim().length > 0
    && countRole(draft.members, 'lead') >= 1
    && countRole(draft.members, 'specialist') >= 2
    && countRole(draft.members, 'evaluator') >= 1
    && draft.members.every((member) => member.agentName.trim().length > 0)
    && (draft.budgetCapUsd === null || draft.budgetCapUsd === undefined || draft.budgetCapUsd > 0)
}

function newMember(role: CrewMemberDraft['role']): CrewMemberDraft {
  return {
    role,
    agentName: role === 'lead' ? 'plan' : role === 'evaluator' ? 'general' : 'build',
    displayName: role === 'lead' ? 'Lead' : role === 'evaluator' ? 'Evaluator' : 'Specialist',
    description: '',
    required: true,
  }
}

export function CrewVersionEditor({ detail, busy, onCancel, onSave }: CrewVersionEditorProps) {
  const [draft, setDraft] = useState<CrewDefinitionDraft>(() => draftFromDetail(detail))
  const valid = useMemo(() => canSaveDraft(draft), [draft])
  const nextVersion = (detail.activeVersion?.version || detail.versions.length || 0) + 1

  const updateMember = (index: number, patch: Partial<CrewMemberDraft>) => {
    setDraft((current) => ({
      ...current,
      members: current.members.map((member, memberIndex) => (
        memberIndex === index ? { ...member, ...patch } : member
      )),
    }))
  }

  const removeMember = (index: number) => {
    setDraft((current) => ({
      ...current,
      members: current.members.filter((_, memberIndex) => memberIndex !== index),
    }))
  }

  const addMember = (role: CrewMemberDraft['role']) => {
    setDraft((current) => ({
      ...current,
      members: [...current.members, newMember(role)],
    }))
  }

  const save = async () => {
    if (!valid || busy) return
    await onSave(draft)
  }

  return (
    <section className="rounded-lg border border-border-subtle bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">Crew editor</div>
          <h3 className="mt-1 text-[17px] font-semibold text-text">Save version {nextVersion}</h3>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-text-secondary">
            Edits create a new active crew version. Existing runs stay pinned to the exact version that created them.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[12px] font-medium text-text hover:bg-surface-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !valid}
            className="rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Save new version'}
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <label className="block text-[12px] font-medium text-text-secondary">
          Crew name
          <input
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            className="mt-1 w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
          />
        </label>
        <label className="block text-[12px] font-medium text-text-secondary">
          Budget cap
          <input
            type="number"
            min="0"
            step="0.01"
            value={draft.budgetCapUsd ?? ''}
            onChange={(event) => setDraft((current) => ({
              ...current,
              budgetCapUsd: event.target.value ? Number(event.target.value) : null,
            }))}
            className="mt-1 w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
          />
        </label>
        <label className="block text-[12px] font-medium text-text-secondary md:col-span-2">
          Description
          <textarea
            value={draft.description}
            onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            rows={3}
            className="mt-1 w-full resize-none rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[13px] leading-5 text-text outline-none focus:border-accent"
          />
        </label>
      </div>

      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-widest text-text-muted">Members</div>
            <div className="mt-1 text-[12px] text-text-secondary">
              Requires at least one lead, two specialists, and one evaluator.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => addMember('lead')} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text hover:bg-surface-hover">Add lead</button>
            <button type="button" onClick={() => addMember('specialist')} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text hover:bg-surface-hover">Add specialist</button>
            <button type="button" onClick={() => addMember('evaluator')} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text hover:bg-surface-hover">Add evaluator</button>
          </div>
        </div>

        <div className="mt-3 space-y-3">
          {draft.members.map((member, index) => (
            <div key={`${member.role}-${index}`} className="rounded-md border border-border-subtle bg-elevated p-3">
              <div className="grid gap-3 md:grid-cols-[160px_1fr_1fr_auto]">
                <label className="block text-[11px] font-medium uppercase tracking-widest text-text-muted">
                  Role
                  <select
                    value={member.role}
                    onChange={(event) => updateMember(index, { role: event.target.value as CrewMemberDraft['role'] })}
                    className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-2 text-[12px] normal-case tracking-normal text-text outline-none focus:border-accent"
                  >
                    {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                </label>
                <label className="block text-[11px] font-medium uppercase tracking-widest text-text-muted">
                  Agent
                  <input
                    value={member.agentName}
                    onChange={(event) => updateMember(index, { agentName: event.target.value })}
                    className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-2 text-[12px] normal-case tracking-normal text-text outline-none focus:border-accent"
                  />
                </label>
                <label className="block text-[11px] font-medium uppercase tracking-widest text-text-muted">
                  Display name
                  <input
                    value={member.displayName || ''}
                    onChange={(event) => updateMember(index, { displayName: event.target.value })}
                    className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-2 text-[12px] normal-case tracking-normal text-text outline-none focus:border-accent"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeMember(index)}
                  className="self-end rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover"
                >
                  Remove
                </button>
              </div>
              <label className="mt-3 block text-[11px] font-medium uppercase tracking-widest text-text-muted">
                Description
                <input
                  value={member.description || ''}
                  onChange={(event) => updateMember(index, { description: event.target.value })}
                  className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-2 text-[12px] normal-case tracking-normal text-text outline-none focus:border-accent"
                />
              </label>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
