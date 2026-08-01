import { useCallback, useEffect, useMemo, useState } from 'react'
import { HomeComposer } from './home/HomeComposer'
import type { BrandingHomeConfig } from '@open-cowork/shared'
import { useSessionStore, type PrimaryAgentMode, type Session, type SessionListStatus } from '../stores/session'
import { useActiveWorkspaceSupport } from '../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../stores/session-workspace-keys'
import { formatDate, t } from '../helpers/i18n'
import { allowedPrimaryAgentModes, constrainedPrimaryAgentMode, PRIMARY_AGENT_MODES, primaryAgentLeadLabel } from '../helpers/primary-agent-mode'
import { displaySessionTitle } from '../helpers/session-title'
import { useMentionableAgents } from './chat/useChatInputRuntime'
import type { Attachment } from './chat/chat-input-types'
import type { HomePromptOptions } from './home/home-prompt-options'
import { Button, Card, Icon, Skeleton } from '@open-cowork/ui'

// Home is the welcoming landing surface for the simplified core product:
// start a normal chat, @mention a coworker, or pick up recent work.

interface Props {
  brandName: string
  homeBranding?: BrandingHomeConfig
  onStartThread: (text: string, attachments?: Attachment[], agent?: string, options?: HomePromptOptions) => Promise<void>
  onOpenThread: (sessionId: string) => void | Promise<void>
  onReloadSessions?: () => void | Promise<void>
}

// Single, stable greeting. We experimented with a rotation but the
// product voice is clearer with one line: it's the tagline for the
// landing surface, not a random fortune-cookie. The i18n key stays
// so downstream forks can retune the voice without patching this file.
const GREETING_KEY = 'studioHome.greeting'
const GREETING_FALLBACK = 'What should your team tackle today?'

// Prototype greeting: "Good evening." at 44px with the time-of-day word in accent.
// (The reference shows a personal name there; the desktop has no user-name source,
// so the time-of-day word carries the accent emphasis.)
function timeOfDayGreeting(): { lead: string; accent: string } {
  const hour = new Date().getHours()
  const accent = hour < 12
    ? t('studioHome.greeting.morning', 'morning')
    : hour < 18
      ? t('studioHome.greeting.afternoon', 'afternoon')
      : t('studioHome.greeting.evening', 'evening')
  return { lead: t('studioHome.greeting.lead', 'Good'), accent }
}

const MAX_RECENT_SESSIONS = 4
const EMPTY_STARTER = {
  title: 'Plan a release',
  prompt: 'Draft a release plan for the next milestone.',
  agentMode: 'plan',
} satisfies { title: string; prompt: string; agentMode: PrimaryAgentMode }

function interpolateCopy(value: string, vars?: Record<string, string | number>) {
  if (!vars) return value
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    const replacement = vars[key]
    return replacement === undefined ? match : String(replacement)
  })
}

function configuredCopy(
  configured: string | undefined,
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
) {
  const trimmed = configured?.trim()
  if (trimmed) return interpolateCopy(trimmed, vars)
  return t(key, fallback, vars)
}

