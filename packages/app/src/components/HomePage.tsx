import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HomeComposer } from './home/HomeComposer'
import type {
  BrandingHomeConfig, LaunchpadFeedPayload, LaunchpadFreshArtifactItem, } from '@open-cowork/shared'
import { useSessionStore, type PrimaryAgentMode } from '../stores/session'
import { useActiveWorkspaceSupport } from '../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../stores/session-workspace-keys'
import type { AppNavigationTarget } from '../app-types'
import { formatAgentLabel } from '../helpers/agent-label'
import { t } from '../helpers/i18n'
import { summarizeMcpConnections } from '../helpers/mcp-status-summary'
import { allowedPrimaryAgentModes, constrainedPrimaryAgentMode, PRIMARY_AGENT_MODES, primaryAgentLeadLabel } from '../helpers/primary-agent-mode'
import { useMentionableAgents } from './chat/useChatInputRuntime'
import type { Attachment } from './chat/chat-input-types'
import type { HomePromptOptions } from './home/home-prompt-options'
import {
  Card, EmptyState, Icon, IconButton, type IconName } from '@open-cowork/ui'
import { MAX_MOTION_ITEMS } from './launchpad/constants'

const LaunchpadMotionGrid = lazy(() => import('./launchpad/LaunchpadMotionGrid').then((module) => ({
  default: module.LaunchpadMotionGrid,
})))
const HomeReviewSnapshot = lazy(() => import('./home/HomeReviewSnapshot').then((module) => ({
  default: module.HomeReviewSnapshot,
})))

// Home is the welcoming landing surface for the simplified core product:
// start a normal chat, @mention a coworker, or pick up recent work.

