import { useEffect, useMemo, useState } from 'react'
import type { PendingQuestion } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'

type Props = {
  request: PendingQuestion
  queueCount?: number
}

export function SessionQuestionDock({ request, queueCount = 1 }: Props) {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const toolCalls = useSessionStore((s) => s.currentView.toolCalls)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<string[][]>([])
  const [customValues, setCustomValues] = useState<string[]>([])
  const [customEnabled, setCustomEnabled] = useState<boolean[]>([])
  const [submitting, setSubmitting] = useState(false)

  const scopedTool = useMemo(() => {
    const callId = request.tool?.callId
    if (!callId) return null
    return toolCalls.find((tool) => tool.id === callId) || null
  }, [request.tool?.callId, toolCalls])

  const scrollToScopedTool = () => {
    const callId = request.tool?.callId
    if (!callId) return
    const target = document.querySelector(`[data-tool-call-id="${CSS.escape(callId)}"]`)
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  useEffect(() => {
    setStep(0)
    setAnswers(request.questions.map(() => []))
    setCustomValues(request.questions.map(() => ''))
    setCustomEnabled(request.questions.map(() => false))
    setSubmitting(false)
  }, [request.id, request.questions])

  const current = request.questions[step]
  if (!current) return null

  const total = request.questions.length
  const isLast = step >= total - 1

  const setSingleAnswer = (label: string) => {
    setAnswers((prev) => prev.map((entry, index) => index === step ? [label] : entry))
    setCustomEnabled((prev) => prev.map((enabled, index) => index === step ? false : enabled))
  }

  const toggleMultiAnswer = (label: string) => {
    setAnswers((prev) => prev.map((entry, index) => {
      if (index !== step) return entry
      return entry.includes(label)
        ? entry.filter((item) => item !== label)
        : [...entry, label]
    }))
  }

  const toggleCustom = () => {
    const nextEnabled = !customEnabled[step]
    setCustomEnabled((prev) => prev.map((enabled, index) => index === step ? nextEnabled : enabled))
    if (!nextEnabled) {
      const value = customValues[step]?.trim()
      if (value) {
        setAnswers((prev) => prev.map((entry, index) => index === step ? entry.filter((item) => item !== value) : entry))
      }
    }
  }

  const updateCustom = (value: string) => {
    setCustomValues((prev) => prev.map((entry, index) => index === step ? value : entry))
    if (!customEnabled[step]) return

    const trimmed = value.trim()
    setAnswers((prev) => prev.map((entry, index) => {
      if (index !== step) return entry
      const withoutPrevious = entry.filter((item) => item !== customValues[step]?.trim())
      if (!trimmed) return withoutPrevious
      if (current.multiple) {
        return withoutPrevious.includes(trimmed) ? withoutPrevious : [...withoutPrevious, trimmed]
      }
      return [trimmed]
    }))
  }

  const goNext = async () => {
    if (!currentSessionId || submitting) return
    if (!isLast) {
      setStep((value) => Math.min(total - 1, value + 1))
      return
    }

    setSubmitting(true)
    try {
      await window.openCowork.question.reply(currentSessionId, request.id, answers)
    } finally {
      setSubmitting(false)
    }
  }

  const reject = async () => {
    if (!currentSessionId || submitting) return
    setSubmitting(true)
    try {
      await window.openCowork.question.reject(currentSessionId, request.id)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="px-6 pt-2">
      <div className="max-w-[900px] mx-auto">
        <div
          className="rounded-2xl border border-border p-4"
          style={{ background: 'color-mix(in srgb, var(--color-base) 88%, var(--color-elevated) 12%)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted">Question</div>
                {queueCount > 1 && (
                  <span
                    className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                    title={`${queueCount} questions pending on this thread`}
                    style={{
                      background: 'color-mix(in srgb, var(--color-warning) 18%, transparent)',
                      color: 'var(--color-warning)',
                    }}
                  >
                    {queueCount} pending
                  </span>
                )}
                {scopedTool && (
                  <button
                    type="button"
                    onClick={scrollToScopedTool}
                    title="Scroll to the tool call this question is about"
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
                    style={{
                      background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
                      color: 'var(--color-accent)',
                    }}
                  >
                    <span>About:</span>
                    <span className="font-mono truncate max-w-[180px]">{scopedTool.name}</span>
                  </button>
                )}
              </div>
              <div className="mt-1 text-[15px] font-semibold text-text">{current.header}</div>
            </div>
            {total > 1 && (
              <div className="text-[11px] text-text-muted shrink-0">
                {step + 1} / {total}
              </div>
            )}
          </div>

          <div className="mt-3 text-[13px] leading-relaxed text-text-secondary">
            {current.question}
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {current.options.map((option) => {
              const selected = answers[step]?.includes(option.label) ?? false
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    if (current.multiple) toggleMultiAnswer(option.label)
                    else setSingleAnswer(option.label)
                  }}
                  className="w-full rounded-xl border px-3 py-2.5 text-left transition-colors cursor-pointer"
                  style={{
                    borderColor: selected
                      ? 'color-mix(in srgb, var(--color-accent) 48%, var(--color-border))'
                      : 'var(--color-border)',
                    background: selected
                      ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
                      : 'transparent',
                  }}
                >
                  <div className="text-[12px] font-medium text-text">{option.label}</div>
                  <div className="mt-1 text-[11px] text-text-muted">{option.description}</div>
                </button>
              )
            })}

            {current.custom !== false && (
              <div className="rounded-xl border border-border px-3 py-3">
                <label className="flex items-center gap-2 text-[12px] font-medium text-text">
                  <input
                    type={current.multiple ? 'checkbox' : 'radio'}
                    checked={customEnabled[step] ?? false}
                    onChange={toggleCustom}
                    disabled={submitting}
                  />
                  Custom answer
                </label>
                <textarea
                  value={customValues[step] || ''}
                  onChange={(event) => updateCustom(event.target.value)}
                  disabled={submitting || !(customEnabled[step] ?? false)}
                  rows={2}
                  className="mt-2 w-full bg-transparent resize-none text-[12px] text-text placeholder:text-text-muted leading-relaxed"
                  placeholder="Type your own answer"
                  style={{ outline: 'none' }}
                />
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={reject}
              disabled={submitting}
              className="px-3 py-2 rounded-lg text-[12px] text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
            >
              Dismiss
            </button>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <button
                  type="button"
                  onClick={() => setStep((value) => Math.max(0, value - 1))}
                  disabled={submitting}
                  className="px-3 py-2 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={goNext}
                disabled={submitting}
                className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer"
                style={{
                  background: 'var(--color-accent)',
                  color: 'var(--color-accent-foreground)',
                }}
              >
                {submitting ? 'Submitting…' : isLast ? 'Submit' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
