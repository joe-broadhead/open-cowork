import { useEffect, useRef, useState } from 'react'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import {
  AgentTeamSelector,
  AUTOMATION_TEMPLATES,
  createDefaultDraft,
  dailyRunAttemptCapPlaceholder,
  draftToPayload,
  type AutomationAgentOption,
  type DraftState,
} from './automations-page-support'
import type { AutomationAutonomyPolicy, AutomationExecutionMode, AutomationKind, AutomationScheduleType } from '@open-cowork/shared'

type Props = {
  defaults: DraftState
  onCreate: (draft: DraftState) => Promise<void>
  onClose: () => void
  loadAgentOptions: (directory: string | null | undefined, selectedNames: string[]) => Promise<AutomationAgentOption[]>
}

const STEPS = ['What & Why', 'When & How', 'Review & Create']

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</span>
      <div className="mt-2">{children}</div>
    </label>
  )
}

function SegmentedButton({
  selected,
  title,
  detail,
  onClick,
}: {
  selected: boolean
  title: string
  detail: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border px-3 py-3 text-left transition-colors cursor-pointer"
      style={{
        borderColor: selected ? 'var(--color-accent)' : 'var(--color-border)',
        background: selected ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent',
      }}
    >
      <div className="text-[13px] font-semibold text-text">{title}</div>
      <div className="mt-1 text-[11px] leading-5 text-text-secondary">{detail}</div>
    </button>
  )
}

function validateWizardDraft(draft: DraftState) {
  if (!draft.title.trim()) return 'Automation title is required.'
  if (!draft.goal.trim()) return 'Automation goal is required.'
  if (draft.executionMode === 'scoped_execution' && !draft.projectDirectory.trim()) {
    return 'Scoped execution automations require a project directory.'
  }
  if (draft.scheduleType === 'one_time' && !draft.startAt.trim()) {
    return 'One-time automations require a start date and time.'
  }
  try {
    draftToPayload(draft)
  } catch {
    return 'Check the schedule fields before creating this automation.'
  }
  return null
}

