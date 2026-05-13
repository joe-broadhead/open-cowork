import { useMemo, useState } from 'react'
import type { CrewApprovalPolicy, CrewDefinitionDraft, CrewDetail, CrewMemberDraft, WorkspaceProfile } from '@open-cowork/shared'
import {
  CREW_TEMPLATES,
  draftFromCrewTemplate,
  normalizeWorkspaceProfileId,
  summarizeAgentOption,
  validateCrewDraftForBuilder,
  type CrewAgentOption,
  type CrewTemplateId,
} from './crew-builder-ui'

type CrewVersionEditorProps = {
  detail?: CrewDetail | null
  initialDraft?: CrewDefinitionDraft | null
  mode?: 'create' | 'edit'
  busy: boolean
  agentOptions?: CrewAgentOption[]
  workspaceProfiles?: WorkspaceProfile[]
  onCancel: () => void
  onSave: (draft: CrewDefinitionDraft) => Promise<void>
}

const ROLE_OPTIONS: CrewMemberDraft['role'][] = ['lead', 'specialist', 'evaluator']
const APPROVAL_POLICIES: Array<{ value: CrewApprovalPolicy; label: string }> = [
  { value: 'review-before-delivery', label: 'Review before delivery' },
  { value: 'auto-deliver-after-evaluation', label: 'Auto-deliver after evaluation' },
]

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
    evalSuiteId: detail.activeVersion?.evalSuiteId || null,
    budgetCapUsd: detail.activeVersion?.budgetCapUsd ?? null,
    approvalPolicy: detail.activeVersion?.approvalPolicy || 'review-before-delivery',
  }
}

function initialEditorDraft(input: {
  detail?: CrewDetail | null
  initialDraft?: CrewDefinitionDraft | null
  agentOptions: CrewAgentOption[]
}) {
  if (input.initialDraft) return input.initialDraft
  if (input.detail) return draftFromDetail(input.detail)
  return draftFromCrewTemplate('operations', input.agentOptions)
}

function agentOptionByName(options: CrewAgentOption[]) {
  return new Map(options.map((option) => [option.name, option]))
}

function displayNameForAgent(agentName: string, options: CrewAgentOption[]) {
  return agentOptionByName(options).get(agentName)?.label || agentName
}

function resolveWorkspaceProfileId(value: string | null | undefined, profiles: readonly WorkspaceProfile[]) {
  if (!value || value === 'default') return null
  if (profiles.length === 0) return value
  return normalizeWorkspaceProfileId(value, profiles) || value
}

function firstAvailableAgent(options: CrewAgentOption[], usedAgentNames: Set<string>) {
  return options.find((option) => !option.disabled && !usedAgentNames.has(option.name)) || options.find((option) => !option.disabled) || options[0] || null
}

function newMember(role: CrewMemberDraft['role'], options: CrewAgentOption[], usedAgentNames: Set<string>): CrewMemberDraft {
  const fallbackAgent = role === 'lead' ? 'plan' : role === 'evaluator' ? 'general' : 'build'
  const option = options.find((entry) => entry.name === fallbackAgent && !entry.disabled && !usedAgentNames.has(entry.name))
    || firstAvailableAgent(options, usedAgentNames)
  const agentName = option?.name || fallbackAgent
  return {
    role,
    agentName,
    displayName: option?.label || (role === 'lead' ? 'Lead' : role === 'evaluator' ? 'Evaluator' : 'Specialist'),
    description: '',
    required: true,
  }
}

