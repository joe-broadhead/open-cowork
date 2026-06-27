import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  LaunchpadFeedPayload,
  LaunchpadFreshArtifactItem,
  LaunchpadInProgressItem,
  LaunchpadWaitingItem,
} from '@open-cowork/shared'
import { Badge, Button, EmptyState, Icon, type IconName, ReviewPanel, TaskLane } from '@open-cowork/ui'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { errorMessage, setCloudStatus } from './react-workbench-controller.ts'
import { CloudLaunchpadComposer } from './react-workbench-launchpad-composer.tsx'
import type { CloudWebCoworkerOption } from './surface-workbench.ts'

// The launchpad refresh affordance and the feed hook live in this same module but
// are wired through separate React trees (the SSR shell mounts the portal, the app
// owns the hook). A lightweight DOM event bridges them so the "Try again" button
// can re-run the same feed fetch without threading a new prop through portals.tsx,
// which other batches own. Both ends are defined here, so the contract stays local.
const LAUNCHPAD_REFRESH_EVENT = 'cloud-launchpad:refresh'

function requestLaunchpadRefresh() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(LAUNCHPAD_REFRESH_EVENT))
}

// The launchpad icon tones mirror desktop's HomePage starter cards: each suggestion
// and motion column sits in a soft tone-tinted tile carrying the shared lucide glyph
// (same icon choices as desktop's LaunchpadSuggestions / LaunchpadMotionGrid).
type CloudLaunchpadTone = 'accent' | 'green' | 'amber' | 'info'

type CloudLaunchpadSuggestion = {
  title: string
  prompt: string
  agent: string
  icon: IconName
  tone: CloudLaunchpadTone
}

const SUGGESTIONS: CloudLaunchpadSuggestion[] = [
  {
    title: 'Plan a release',
    prompt: 'Draft a release plan for the next milestone.',
    agent: 'plan',
    icon: 'kanban',
    tone: 'accent',
  },
  {
    title: 'Review a change',
    prompt: 'Review the recent changes and call out production risks.',
    agent: 'build',
    icon: 'file-diff',
    tone: 'green',
  },
  {
    title: 'Create a workflow',
    prompt: 'Help me turn a repeated task into a saved workflow.',
    agent: 'chief-of-staff',
    icon: 'workflow',
    tone: 'amber',
  },
  {
    title: 'Investigate an issue',
    prompt: 'Trace this bug from symptoms to a concrete fix.',
    agent: 'build',
    icon: 'search',
    tone: 'info',
  },
]

// Mirrors desktop HomePage.timeOfDayGreeting: a time-of-day-aware heading. The
// cloud web client has no user-name source either, so the time-of-day word carries
// the accent emphasis (same treatment as desktop).
function timeOfDayGreeting(): { lead: string; accent: string } {
  const hour = new Date().getHours()
  const accent = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  return { lead: 'Good', accent }
}

// Mirrors desktop's primaryAgentLeadLabel: each starter card is labelled with its
// LEAD coworker ("Plan lead" / "Build lead" / "Cleo lead"), not "@plan can take
// this". For non-primary specialists we fall back to the coworker's display name.
function leadCoworkerLabel(agent: string, coworkerOptions: CloudWebCoworkerOption[]) {
  if (agent === 'plan') return 'Plan lead'
  if (agent === 'chief-of-staff') return 'Cleo lead'
  if (agent === 'build') return 'Build lead'
  if (!agent) return 'Profile default lead'
  const option = coworkerOptions.find((candidate) => candidate.name === agent)
  return `${option?.displayName || agent} lead`
}

