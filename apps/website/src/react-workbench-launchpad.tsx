import { useCallback, useRef, useState } from 'react'
import type {
  LaunchpadFeedPayload,
  LaunchpadFreshArtifactItem,
  LaunchpadInProgressItem,
  LaunchpadWaitingItem,
} from '@open-cowork/shared'
import { errorMessage, setCloudStatus } from './react-workbench-controller.ts'
import type { CloudWebCoworkerOption } from './surface-workbench.ts'

type CloudLaunchpadSuggestion = {
  title: string
  prompt: string
  agent: string
  icon: string
}

const SUGGESTIONS: CloudLaunchpadSuggestion[] = [
  {
    title: 'Plan a release',
    prompt: 'Draft a release plan for the next milestone.',
    agent: 'plan',
    icon: '->',
  },
  {
    title: 'Review a change',
    prompt: 'Review the recent changes and call out production risks.',
    agent: 'build',
    icon: '~',
  },
  {
    title: 'Create a workflow',
    prompt: 'Help me turn a repeated task into a saved workflow.',
    agent: 'chief-of-staff',
    icon: '*',
  },
  {
    title: 'Investigate an issue',
    prompt: 'Trace this bug from symptoms to a concrete fix.',
    agent: 'build',
    icon: '?',
  },
]

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

function coworkerName(agent: string, coworkerOptions: CloudWebCoworkerOption[]) {
  if (!agent) return 'default coworker'
  const option = coworkerOptions.find((candidate) => candidate.name === agent)
  return option?.displayName || agent
}

function suggestionAgent(agent: string, coworkerOptions: CloudWebCoworkerOption[], hasExplicitAllowedAgents: boolean) {
  if (!hasExplicitAllowedAgents) return agent
  return coworkerOptions.some((candidate) => candidate.name === agent)
    ? agent
    : coworkerOptions[0]?.name || ''
}

type MotionColumnProps<TItem> = {
  title: string
  icon: string
  total: number
  truncated: boolean
  items: TItem[]
  empty: string
  badge: (item: TItem) => string
  onOpen: (item: TItem) => void
}

function MotionColumn<TItem extends LaunchpadInProgressItem | LaunchpadWaitingItem | LaunchpadFreshArtifactItem>({
  title,
  icon,
  total,
  truncated,
  items,
  empty,
  badge,
  onOpen,
}: MotionColumnProps<TItem>) {
  return (
    <div className="cloud-launchpad-motion-col">
      <div className="cloud-launchpad-motion-col__head">
        <span><span aria-hidden="true">{icon}</span> {title}</span>
        <span className="pill">{truncated ? `${total}+` : total}</span>
      </div>
      <div className="cloud-launchpad-motion-list">
        {items.length ? items.map((item) => (
          <button key={item.id} className="cloud-launchpad-motion-row" type="button" onClick={() => onOpen(item)}>
            <span className="cloud-launchpad-motion-row__icon" aria-hidden="true">{icon}</span>
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
  onSuggestion: (prompt: string, agent: string) => void
  onOpenRoute: (route: 'threads' | 'artifacts' | 'agents' | 'chat') => void
  onOpenSession: (sessionId: string) => void
  onOpenArtifact: (item: LaunchpadFreshArtifactItem) => void
}) {
  return (
    <>
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
              <span className="cloud-launchpad-suggestion__icon" aria-hidden="true">{suggestion.icon}</span>
              <span className="cloud-launchpad-suggestion__text">
                <strong>{suggestion.title}</strong>
                <span>{suggestion.prompt}</span>
                <small>{policyKnown ? `@${coworkerName(agent, coworkerOptions)} can take this` : 'Checking profile policy'}</small>
              </span>
            </button>
          )
        })}
      </div>
      <section className="cloud-launchpad-motion" aria-busy={loading}>
        <div className="cloud-launchpad-motion__head">
          <span>In motion</span>
          <span aria-hidden="true" />
          {loading ? <span className="pill">Loading</span> : null}
          {error ? <span className="pill" data-kind="warn">Feed unavailable</span> : null}
        </div>
        <div className="cloud-launchpad-motion-grid">
          <MotionColumn
            title="In progress"
            icon="P"
            total={feed.totals.inProgress}
            truncated={feed.truncated.inProgress}
            items={feed.inProgress.slice(0, 3)}
            empty="No active tasks yet."
            badge={(item) => item.priority.toUpperCase()}
            onOpen={(item) => item.sessionId ? onOpenSession(item.sessionId) : onOpenRoute('threads')}
          />
          <MotionColumn
            title="Waiting on you"
            icon="!"
            total={feed.totals.waitingOnYou}
            truncated={feed.truncated.waitingOnYou}
            items={feed.waitingOnYou.slice(0, 3)}
            empty="No approvals or questions waiting."
            badge={(item) => item.kind === 'permission' ? 'Approval' : 'Question'}
            onOpen={(item) => item.sessionId ? onOpenSession(item.sessionId) : onOpenRoute('chat')}
          />
          <MotionColumn
            title="Fresh artifacts"
            icon="A"
            total={feed.totals.freshArtifacts}
            truncated={feed.truncated.freshArtifacts}
            items={feed.freshArtifacts.slice(0, 3)}
            empty="No new artifacts yet."
            badge={(item) => item.status}
            onOpen={onOpenArtifact}
          />
        </div>
      </section>
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