function HomeRecentWork({
  sessions,
  status,
  error,
  smartSuggestions,
  allowedPrimaryModes,
  onOpen,
  onRetry,
  onPickStarter,
}: {
  sessions: Session[]
  status: SessionListStatus
  error: string | null
  smartSuggestions: boolean
  allowedPrimaryModes: PrimaryAgentMode[]
  onOpen: (sessionId: string) => void
  onRetry?: () => void
  onPickStarter: (prompt: string, agentMode: PrimaryAgentMode) => void
}) {
  const starterAgent = constrainedPrimaryAgentMode(EMPTY_STARTER.agentMode, allowedPrimaryModes)

  return (
    <section className="home-density-recent w-full" aria-labelledby="home-recent-title" aria-busy={status === 'loading'}>
      <div className="mb-3 flex items-center gap-3">
        <h2 id="home-recent-title" className="font-display text-sm font-semibold text-text">
          {t('home.recent.title', 'Recent work')}
        </h2>
        <span className="home-recent-accent" aria-hidden="true" />
      </div>

      {status === 'loading' ? (
        <div className="grid gap-2" role="status" aria-label={t('home.recent.loading', 'Loading recent work')}>
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : null}

      {status === 'error' ? (
        <Card padding="md" role="alert" className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text">{t('home.recent.errorTitle', 'Recent work is unavailable')}</div>
            <div className="mt-1 text-xs text-text-muted">{error || t('home.recent.errorBody', 'Try loading your conversations again.')}</div>
          </div>
          {onRetry ? (
            <Button variant="secondary" size="sm" leftIcon="rotate-ccw" onClick={onRetry}>
              {t('home.recent.retry', 'Retry')}
            </Button>
          ) : null}
        </Card>
      ) : null}

      {status !== 'loading' && sessions.length > 0 ? (
        <ul className="grid gap-2" aria-label={t('home.recent.listLabel', 'Recent conversations')}>
          {sessions.map((session) => (
            <li key={session.id}>
              <Card
                interactive
                padding="sm"
                className="flex w-full items-center gap-3 text-start"
                onClick={() => onOpen(session.id)}
                aria-label={t('home.recent.resumeLabel', 'Resume {{title}}', {
                  title: displaySessionTitle(session) || t('session.untitled', 'Untitled chat'),
                })}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border-subtle bg-elevated text-text-secondary" aria-hidden="true">
                  <Icon name="message-square" size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">
                    {displaySessionTitle(session) || t('session.untitled', 'Untitled chat')}
                  </span>
                  <span className="mt-0.5 block text-2xs text-text-muted">
                    {t('home.recent.updated', 'Updated {{when}}', {
                      when: formatDate(session.updatedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                    })}
                  </span>
                </span>
                <Icon name="chevron-right" size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      {status === 'ready' && sessions.length === 0 ? (
        <Card padding="md" className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text">{t('home.recent.emptyTitle', 'Start your first conversation')}</div>
            <p className="mt-1 text-xs text-text-muted">
              {t('home.recent.emptyBody', 'Describe the outcome above, attach context, or @mention a coworker.')}
            </p>
          </div>
          {smartSuggestions && allowedPrimaryModes.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon="sparkles"
              onClick={() => onPickStarter(EMPTY_STARTER.prompt, starterAgent)}
              title={`${EMPTY_STARTER.prompt} · ${primaryAgentLeadLabel(starterAgent)}`}
            >
              {t('home.recent.tryStarter', 'Try a starter')}
            </Button>
          ) : null}
        </Card>
      ) : null}
    </section>
  )
}

export function HomePage({ brandName, homeBranding, onStartThread, onOpenThread, onReloadSessions }: Props) {
  const sessions = useSessionStore((s) => s.sessions)
  const sessionListStatus = useSessionStore((s) => s.sessionListStatusByWorkspace[s.activeWorkspaceId] || 'loading')
  const sessionListError = useSessionStore((s) => s.sessionListErrorByWorkspace[s.activeWorkspaceId] || null)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const [submitting, setSubmitting] = useState(false)
  const [promptPrefill, setPromptPrefill] = useState<{ text: string; nonce: number } | null>(null)
  // JOE-855: honor Settings → Smart suggestions for the one empty-state starter.
  const [smartSuggestions, setSmartSuggestions] = useState(true)
  const workspaceSupport = useActiveWorkspaceSupport()
  const activeWorkspaceIsLocal = workspaceSupport.workspaceId === LOCAL_WORKSPACE_ID
  const workspaceOptions = useMemo(
    () => activeWorkspaceIsLocal ? undefined : { workspaceId: workspaceSupport.workspaceId },
    [activeWorkspaceIsLocal, workspaceSupport.workspaceId],
  )
  const [allowedPrimaryModes, setAllowedPrimaryModes] = useState<PrimaryAgentMode[]>(() => [...PRIMARY_AGENT_MODES])
  const [allowedAgentNames, setAllowedAgentNames] = useState<string[] | null>(null)
  const [fallbackPromptAgent, setFallbackPromptAgent] = useState<string | null>(null)
  const [agentPolicyStatus, setAgentPolicyStatus] = useState<'ready' | 'loading' | 'error'>('ready')
  const specialistAgents = useMentionableAgents(null, workspaceOptions)

  const recentSessions = useMemo(
    () => sessions
      .filter((session) => (session.kind || 'interactive') === 'interactive')
      .slice()
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, MAX_RECENT_SESSIONS),
    [sessions],
  )
  useEffect(() => {
    let cancelled = false
    void window.coworkApi.settings.get().then((settings) => {
      if (cancelled) return
      setSmartSuggestions(settings.notificationSmartSuggestions !== false)
    }).catch(() => {
      if (!cancelled) setSmartSuggestions(true)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (activeWorkspaceIsLocal) {
      setAllowedPrimaryModes([...PRIMARY_AGENT_MODES])
      setAllowedAgentNames(null)
      setFallbackPromptAgent(null)
      setAgentPolicyStatus('ready')
      return () => {
        cancelled = true
      }
    }

    setAgentPolicyStatus('loading')
    setAllowedPrimaryModes([])
    setAllowedAgentNames([])
    setFallbackPromptAgent(null)
    void window.coworkApi.workspace.policy(workspaceSupport.workspaceId).then((policy) => {
      if (cancelled) return
      setAllowedPrimaryModes(allowedPrimaryAgentModes(policy.allowedAgents))
      setAllowedAgentNames(Array.isArray(policy.allowedAgents) ? policy.allowedAgents : null)
      setFallbackPromptAgent(Array.isArray(policy.allowedAgents) ? policy.allowedAgents[0] || null : null)
      setAgentPolicyStatus('ready')
    }).catch(() => {
      if (!cancelled) {
        setAllowedPrimaryModes([])
        setAllowedAgentNames([])
        setFallbackPromptAgent(null)
        setAgentPolicyStatus('error')
      }
    })

    return () => {
      cancelled = true
    }
  }, [activeWorkspaceIsLocal, workspaceSupport.workspaceId])

  const agentPolicyReady = activeWorkspaceIsLocal || agentPolicyStatus === 'ready'
  const effectiveAllowedPrimaryModes = useMemo(
    () => (agentPolicyReady ? allowedPrimaryModes : []),
    [agentPolicyReady, allowedPrimaryModes],
  )
  const effectiveAllowedAgentNames = agentPolicyReady ? allowedAgentNames : []
  const effectiveFallbackPromptAgent = agentPolicyReady ? fallbackPromptAgent : null
  const canPromptFromHome = workspaceSupport.flags.canPrompt && agentPolicyReady
  const promptDisabledReason = agentPolicyReady ? workspaceSupport.flags.reasons.prompt : t('home.assign.policyLoading', 'Checking cloud profile policy.')

  useEffect(() => {
    const nextMode = constrainedPrimaryAgentMode(useSessionStore.getState().agentMode, effectiveAllowedPrimaryModes)
    if (nextMode !== useSessionStore.getState().agentMode) setAgentMode(nextMode)
  }, [effectiveAllowedPrimaryModes, setAgentMode])

  const handleSubmit = useCallback(async (text: string, attachments: Attachment[], agent?: string, options?: HomePromptOptions) => {
    if (submitting) return
    if (attachments.length > 0 && !workspaceSupport.flags.canAttachFiles) {
      useSessionStore.getState().addGlobalError(workspaceSupport.flags.reasons.attachFiles)
      return
    }
    setSubmitting(true)
    try {
      const scopedOptions = activeWorkspaceIsLocal
        ? options
        : { ...(options || {}), workspaceId: workspaceSupport.workspaceId }
      if (scopedOptions) {
        await onStartThread(text, attachments, agent, scopedOptions)
      } else {
        await onStartThread(text, attachments, agent)
      }
    } finally {
      setSubmitting(false)
    }
  }, [activeWorkspaceIsLocal, onStartThread, submitting, workspaceSupport.flags, workspaceSupport.workspaceId])

  const handlePickExample = useCallback((prompt: string, nextAgentMode: PrimaryAgentMode) => {
    setAgentMode(constrainedPrimaryAgentMode(nextAgentMode, effectiveAllowedPrimaryModes))
    setPromptPrefill({ text: prompt, nonce: Date.now() })
  }, [effectiveAllowedPrimaryModes, setAgentMode])

  const handleOpenThread = useCallback((sessionId: string) => {
    void onOpenThread(sessionId)
  }, [onOpenThread])

  const homeCopyVars = { brand: brandName }
  // A configured/branded greeting wins; otherwise the time-of-day greeting.
  const brandedGreeting = homeBranding?.greeting?.trim()
    ? configuredCopy(homeBranding.greeting, GREETING_KEY, GREETING_FALLBACK, homeCopyVars)
    : null
  const timeGreeting = timeOfDayGreeting()
  const subtitle = configuredCopy(
    homeBranding?.subtitle,
    'studioHome.subtitle',
    '{{brand}} · Start a conversation or resume recent work',
    homeCopyVars,
  )
  const composerPlaceholder = configuredCopy(
    homeBranding?.composerPlaceholder,
    'studioHome.composer.placeholder',
    'Ask anything, or @mention a coworker',
    homeCopyVars,
  )
  return (
    // Sits on the themed --color-base + its --bg-image aurora wash (set per theme).
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="home-view">
      <div className="measure-column px-6 pt-[clamp(56px,10vh,104px)] pb-16 flex flex-col items-center">
        <h1 className="font-display text-hero leading-[1.04] font-semibold text-text text-center">
          {brandedGreeting ?? (
            <>{timeGreeting.lead} <span className="studio-greeting-accent">{timeGreeting.accent}</span>.</>
          )}
        </h1>
        <p className="mt-3 text-sm text-text-muted text-center">
          {subtitle}
        </p>

        <div className="home-density-composer w-full">
          <HomeComposer
            onSubmit={handleSubmit}
            disabled={submitting}
            placeholder={composerPlaceholder}
            specialistAgents={specialistAgents}
            allowedPrimaryModes={effectiveAllowedPrimaryModes}
            allowedAgentNames={effectiveAllowedAgentNames}
            fallbackAgent={effectiveFallbackPromptAgent}
            prefillAgent={null}
            prefillPrompt={promptPrefill}
            workspaceOptions={workspaceOptions}
            canPrompt={canPromptFromHome}
            sendDisabledReason={promptDisabledReason}
            attachmentsAllowed={workspaceSupport.flags.canAttachFiles}
            attachmentsDisabledReason={workspaceSupport.flags.reasons.attachFiles}
            modelControlsManaged={!workspaceSupport.flags.canUseMachineRuntimeConfig}
            modelControlsReason={workspaceSupport.flags.reasons.machineRuntimeConfig}
          />
        </div>

        <HomeRecentWork
          sessions={recentSessions}
          status={sessionListStatus}
          error={sessionListError}
          smartSuggestions={smartSuggestions}
          allowedPrimaryModes={effectiveAllowedPrimaryModes}
          onOpen={handleOpenThread}
          onRetry={onReloadSessions ? () => { void onReloadSessions() } : undefined}
          onPickStarter={handlePickExample}
        />
      </div>
    </div>
  )
}