export const EMPTY_CLOUD_LAUNCHPAD_FEED: LaunchpadFeedPayload = {
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

type CloudLaunchpadApi = {
  launchpad: {
    feed: (input: { limit: number }) => Promise<unknown>
  }
}

export function useCloudLaunchpad({
  api,
  onDraft,
}: {
  api: CloudLaunchpadApi
  onDraft: (prompt: string, agentName: string) => void
}) {
  const [feed, setFeed] = useState<LaunchpadFeedPayload>(EMPTY_CLOUD_LAUNCHPAD_FEED)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const loadFeed = useCallback(async () => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    setError(null)
    try {
      const nextFeed = await api.launchpad.feed({ limit: 3 }) as LaunchpadFeedPayload
      if (requestId === requestIdRef.current) setFeed(nextFeed)
    } catch (nextError) {
      if (requestId !== requestIdRef.current) return
      setFeed(EMPTY_CLOUD_LAUNCHPAD_FEED)
      const message = errorMessage(nextError)
      setError(message)
      setCloudStatus(message, 'warn')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [api])

  const startSuggestion = useCallback((prompt: string, agentName: string) => {
    onDraft(prompt, agentName)
  }, [onDraft])

  // Bridge the portal's "Try again" button (rendered in a separate tree) back to
  // this hook so a failed feed fetch isn't a dead end — re-runs the same request.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleRefresh = () => { void loadFeed() }
    window.addEventListener(LAUNCHPAD_REFRESH_EVENT, handleRefresh)
    return () => window.removeEventListener(LAUNCHPAD_REFRESH_EVENT, handleRefresh)
  }, [loadFeed])

  return { feed, loading, error, loadFeed, startSuggestion }
}