export function AutomationCreateWizard({ defaults, onCreate, onClose, loadAgentOptions }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<DraftState>(() => ({ ...createDefaultDraft(), ...defaults }))
  const [agentOptions, setAgentOptions] = useState<AutomationAgentOption[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useFocusTrap(dialogRef, { onEscape: saving ? undefined : onClose })

  useEffect(() => {
    let cancelled = false
    void loadAgentOptions(draft.projectDirectory, draft.preferredAgentNames).then((options) => {
      if (!cancelled) setAgentOptions(options)
    }).catch(() => {
      if (!cancelled) setAgentOptions([])
    })
    return () => {
      cancelled = true
    }
  }, [draft.projectDirectory, draft.preferredAgentNames, loadAgentOptions])

  const updateDraft = (patch: Partial<DraftState>) => setDraft((current) => ({ ...current, ...patch }))
  const goNext = () => {
    setError(null)
    if (step === 0 && (!draft.title.trim() || !draft.goal.trim())) {
      setError('Add a title and goal before choosing schedule details.')
      return
    }
    if (step === 1 && draft.executionMode === 'scoped_execution' && !draft.projectDirectory.trim()) {
      setError('Scoped execution automations require a project directory.')
      return
    }
    setStep((current) => Math.min(STEPS.length - 1, current + 1))
  }
  const submit = async () => {
    const validation = validateWizardDraft(draft)
    if (validation) {
      setError(validation)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreate(draft)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create automation.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <ModalBackdrop onDismiss={saving ? () => undefined : onClose} className="fixed inset-0 z-50 bg-black/50" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-wizard-title"
        className="fixed left-1/2 top-[5vh] z-50 flex max-h-[90vh] w-[760px] max-w-[94vw] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border-subtle shadow-2xl"
        style={{ background: 'var(--color-base)' }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">New automation</div>
            <h2 id="automation-wizard-title" className="mt-1 text-[18px] font-semibold text-text">{STEPS[step]}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close wizard" className="text-[22px] leading-none text-text-muted hover:text-text cursor-pointer disabled:opacity-50">×</button>
        </div>

        <div className="flex gap-2 border-b border-border-subtle px-5 py-3">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              onClick={() => setStep(index)}
              className="rounded-full border px-3 py-1 text-[11px] cursor-pointer"
              style={{
                borderColor: index === step ? 'var(--color-accent)' : 'var(--color-border)',
                color: index === step ? 'var(--color-accent)' : 'var(--color-text-muted)',
              }}
            >
              {index + 1}. {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {error ? (
            <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3 text-[12px]" style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 8%, transparent)' }} role="alert">
              {error}
            </div>
          ) : null}

          {step === 0 ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {AUTOMATION_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => setDraft((current) => template.apply(current))}
                    className="rounded-xl border border-border px-4 py-3 text-left transition-colors hover:bg-surface-hover cursor-pointer"
                    title={template.description}
                  >
                    <div className="text-[13px] font-semibold text-text">{template.label}</div>
                    <div className="mt-1 text-[11px] leading-5 text-text-secondary">{template.description}</div>
                  </button>
                ))}
              </div>
              <Field label="Title">
                <input autoFocus value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder="Weekly market report" />
              </Field>
              <Field label="Goal">
                <textarea value={draft.goal} onChange={(event) => updateDraft({ goal: event.target.value })} rows={6} className="w-full resize-y rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder="Describe the repeated outcome Cowork should keep moving." />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <SegmentedButton selected={draft.kind === 'recurring'} title="Recurring program" detail="Repeats on a schedule and produces a regular output." onClick={() => updateDraft({ kind: 'recurring' as AutomationKind })} />
                <SegmentedButton selected={draft.kind === 'managed-project'} title="Managed project" detail="Keeps a standing body of work planned and moving." onClick={() => updateDraft({ kind: 'managed-project' as AutomationKind })} />
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Schedule">
                  <select value={draft.scheduleType} onChange={(event) => updateDraft({ scheduleType: event.target.value as AutomationScheduleType })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]">
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="one_time">One-time</option>
                  </select>
                </Field>
                <Field label="Timezone">
                  <input value={draft.timezone} onChange={(event) => updateDraft({ timezone: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                </Field>
                <Field label="Run hour">
                  <input value={draft.runAtHour} onChange={(event) => updateDraft({ runAtHour: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder="9" />
                </Field>
                <Field label="Run minute">
                  <input value={draft.runAtMinute} onChange={(event) => updateDraft({ runAtMinute: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder="0" />
                </Field>
                {draft.scheduleType === 'weekly' ? (
                  <Field label="Day of week">
                    <input value={draft.dayOfWeek} onChange={(event) => updateDraft({ dayOfWeek: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder="1" />
                  </Field>
                ) : null}
                {draft.scheduleType === 'monthly' ? (
                  <Field label="Day of month">
                    <input value={draft.dayOfMonth} onChange={(event) => updateDraft({ dayOfMonth: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder="1" />
                  </Field>
                ) : null}
                {draft.scheduleType === 'one_time' ? (
                  <Field label="Start date and time">
                    <input type="datetime-local" value={draft.startAt} onChange={(event) => updateDraft({ startAt: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                  </Field>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <SegmentedButton selected={draft.autonomyPolicy === 'review-first'} title="Review first" detail="Cowork asks before executing a new brief." onClick={() => updateDraft({ autonomyPolicy: 'review-first' as AutomationAutonomyPolicy })} />
                <SegmentedButton selected={draft.autonomyPolicy === 'mostly-autonomous'} title="Mostly autonomous" detail="Cowork can continue after planning when no review is needed." onClick={() => updateDraft({ autonomyPolicy: 'mostly-autonomous' as AutomationAutonomyPolicy })} />
                <SegmentedButton selected={draft.executionMode === 'planning_only'} title="Planning only" detail="Good for research, briefs, and inbox-ready output." onClick={() => updateDraft({ executionMode: 'planning_only' as AutomationExecutionMode })} />
                <SegmentedButton selected={draft.executionMode === 'scoped_execution'} title="Scoped execution" detail="Runs against an explicit project directory." onClick={() => updateDraft({ executionMode: 'scoped_execution' as AutomationExecutionMode })} />
              </div>
              {draft.executionMode === 'scoped_execution' ? (
                <Field label="Project directory">
                  <div className="flex gap-2">
                    <input value={draft.projectDirectory} readOnly className="min-w-0 flex-1 rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder="Choose a project directory" />
                    <button type="button" onClick={async () => {
                      const selected = await window.coworkApi.dialog.selectDirectory()
                      if (selected) updateDraft({ projectDirectory: selected })
                    }} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">
                      Browse
                    </button>
                    {draft.projectDirectory ? (
                      <button type="button" onClick={() => updateDraft({ projectDirectory: '' })} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">
                        Clear
                      </button>
                    ) : null}
                  </div>
                </Field>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-border-subtle p-4" style={{ background: 'var(--color-elevated)' }}>
                <div className="text-[15px] font-semibold text-text">{draft.title || 'Untitled automation'}</div>
                <p className="mt-2 text-[12px] leading-6 text-text-secondary">{draft.goal || 'No goal yet.'}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-muted">
                  <span>{draft.kind === 'managed-project' ? 'Managed project' : 'Recurring program'}</span>
                  <span>{draft.scheduleType}</span>
                  <span>{draft.autonomyPolicy}</span>
                  <span>{draft.executionMode === 'scoped_execution' ? 'Scoped execution' : 'Planning only'}</span>
                </div>
              </div>
              <button type="button" onClick={() => setAdvancedOpen((current) => !current)} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">
                {advancedOpen ? 'Hide advanced settings' : 'Show advanced settings'}
              </button>
              {advancedOpen ? (
                <div className="space-y-4 rounded-2xl border border-border-subtle p-4">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">Preferred specialists</div>
                    <div className="mt-2">
                      <AgentTeamSelector
                        options={agentOptions}
                        value={draft.preferredAgentNames}
                        onChange={(preferredAgentNames) => updateDraft({ preferredAgentNames })}
                        emptyLabel="No specialist agents are available yet. Cowork will use default routing."
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Heartbeat minutes">
                      <input value={draft.heartbeatMinutes} onChange={(event) => updateDraft({ heartbeatMinutes: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                    </Field>
                    <Field label="Max retries">
                      <input value={draft.maxRetries} onChange={(event) => updateDraft({ maxRetries: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                    </Field>
                    <Field label="Base retry delay">
                      <input value={draft.retryBaseDelayMinutes} onChange={(event) => updateDraft({ retryBaseDelayMinutes: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                    </Field>
                    <Field label="Max retry delay">
                      <input value={draft.retryMaxDelayMinutes} onChange={(event) => updateDraft({ retryMaxDelayMinutes: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                    </Field>
                    <Field label="Daily run cap">
                      <input value={draft.dailyRunCap} onChange={(event) => updateDraft({ dailyRunCap: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder={dailyRunAttemptCapPlaceholder()} />
                    </Field>
                    <Field label="Max run duration">
                      <input value={draft.maxRunDurationMinutes} onChange={(event) => updateDraft({ maxRunDurationMinutes: event.target.value })} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                    </Field>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-5 py-4">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50">
            Cancel
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || saving} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50">
              Back
            </button>
            {step < STEPS.length - 1 ? (
              <button type="button" onClick={goNext} className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>
                Continue
              </button>
            ) : (
              <button type="button" onClick={() => void submit()} disabled={saving} className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer disabled:opacity-50" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>
                {saving ? 'Creating…' : 'Create automation'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