export function CrewVersionEditor({
  detail = null,
  initialDraft = null,
  mode = 'edit',
  busy,
  agentOptions = [],
  workspaceProfiles = [],
  onCancel,
  onSave,
}: CrewVersionEditorProps) {
  const [templateId, setTemplateId] = useState<CrewTemplateId>('operations')
  const [draft, setDraft] = useState<CrewDefinitionDraft>(() => initialEditorDraft({ detail, initialDraft, agentOptions }))
  const issues = useMemo(() => validateCrewDraftForBuilder(draft, agentOptions), [agentOptions, draft])
  const valid = issues.length === 0
  const nextVersion = mode === 'create' ? 1 : (detail?.activeVersion?.version || detail?.versions.length || 0) + 1
  const agentOptionsByName = useMemo(() => agentOptionByName(agentOptions), [agentOptions])
  const usedAgentNames = useMemo(() => new Set(draft.members.map((member) => member.agentName).filter(Boolean)), [draft.members])
  const workspaceProfileIds = useMemo(() => new Set(workspaceProfiles.map((profile) => profile.id)), [workspaceProfiles])
  const unlistedWorkspaceProfileId = draft.workspaceProfileId && !workspaceProfileIds.has(draft.workspaceProfileId) ? draft.workspaceProfileId : null

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
      members: [...current.members, newMember(role, agentOptions, usedAgentNames)],
    }))
  }

  const applyTemplate = (nextTemplateId: CrewTemplateId) => {
    setTemplateId(nextTemplateId)
    setDraft(draftFromCrewTemplate(nextTemplateId, agentOptions))
  }

  const save = async () => {
    if (!valid || busy) return
    await onSave({
      ...draft,
      workspaceProfileId: resolveWorkspaceProfileId(draft.workspaceProfileId, workspaceProfiles),
      approvalPolicy: draft.approvalPolicy || 'review-before-delivery',
    })
  }

  return (
    <section className="rounded-lg border border-border-subtle bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">
            {mode === 'create' ? 'Crew builder' : 'Crew editor'}
          </div>
          <h3 className="mt-1 text-[17px] font-semibold text-text">
            {mode === 'create' ? 'Create reusable team' : `Save version ${nextVersion}`}
          </h3>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-text-secondary">
            {mode === 'create'
              ? 'Versioned team definitions capture member roles, authority, and evaluation policy before runs begin.'
              : 'Edits create a new active crew version. Existing runs stay pinned to the exact version that created them.'}
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
            {busy ? 'Saving...' : mode === 'create' ? 'Create crew' : 'Save new version'}
          </button>
        </div>
      </div>

      {mode === 'create' ? (
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {CREW_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => applyTemplate(template.id)}
              aria-current={templateId === template.id ? 'true' : undefined}
              className={`rounded-md border px-3 py-3 text-left ${templateId === template.id ? 'border-accent bg-accent/10' : 'border-border-subtle bg-elevated hover:bg-surface-hover'}`}
            >
              <div className="text-[13px] font-semibold text-text">{template.label}</div>
              <div className="mt-1 text-[12px] leading-5 text-text-secondary">{template.description}</div>
            </button>
          ))}
        </div>
      ) : null}

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
        <label className="block text-[12px] font-medium text-text-secondary">
          Workspace profile
          <select
            value={draft.workspaceProfileId || 'default'}
            onChange={(event) => setDraft((current) => ({
              ...current,
              workspaceProfileId: resolveWorkspaceProfileId(event.target.value, workspaceProfiles),
            }))}
            className="mt-1 w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
          >
            <option value="default">Default sandbox</option>
            {unlistedWorkspaceProfileId ? (
              <option value={unlistedWorkspaceProfileId}>Current profile ({unlistedWorkspaceProfileId})</option>
            ) : null}
            {workspaceProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-[12px] font-medium text-text-secondary">
          Approval policy
          <select
            value={draft.approvalPolicy || 'review-before-delivery'}
            onChange={(event) => setDraft((current) => ({ ...current, approvalPolicy: event.target.value as CrewApprovalPolicy }))}
            className="mt-1 w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
          >
            {APPROVAL_POLICIES.map((policy) => (
              <option key={policy.value} value={policy.value}>{policy.label}</option>
            ))}
          </select>
        </label>
        <label className="block text-[12px] font-medium text-text-secondary">
          Rubric id
          <input
            value={draft.outcomeRubricId || ''}
            onChange={(event) => setDraft((current) => ({ ...current, outcomeRubricId: event.target.value || null }))}
            className="mt-1 w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
          />
        </label>
        <label className="block text-[12px] font-medium text-text-secondary">
          Eval suite id
          <input
            value={draft.evalSuiteId || ''}
            onChange={(event) => setDraft((current) => ({ ...current, evalSuiteId: event.target.value || null }))}
            className="mt-1 w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
          />
        </label>
        <label className="block text-[12px] font-medium text-text-secondary md:col-span-2">
          Purpose
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
              Crew shape: one lead, at least two specialists, and one evaluator from the loaded agent catalog.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => addMember('lead')} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text hover:bg-surface-hover">Add lead</button>
            <button type="button" onClick={() => addMember('specialist')} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text hover:bg-surface-hover">Add specialist</button>
            <button type="button" onClick={() => addMember('evaluator')} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text hover:bg-surface-hover">Add evaluator</button>
          </div>
        </div>

        <div className="mt-3 space-y-3">
          {draft.members.map((member, index) => {
            const option = agentOptionsByName.get(member.agentName)
            return (
              <div key={`${member.role}-${index}`} className="rounded-md border border-border-subtle bg-elevated p-3">
                <div className="grid gap-3 xl:grid-cols-[150px_minmax(180px,1fr)_minmax(180px,1fr)_120px_auto]">
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
                    {agentOptions.length > 0 ? (
                      <select
                        value={member.agentName}
                        onChange={(event) => updateMember(index, {
                          agentName: event.target.value,
                          displayName: displayNameForAgent(event.target.value, agentOptions),
                        })}
                        className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-2 text-[12px] normal-case tracking-normal text-text outline-none focus:border-accent"
                      >
                        {agentOptions.map((agent) => (
                          <option key={agent.name} value={agent.name} disabled={agent.disabled}>{agent.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={member.agentName}
                        onChange={(event) => updateMember(index, { agentName: event.target.value })}
                        className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-2 text-[12px] normal-case tracking-normal text-text outline-none focus:border-accent"
                      />
                    )}
                  </label>
                  <label className="block text-[11px] font-medium uppercase tracking-widest text-text-muted">
                    Display name
                    <input
                      value={member.displayName || ''}
                      onChange={(event) => updateMember(index, { displayName: event.target.value })}
                      className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-2 text-[12px] normal-case tracking-normal text-text outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-[12px] text-text-secondary">
                    <input
                      type="checkbox"
                      checked={member.required ?? true}
                      onChange={(event) => updateMember(index, { required: event.target.checked })}
                    />
                    Required
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
                  Responsibility
                  <input
                    value={member.description || ''}
                    onChange={(event) => updateMember(index, { description: event.target.value })}
                    className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-2 text-[12px] normal-case tracking-normal text-text outline-none focus:border-accent"
                  />
                </label>
                <div className="mt-2 text-[11px] text-text-muted">
                  {summarizeAgentOption(option)} | Max parallel tasks: 1 per crew run
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {issues.length > 0 ? (
        <div className="mt-4 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
          {issues[0]}
        </div>
      ) : null}
    </section>
  )
}