interface Props {
  brandName: string
  homeBranding?: BrandingHomeConfig
  onStartThread: (text: string, attachments?: Attachment[], agent?: string, options?: HomePromptOptions) => Promise<void>
  onOpenThread: (sessionId: string) => void | Promise<void>
  onNavigate: (target: AppNavigationTarget) => void
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

// Cap on how many coworker cards and how many recent project chats we
// show. Kept small deliberately — the page is "get started", not
// "everything at once".
const MAX_SUGGESTIONS = 4
const HOME_COACHMARK_DISMISSED_KEY = 'open-cowork-home-coachmark-dismissed'

// Each starter card carries a tone so its icon sits in a soft colored tile
// (matching the Studio reference's teal/blue/amber suggestion tiles) instead of
// a flat inline accent icon. Tones map to the muted Mercury palette tokens.
type SuggestionTone = 'accent' | 'green' | 'amber' | 'info'

const EXAMPLE_PROMPTS = [
  {
    title: 'Plan a release',
    prompt: 'Draft a release plan for the next milestone.',
    agentMode: 'plan',
    icon: 'kanban',
    tone: 'accent',
  },
  {
    title: 'Review a change',
    prompt: 'Review the recent changes and call out production risks.',
    agentMode: 'build',
    icon: 'file-diff',
    tone: 'green',
  },
  {
    title: 'Create a workflow',
    prompt: 'Help me turn a repeated task into a saved workflow.',
    agentMode: 'chief-of-staff',
    icon: 'workflow',
    tone: 'amber',
  },
  {
    title: 'Investigate an issue',
    prompt: 'Trace this bug from symptoms to a concrete fix.',
    agentMode: 'build',
    icon: 'search',
    tone: 'info',
  },
] satisfies Array<{ title: string; prompt: string; agentMode: PrimaryAgentMode; icon: IconName; tone: SuggestionTone }>

const EMPTY_LAUNCHPAD_FEED: LaunchpadFeedPayload = {
  generatedAt: '',
  inProgress: [],
  waitingOnYou: [],
  freshArtifacts: [],
  totals: {
    inProgress: 0,
    waitingOnYou: 0,
    freshArtifacts: 0,
  },
  truncated: {
    inProgress: false,
    waitingOnYou: false,
    freshArtifacts: false,
  },
}

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

function readHomeCoachmarkDismissed() {
  try {
    return window.localStorage.getItem(HOME_COACHMARK_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

function LaunchpadSuggestions({
  allowedPrimaryModes,
  onPick,
}: {
  allowedPrimaryModes: PrimaryAgentMode[]
  onPick: (prompt: string, agentMode: PrimaryAgentMode) => void
}) {
  return (
    <div className="w-full mt-7">
      <EmptyState
        icon="sparkles"
        title={t('home.suggestions.launchpadTitle', 'Start with a handoff')}
        body={t('home.suggestions.launchpadBody', 'Pick a starter task, choose the lead coworker, then adjust the prompt for your work.')}
      />
      <div className="home-example-grid">
        {EXAMPLE_PROMPTS.map((example) => {
          const primaryLeadAvailable = allowedPrimaryModes.length > 0
          const agentMode = constrainedPrimaryAgentMode(example.agentMode, allowedPrimaryModes)
          const content = (
              <div className="flex items-start gap-3">
                <span className="home-sug-tile" data-tone={example.tone} aria-hidden="true">
                  <Icon name={example.icon} size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{example.title}</span>
                  <span className="mt-1 block text-2xs leading-snug text-text-muted">{example.prompt}</span>
                  <span className="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-text-secondary">
                    <Icon name="at-sign" size={16} />
                    {primaryLeadAvailable
                      ? primaryAgentLeadLabel(agentMode)
                      : t('home.suggestions.noPrimaryLead', 'No primary lead in this profile')}
                  </span>
                </span>
              </div>
          )
          return primaryLeadAvailable ? (
            <Card
              key={example.title}
              interactive
              padding="md"
              onClick={() => onPick(example.prompt, agentMode)}
              aria-label={`${example.title}: ${example.prompt}`}
            >
              {content}
            </Card>
          ) : (
            <Card
              key={example.title}
              padding="md"
              aria-disabled="true"
              aria-label={`${example.title}: ${example.prompt}`}
            >
              {content}
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function TeamStrip({
  agents,
  allowedPrimaryModes,
  allowedAgentNames,
  onNavigate,
}: {
  agents: Array<{ id: string; label: string }>
  allowedPrimaryModes: PrimaryAgentMode[]
  allowedAgentNames?: string[] | null
  onNavigate: (target: AppNavigationTarget) => void
}) {
  const primaryAgentOptions = [
    { id: 'build', label: t('home.coworkers.build.name', 'Build') },
    { id: 'plan', label: t('home.coworkers.plan.name', 'Plan') },
    { id: 'chief-of-staff', label: t('home.coworkers.cleo.name', 'Cleo') },
  ] satisfies Array<{ id: PrimaryAgentMode; label: string }>
  const primaryAgents = primaryAgentOptions.filter((agent) => allowedPrimaryModes.includes(agent.id))
  const knownAgentIds = new Set([...primaryAgents.map((agent) => agent.id), ...agents.map((agent) => agent.id)])
  const specialistAgents = allowedAgentNames
    ? agents.filter((agent) => allowedAgentNames.includes(agent.id))
    : agents
  const allowedUnknownAgents = allowedAgentNames
    ? allowedAgentNames
      .filter((agentId) => !knownAgentIds.has(agentId))
      .map((agentId) => ({ id: agentId, label: formatAgentLabel(agentId) }))
    : []
  const team = [...primaryAgents, ...specialistAgents, ...allowedUnknownAgents].slice(0, 8)
  const teamCount = allowedAgentNames ? allowedAgentNames.length : primaryAgents.length + agents.length

  return (
    <button type="button" className="home-team-strip mt-9" onClick={() => onNavigate('team')}>
      <span className="home-team-label">{t('home.team.title', 'Your team')}</span>
      <span className="home-team-avatars" aria-hidden="true">
        {team.map((agent) => (
          <span key={agent.id} className="home-team-avatar">{agent.label.slice(0, 2).toUpperCase()}</span>
        ))}
      </span>
      <span className="home-team-label">
        {t('home.team.manage', '{{count}} coworkers · manage', { count: teamCount })}
      </span>
    </button>
  )
}

function HomeCoachmark({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="home-coachmark mt-7">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="sparkles" size={16} className="shrink-0 text-accent" />
        <span className="min-w-0">{t('studioHome.coachmark', 'Type a prompt, attach context, or @mention a coworker — ⌘K for commands.')}</span>
      </div>
      <IconButton
        icon="x"
        label={t('home.dismissCoachmark', 'Dismiss Home tip')}
        size="sm"
        onClick={onDismiss}
      />
    </div>
  )
}

function StatusStrip({ readyLabel }: { readyLabel: string }) {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const summary = summarizeMcpConnections(mcpConnections)
  const connected = summary.connected.length
  const total = summary.total

  return (
    <div className="home-status-strip mt-10 inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-border-subtle text-xs text-text-muted">
      <span
        className={`mcp-dot ${total > 0 && connected === total ? 'mcp-dot--up' : 'mcp-dot--degraded'}`}
        aria-hidden
      />
      <span className="text-text-secondary font-[560]">{readyLabel}</span>
      <span className="opacity-40" aria-hidden>·</span>
      <span className="tabular">{t('home.statusStrip.mcps', '{{connected}}/{{total}} MCPs', { connected, total })}</span>
    </div>
  )
}

export function HomePage({ brandName, homeBranding, onStartThread, onOpenThread, onNavigate }: Props) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentView = useSessionStore((s) => s.currentView)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const [submitting, setSubmitting] = useState(false)
  const [promptPrefill, setPromptPrefill] = useState<{ text: string; nonce: number } | null>(null)
  const [coachmarkDismissed, setCoachmarkDismissed] = useState(readHomeCoachmarkDismissed)
  const [launchpadFeed, setLaunchpadFeed] = useState<LaunchpadFeedPayload>(EMPTY_LAUNCHPAD_FEED)
  const [launchpadLoading, setLaunchpadLoading] = useState(true)
  const [launchpadInitialized, setLaunchpadInitialized] = useState(false)
  const [launchpadError, setLaunchpadError] = useState<string | null>(null)
  // Bumped by the "Refresh" affordance so a failed feed fetch isn't a dead end;
  // wired into the feed effect deps below to re-run the same fetch on demand.
  const [launchpadRefreshNonce, setLaunchpadRefreshNonce] = useState(0)
  const launchpadRequestIdRef = useRef(0)
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

  const suggestedAgents = useMemo(() => {
    return specialistAgents
      .map((agent) => ({
        id: agent.id,
        label: agent.label || formatAgentLabel(agent.id),
        description: agent.description || '',
      }))
      .slice(0, MAX_SUGGESTIONS)
  }, [specialistAgents])

  const firstRun = sessions.filter((session) => (session.kind || 'interactive') === 'interactive').length === 0
  const sessionFeedKey = useMemo(
    () => sessions
      .map((session) => `${session.id}:${session.updatedAt}:${session.title || ''}:${session.kind || 'interactive'}`)
      .join('|'),
    [sessions],
  )

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

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      const requestId = launchpadRequestIdRef.current + 1
      launchpadRequestIdRef.current = requestId
      setLaunchpadLoading(true)
      setLaunchpadError(null)
      void window.coworkApi.launchpad.feed({
        ...(workspaceOptions || {}),
        limit: MAX_MOTION_ITEMS,
      }).then((feed) => {
        if (cancelled || requestId !== launchpadRequestIdRef.current) return
        setLaunchpadFeed(feed)
      }).catch((error) => {
        if (cancelled || requestId !== launchpadRequestIdRef.current) return
        setLaunchpadFeed(EMPTY_LAUNCHPAD_FEED)
        setLaunchpadError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (!cancelled && requestId === launchpadRequestIdRef.current) {
          setLaunchpadLoading(false)
          setLaunchpadInitialized(true)
        }
      })
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [
    workspaceOptions,
    sessionFeedKey,
    currentView.lastEventAt,
    currentView.revision,
    launchpadRefreshNonce,
  ])

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

  const handleDismissCoachmark = useCallback(() => {
    setCoachmarkDismissed(true)
    try {
      window.localStorage.setItem(HOME_COACHMARK_DISMISSED_KEY, 'true')
    } catch {
      // Home coachmark dismissal is cosmetic; ignore storage failures.
    }
  }, [])

  const handleOpenThread = useCallback((sessionId: string) => {
    void onOpenThread(sessionId)
  }, [onOpenThread])

  const handleOpenArtifact = useCallback((item: LaunchpadFreshArtifactItem) => {
    if (activeWorkspaceIsLocal && item.sessionId && item.artifactId.startsWith('local-artifact-')) {
      // Local feed artifact ids are privacy-preserving aliases; open the source thread instead of dispatching an unresolvable resource identity.
      void onOpenThread(item.sessionId)
      return
    }

    if (item.sessionId && item.artifactId) {
      window.dispatchEvent(new CustomEvent('open-cowork:open-resource', {
        detail: {
          identity: {
            format: 'open-cowork-resource-identity-v1',
            authority: activeWorkspaceIsLocal ? 'desktop-local' : 'desktop-cloud',
            kind: 'artifact',
            workspaceId: workspaceSupport.workspaceId,
            sessionId: item.sessionId,
            artifactId: item.artifactId,
          },
        },
      }))
      return
    }
    onNavigate('artifacts')
  }, [activeWorkspaceIsLocal, onNavigate, onOpenThread, workspaceSupport.workspaceId])

  const homeCopyVars = { brand: brandName }
  // A configured/branded greeting wins; otherwise the time-of-day greeting.
  const brandedGreeting = homeBranding?.greeting?.trim()
    ? configuredCopy(homeBranding.greeting, GREETING_KEY, GREETING_FALLBACK, homeCopyVars)
    : null
  const timeGreeting = timeOfDayGreeting()
  const subtitle = configuredCopy(
    homeBranding?.subtitle,
    'studioHome.subtitle',
    '{{brand}} · Choose a lead coworker, @mention specialists, and review the work in one place',
    homeCopyVars,
  )
  const composerPlaceholder = configuredCopy(
    homeBranding?.composerPlaceholder,
    'studioHome.composer.placeholder',
    'Ask anything, or @mention a coworker',
    homeCopyVars,
  )
  const readyLabel = configuredCopy(homeBranding?.statusReadyLabel, 'home.statusStrip.ready', 'Ready', homeCopyVars)

  return (
    // Sits on the themed --color-base + its --bg-image aurora wash (set per theme).
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="home-view">
      <div className="measure-column px-6 pt-[clamp(72px,13vh,142px)] pb-16 flex flex-col items-center">
        <h1 className="font-display text-hero leading-[1.04] font-semibold text-text text-center">
          {brandedGreeting ?? (
            <>{timeGreeting.lead} <span className="studio-greeting-accent">{timeGreeting.accent}</span>.</>
          )}
        </h1>
        <p className="mt-3 text-sm text-text-muted text-center">
          {subtitle}
        </p>

        <div className="w-full mt-9">
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

        {firstRun && !coachmarkDismissed && <HomeCoachmark onDismiss={handleDismissCoachmark} />}

        <LaunchpadSuggestions allowedPrimaryModes={effectiveAllowedPrimaryModes} onPick={handlePickExample} />

        {launchpadInitialized ? (
          <Suspense fallback={<div className="home-motion w-full mt-10 text-center text-xs text-text-muted" role="status">{t('home.motion.loading', 'Loading')}</div>}>
            <LaunchpadMotionGrid
              feed={launchpadFeed}
              loading={launchpadLoading}
              error={launchpadError}
              onNavigate={onNavigate}
              onOpenThread={handleOpenThread}
              onOpenArtifact={handleOpenArtifact}
              onRefresh={() => setLaunchpadRefreshNonce((nonce) => nonce + 1)}
            />
          </Suspense>
        ) : (
          <div className="home-motion w-full mt-10 text-center text-xs text-text-muted" role="status" aria-live="polite">
            {t('home.motion.loading', 'Loading')}
          </div>
        )}

        <TeamStrip
          agents={suggestedAgents}
          allowedPrimaryModes={effectiveAllowedPrimaryModes}
          allowedAgentNames={effectiveAllowedAgentNames}
          onNavigate={onNavigate}
        />

        {(currentView.pendingApprovals.length > 0 || currentView.pendingQuestions.length > 0 || currentView.taskRuns.length > 0) && (
          <Suspense fallback={<div className="w-full mt-8 text-center text-xs text-text-muted" role="status">{t('home.review.loading', 'Loading review snapshot...')}</div>}>
            <HomeReviewSnapshot
              pendingApprovals={currentView.pendingApprovals.length}
              pendingQuestions={currentView.pendingQuestions.length}
              taskCount={currentView.taskRuns.length}
            />
          </Suspense>
        )}

        <StatusStrip readyLabel={readyLabel} />
      </div>
    </div>
  )
}
