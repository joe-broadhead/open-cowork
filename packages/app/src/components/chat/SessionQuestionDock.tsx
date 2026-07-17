import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PendingQuestion } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { useEscape } from '../../hooks/useEscape'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, Textarea } from '@open-cowork/ui'

type Props = {
  request: PendingQuestion
  queueCount?: number
}

export function SessionQuestionDock({ request, queueCount = 1 }: Props) {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId)
  const toolCalls = useSessionStore((s) => s.currentView.toolCalls)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<string[][]>([])
  const [customValues, setCustomValues] = useState<string[]>([])
  const [customEnabled, setCustomEnabled] = useState<boolean[]>([])
  const [submitting, setSubmitting] = useState(false)
  const firstOptionRef = useRef<HTMLButtonElement>(null)

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
      target.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' })
    }
  }

  useEffect(() => {
    setStep(0)
    setAnswers(request.questions.map(() => []))
    setCustomValues(request.questions.map(() => ''))
    setCustomEnabled(request.questions.map(() => false))
    setSubmitting(false)
  }, [request.id, request.questions])

  // Hooks below must run on every render, so the !current early return lives
  // after them (just above the JSX). current may briefly be undefined between a
  // request swap and the reset effect; the helpers/JSX that read it are guarded.
  const current = request.questions[step]
  const total = request.questions.length
  const isLast = step >= total - 1
  // The current required step is answered once it has at least one selected
  // (or custom) value; mirror the per-step answers used to build the reply.
  const currentAnswered = (answers[step]?.length ?? 0) > 0

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
      if (current?.multiple) {
        return withoutPrevious.includes(trimmed) ? withoutPrevious : [...withoutPrevious, trimmed]
      }
      return [trimmed]
    }))
  }

  const goNext = useCallback(async () => {
    if (!currentSessionId || submitting || !currentAnswered) return
    if (!isLast) {
      setStep((value) => Math.min(total - 1, value + 1))
      return
    }

    setSubmitting(true)
    try {
      await window.coworkApi.question.reply(currentSessionId, request.id, answers, {
        workspaceId: request.workspaceId || activeWorkspaceId,
      })
    } finally {
      setSubmitting(false)
    }
  }, [currentSessionId, submitting, currentAnswered, isLast, total, answers, request.id, request.workspaceId, activeWorkspaceId])

  const reject = useCallback(async () => {
    if (!currentSessionId || submitting) return
    setSubmitting(true)
    try {
      await window.coworkApi.question.reject(currentSessionId, request.id, {
        workspaceId: request.workspaceId || activeWorkspaceId,
      })
    } finally {
      setSubmitting(false)
    }
  }, [currentSessionId, submitting, request.id, request.workspaceId, activeWorkspaceId])

  // Focus the first option whenever a new request arrives so keyboard users
  // land inside the dock without a mouse reach.
  useEffect(() => {
    firstOptionRef.current?.focus()
  }, [request.id])

  // Escape dismisses the dock (mirrors TaskDrillIn / DiffViewer Escape
  // handling) through the shared stacked Escape helper.
  useEscape(() => { void reject() })

  // Enter advances/submits the current step once it is answered.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        // Let the custom-answer textarea keep its own newline behaviour.
        if (event.target instanceof HTMLTextAreaElement) return
        if (!currentAnswered || submitting) return
        event.preventDefault()
        void goNext()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentAnswered, submitting, goNext])

  if (!current) return null

  return (
    <div className="px-6 pt-2">
      <div className="measure-column">
        <Card variant="tile" padding="md" className="rounded-2xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="text-2xs uppercase tracking-[0.16em] text-text-muted">{t('questionDock.question', 'Question')}</div>
                {queueCount > 1 && (
                  <Badge
                    tone="warning"
                    title={t('questionDock.pendingCount', '{{count}} questions pending on this thread', { count: String(queueCount) })}
                  >
                    {queueCount} pending
                  </Badge>
                )}
                {scopedTool && (
                  <button
                    type="button"
                    onClick={scrollToScopedTool}
                    title={t('questionDock.scrollToToolCall', 'Scroll to the tool call this question is about')}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-2xs font-medium cursor-pointer hover:opacity-80 transition-opacity"
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
              <div className="mt-1 font-display text-role-title text-text">{current.header}</div>
            </div>
            {total > 1 && (
              <div className="text-2xs text-text-muted shrink-0">
                {step + 1} / {total}
              </div>
            )}
          </div>

          <div className="mt-3 text-sm leading-relaxed text-text-secondary">
            {current.question}
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {current.options.map((option, optionIndex) => {
              const selected = answers[step]?.includes(option.label) ?? false
              return (
                <button
                  key={option.label}
                  ref={optionIndex === 0 ? firstOptionRef : undefined}
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    if (current.multiple) toggleMultiAnswer(option.label)
                    else setSingleAnswer(option.label)
                  }}
                  className="w-full rounded-xl border px-3 py-2.5 text-start transition-colors cursor-pointer"
                  style={{
                    borderColor: selected
                      ? 'color-mix(in srgb, var(--color-accent) 48%, var(--color-border))'
                      : 'var(--color-border)',
                    background: selected
                      ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
                      : 'transparent',
                  }}
                >
                  <div className="text-xs font-medium text-text">{option.label}</div>
                  <div className="mt-1 text-2xs text-text-muted">{option.description}</div>
                </button>
              )
            })}

            {current.custom !== false && (
              <Card variant="flat" padding="sm" className="rounded-xl">
                <label className="flex items-center gap-2 text-xs font-medium text-text">
                  <input
                    type={current.multiple ? 'checkbox' : 'radio'}
                    checked={customEnabled[step] ?? false}
                    onChange={toggleCustom}
                    disabled={submitting}
                  />
                  {t('questionDock.customAnswer', 'Custom answer')}
                </label>
                <Textarea
                  value={customValues[step] || ''}
                  onChange={(event) => updateCustom(event.target.value)}
                  disabled={submitting || !(customEnabled[step] ?? false)}
                  rows={2}
                  className="mt-2 resize-none leading-relaxed"
                  placeholder={t('questionDock.typeOwnAnswer', 'Type your own answer')}
                />
              </Card>
            )}
          </div>

          {!currentAnswered && (
            <div className="mt-3 text-2xs text-text-muted">
              {t('questionDock.chooseToContinue', 'Choose an option to continue')}
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <Button
              type="button"
              onClick={reject}
              disabled={submitting}
              variant="ghost"
              size="sm"
            >
              {t('questionDock.dismiss', 'Dismiss')}
            </Button>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <Button
                  type="button"
                  onClick={() => setStep((value) => Math.max(0, value - 1))}
                  disabled={submitting}
                  variant="secondary"
                  size="sm"
                >
                  Back
                </Button>
              )}
              <Button
                type="button"
                onClick={goNext}
                disabled={submitting || !currentAnswered}
                loading={submitting}
                variant="primary"
                size="sm"
              >
                {submitting ? 'Submitting…' : isLast ? 'Submit' : 'Next'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}

function preferredScrollBehavior(): ScrollBehavior {
  const reduce = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  return reduce ? 'auto' : 'smooth'
}