function formatWhen(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function itemMeta(item: LaunchpadInProgressItem | LaunchpadWaitingItem | LaunchpadFreshArtifactItem) {
  return [
    item.projectTitle || item.taskTitle || null,
    item.assigneeAgent ? `@${item.assigneeAgent}` : null,
    formatWhen(item.when),
  ].filter(Boolean).join(' · ')
}

function suggestionAgent(agent: string, coworkerOptions: CloudWebCoworkerOption[], hasExplicitAllowedAgents: boolean) {
  if (!hasExplicitAllowedAgents) return agent
  return coworkerOptions.some((candidate) => candidate.name === agent)
    ? agent
    : coworkerOptions[0]?.name || ''
}

type MotionColumnProps<TItem> = {
  title: string
  icon: IconName
  tone: CloudLaunchpadTone
  total: number
  truncated: boolean
  accent?: boolean
  items: TItem[]
  empty: string
  badge: (item: TItem) => string
  onOpen: (item: TItem) => void
}

function MotionColumn<TItem extends LaunchpadInProgressItem | LaunchpadWaitingItem | LaunchpadFreshArtifactItem>({
  title,
  icon,
  tone,
  total,
  truncated,
  accent,
  items,
  empty,
  badge,
  onOpen,
}: MotionColumnProps<TItem>) {
  return (
    <div className="cloud-launchpad-motion-col">
      <div className="cloud-launchpad-motion-col__head">
        <span><span className="cloud-launchpad-motion-col__icon" data-tone={tone} aria-hidden="true"><Icon name={icon} size={16} /></span> {title}</span>
        <Badge
          tone={accent && total > 0 ? 'accent' : 'neutral'}
          className={accent && total > 0 ? 'cloud-launchpad-motion-alert-badge' : undefined}
        >
          {truncated ? `${total}+` : total}
        </Badge>
      </div>
      <div className="cloud-launchpad-motion-list">
        {items.length ? items.map((item) => (
          <button key={item.id} className="cloud-launchpad-motion-row" type="button" onClick={() => onOpen(item)}>
            <span className="cloud-launchpad-motion-row__icon" data-tone={tone} aria-hidden="true"><Icon name={icon} size={16} /></span>
            <span className="cloud-launchpad-motion-row__text">
              <span className="cloud-launchpad-motion-row__title">{item.title}</span>
              <span className="cloud-launchpad-motion-row__meta">{itemMeta(item)}</span>
            </span>
            <span className="cloud-launchpad-motion-row__badge">{badge(item)}</span>
          </button>
        )) : <div className="cloud-launchpad-motion-empty">{empty}</div>}
      </div>
    </div>
  )
}

export function CloudLaunchpadPortal({
  feed = EMPTY_CLOUD_LAUNCHPAD_FEED,
  loading,
  error,
  coworkerOptions,
  policyKnown,
  hasExplicitAllowedAgents,
  bootstrap,
  allowedAgents,
  activeCoworker,
  composerText,
  composerAgent,
  composerError,
  isSending,
  onSetComposerText,
  onSetComposerAgent,
  onComposerSubmit,
  onSuggestion,
  onOpenRoute,
  onOpenSession,
  onOpenArtifact,
}: {
  feed?: LaunchpadFeedPayload
  loading: boolean
  error: string | null
  coworkerOptions: CloudWebCoworkerOption[]
  policyKnown: boolean
  hasExplicitAllowedAgents: boolean
  bootstrap: CloudWebClientBootstrap
  allowedAgents: string[]
  activeCoworker: string
  composerText: string
  composerAgent: string
  composerError: string | null
  isSending: boolean
  onSetComposerText: Dispatch<SetStateAction<string>>
  onSetComposerAgent: Dispatch<SetStateAction<string>>
  onComposerSubmit: (text: string, agent: string) => void | Promise<void>
  onSuggestion: (prompt: string, agent: string) => void
  onOpenRoute: (route: 'threads' | 'artifacts' | 'agents' | 'chat') => void
  onOpenSession: (sessionId: string) => void
  onOpenArtifact: (item: LaunchpadFreshArtifactItem) => void
}) {
  // First run = the feed has no live activity at all (and isn't still loading it in).
  // Mirrors desktop's "no interactive sessions yet" check, but driven by the cloud
  // feed totals — the only activity signal the launchpad portal receives.
  const hasActivity = feed.totals.inProgress > 0 || feed.totals.waitingOnYou > 0 || feed.totals.freshArtifacts > 0
  const firstRun = !loading && !error && !hasActivity
  const greeting = timeOfDayGreeting()
  // Review snapshot data, mapped from the same feed: waiting items split by kind
  // (permission vs question), plus the in-progress task count for coworker activity.
  const pendingApprovals = feed.waitingOnYou.filter((item) => item.kind === 'permission').length
  const pendingQuestions = feed.waitingOnYou.filter((item) => item.kind === 'question').length
  const pendingInput = feed.totals.waitingOnYou
  const taskCount = feed.totals.inProgress

  return (
    <>
      <div className="cloud-launchpad-hero">
        <h1 className="cloud-launchpad-hero__title">
          {greeting.lead} <span className="cloud-launchpad-hero__accent">{greeting.accent}</span>.
        </h1>
        <p className="cloud-launchpad-hero__subtitle">
          Choose a lead coworker, @mention specialists, and review the work in one place
        </p>
      </div>
      <CloudLaunchpadComposer
        bootstrap={bootstrap}
        allowedAgents={allowedAgents}
        coworkerOptions={coworkerOptions}
        activeCoworker={activeCoworker}
        composerText={composerText}
        composerAgent={composerAgent}
        error={composerError}
        isSending={isSending}
        onSetComposerText={onSetComposerText}
        onSetComposerAgent={onSetComposerAgent}
        onSubmit={onComposerSubmit}
      />
      {firstRun ? (
        <EmptyState
          icon="sparkles"
          title="Start with a handoff"
          body="Pick a starter task, choose the lead coworker, then adjust the prompt for your work."
        />
      ) : null}
      <div className="cloud-launchpad-suggestions" aria-label="Task suggestions">
        {SUGGESTIONS.map((suggestion) => {
          const agent = suggestionAgent(suggestion.agent, coworkerOptions, hasExplicitAllowedAgents)
          const disabled = !policyKnown || (hasExplicitAllowedAgents && !agent)
          return (
            <button
              key={suggestion.title}
              className="cloud-launchpad-suggestion"
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!disabled) onSuggestion(suggestion.prompt, agent)
              }}
            >
              <span className="cloud-launchpad-suggestion__icon" data-tone={suggestion.tone} aria-hidden="true"><Icon name={suggestion.icon} size={20} /></span>
              <span className="cloud-launchpad-suggestion__text">
                <strong>{suggestion.title}</strong>
                <span>{suggestion.prompt}</span>
                <small>{policyKnown ? leadCoworkerLabel(agent, coworkerOptions) : 'Checking profile policy'}</small>
              </span>
            </button>
          )
        })}
      </div>
      <section className="cloud-launchpad-motion" aria-busy={loading}>
        <div className="cloud-launchpad-motion__head">
          <span>In motion</span>
          <span aria-hidden="true" />
          {loading ? <Badge tone="neutral">Loading</Badge> : null}
          {error ? <Badge tone="warning">Feed unavailable</Badge> : null}
        </div>
        <div className="cloud-launchpad-motion-grid">
          <MotionColumn
            title="In progress"
            icon="kanban"
            tone="accent"
            total={feed.totals.inProgress}
            truncated={feed.truncated.inProgress}
            items={feed.inProgress.slice(0, 3)}
            empty="No active tasks yet."
            badge={(item) => item.priority.toUpperCase()}
            onOpen={(item) => item.sessionId ? onOpenSession(item.sessionId) : onOpenRoute('threads')}
          />
          <MotionColumn
            title="Waiting on you"
            icon="bell"
            tone="amber"
            total={feed.totals.waitingOnYou}
            truncated={feed.truncated.waitingOnYou}
            accent
            items={feed.waitingOnYou.slice(0, 3)}
            empty="No approvals or questions waiting."
            badge={(item) => item.kind === 'permission' ? 'Approval' : 'Question'}
            onOpen={(item) => item.sessionId ? onOpenSession(item.sessionId) : onOpenRoute('chat')}
          />
          <MotionColumn
            title="Fresh artifacts"
            icon="file"
            tone="info"
            total={feed.totals.freshArtifacts}
            truncated={feed.truncated.freshArtifacts}
            items={feed.freshArtifacts.slice(0, 3)}
            empty="No new artifacts yet."
            badge={(item) => item.status}
            onOpen={onOpenArtifact}
          />
        </div>
        {error ? (
          <div className="cloud-launchpad-motion__recovery">
            <p>Showing the launchpad shell while live feed data reconnects.</p>
            <Button
              variant="secondary"
              size="sm"
              leftIcon="rotate-ccw"
              loading={loading}
              onClick={requestLaunchpadRefresh}
            >
              {loading ? 'Refreshing…' : 'Try again'}
            </Button>
          </div>
        ) : null}
      </section>
      {pendingInput > 0 || taskCount > 0 ? (
        <ReviewPanel
          className="cloud-launchpad-review"
          title="Review Snapshot"
          summary="Live review state from the active cloud session feed."
          status={{ label: pendingInput > 0 ? 'Needs input' : 'Clear', tone: pendingInput > 0 ? 'warning' : 'success' }}
        >
          <div className="cloud-launchpad-review__lanes">
            <TaskLane
              title="Decisions"
              tone="approval"
              items={[
                ...(pendingApprovals > 0 ? [{
                  id: 'approvals',
                  title: 'Permission approvals',
                  meta: `${pendingApprovals} pending`,
                  status: { label: 'Open', tone: 'warning' as const },
                }] : []),
                ...(pendingQuestions > 0 ? [{
                  id: 'questions',
                  title: 'Questions',
                  meta: `${pendingQuestions} pending`,
                  status: { label: 'Open', tone: 'warning' as const },
                }] : []),
              ]}
              emptyLabel="No decisions waiting"
            />
            <TaskLane
              title="Coworker Activity"
              tone="delegated"
              items={taskCount > 0 ? [{
                id: 'task-runs',
                title: 'In-progress tasks',
                meta: `${taskCount} task runs`,
                status: { label: 'Running', tone: 'accent' as const },
              }] : []}
              emptyLabel="No delegated runs active"
            />
          </div>
        </ReviewPanel>
      ) : null}
      <button className="cloud-launchpad-team-strip" type="button" onClick={() => onOpenRoute('agents')}>
        <span>Your team</span>
        <span className="cloud-launchpad-team-strip__avatars" aria-hidden="true">
          {coworkerOptions.slice(0, 8).map((coworker) => (
            <span key={coworker.name}>{coworker.displayName.slice(0, 2).toUpperCase()}</span>
          ))}
        </span>
        <span>{coworkerOptions.length || 0} coworkers · manage</span>
      </button>
    </>
  )
}
