import type {
  LaunchpadFeedPayload,
  LaunchpadFreshArtifactItem,
  LaunchpadInProgressItem,
  LaunchpadWaitingItem,
} from '@open-cowork/shared'
import type { AppNavigationTarget } from '../../app-types'
import { formatDate, t } from '../../helpers/i18n'
import { Badge, Button, Icon, type IconName, type StudioTone } from '../ui'
import { MAX_MOTION_ITEMS } from './constants'

// The "In motion" launchpad: three columns (In progress / Waiting on you /
// Fresh artifacts) summarising live work. Extracted from HomePage so the home
// surface stays focused on the composer + page shell.
type MotionColumnConfig<TItem> = {
  key: string
  title: string
  icon: IconName
  tone: StudioTone
  total: number
  truncated: boolean
  items: TItem[]
  empty: string
  onOpen: (item: TItem) => void
  meta: (item: TItem) => string
  badge: (item: TItem) => string
}

function motionWhenLabel(value: string | null | undefined) {
  if (!value) return null
  return formatDate(value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function motionMeta(item: LaunchpadInProgressItem | LaunchpadWaitingItem | LaunchpadFreshArtifactItem) {
  return [
    item.projectTitle || item.taskTitle || null,
    item.assigneeAgent ? `@${item.assigneeAgent}` : null,
    motionWhenLabel(item.when),
  ].filter(Boolean).join(' · ')
}

function MotionColumn<TItem extends LaunchpadInProgressItem | LaunchpadWaitingItem | LaunchpadFreshArtifactItem>({
  config,
}: {
  config: MotionColumnConfig<TItem>
}) {
  return (
    <div className="home-motion-column" data-tone={config.tone}>
      <div className="home-motion-column-head">
        <span className="inline-flex min-w-0 items-center gap-2">
          <Icon name={config.icon} size={16} />
          <span className="truncate">{config.title}</span>
        </span>
        <Badge
          tone={config.key === 'waiting' && config.total > 0 ? 'accent' : 'neutral'}
          className={config.key === 'waiting' && config.total > 0 ? 'home-motion-alert-badge' : undefined}
        >
          {config.truncated ? `${config.total}+` : config.total}
        </Badge>
      </div>
      <div className="home-motion-list">
        {config.items.length > 0 ? config.items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="home-motion-row"
            onClick={() => config.onOpen(item)}
          >
            <span className="home-motion-icon" aria-hidden="true">
              <Icon name={config.icon} size={16} />
            </span>
            <span className="home-motion-text">
              <span className="home-motion-title">{item.title}</span>
              <span className="home-motion-meta">{config.meta(item)}</span>
            </span>
            <span className="home-motion-badge">{config.badge(item)}</span>
          </button>
        )) : (
          <div className="home-motion-empty">{config.empty}</div>
        )}
      </div>
    </div>
  )
}

export function LaunchpadMotionGrid({
  feed,
  loading,
  error,
  onNavigate,
  onOpenThread,
  onOpenArtifact,
  onRefresh,
}: {
  feed: LaunchpadFeedPayload
  loading: boolean
  error: string | null
  onNavigate: (target: AppNavigationTarget) => void
  onOpenThread: (sessionId: string) => void
  onOpenArtifact: (item: LaunchpadFreshArtifactItem) => void
  onRefresh?: () => void
}) {
  const inProgressColumn: MotionColumnConfig<LaunchpadInProgressItem> = {
    key: 'in-progress',
    title: t('home.motion.inProgress', 'In progress'),
    icon: 'kanban',
    tone: 'builder',
    total: feed.totals.inProgress,
    truncated: feed.truncated.inProgress,
    items: feed.inProgress.slice(0, MAX_MOTION_ITEMS),
    empty: t('home.motion.noInProgress', 'No active tasks yet.'),
    onOpen: (item) => item.sessionId ? onOpenThread(item.sessionId) : onNavigate('projects'),
    meta: motionMeta,
    badge: (item) => item.priority.toUpperCase(),
  }
  const waitingColumn: MotionColumnConfig<LaunchpadWaitingItem> = {
    key: 'waiting',
    title: t('home.motion.waiting', 'Waiting on you'),
    icon: 'bell',
    tone: 'operator',
    total: feed.totals.waitingOnYou,
    truncated: feed.truncated.waitingOnYou,
    items: feed.waitingOnYou.slice(0, MAX_MOTION_ITEMS),
    empty: t('home.motion.noWaiting', 'No approvals or questions waiting.'),
    onOpen: (item) => item.sessionId ? onOpenThread(item.sessionId) : onNavigate('approvals'),
    meta: motionMeta,
    badge: (item) => item.kind === 'permission' ? t('home.motion.permission', 'Approval') : t('home.motion.question', 'Question'),
  }
  const artifactsColumn: MotionColumnConfig<LaunchpadFreshArtifactItem> = {
    key: 'artifacts',
    title: t('home.motion.artifacts', 'Fresh artifacts'),
    icon: 'file',
    tone: 'strategist',
    total: feed.totals.freshArtifacts,
    truncated: feed.truncated.freshArtifacts,
    items: feed.freshArtifacts.slice(0, MAX_MOTION_ITEMS),
    empty: t('home.motion.noArtifacts', 'No new artifacts yet.'),
    onOpen: onOpenArtifact,
    meta: motionMeta,
    badge: (item) => item.status,
  }

  return (
    <div className="home-motion w-full mt-10" aria-busy={loading}>
      <div className="home-motion-head">
        <span>{t('home.motion.title', 'In motion')}</span>
        <span className="home-motion-line" aria-hidden="true" />
        {loading && <Badge tone="neutral">{t('home.motion.loading', 'Loading')}</Badge>}
        {error && <Badge tone="warning">{t('home.motion.error', 'Feed unavailable')}</Badge>}
      </div>
      <div className="home-motion-grid">
        <MotionColumn config={inProgressColumn} />
        <MotionColumn config={waitingColumn} />
        <MotionColumn config={artifactsColumn} />
      </div>
      {error && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <p className="text-center text-xs text-text-muted">
            {t('home.motion.errorDetail', 'Showing the launchpad shell while live feed data reconnects.')}
          </p>
          {onRefresh ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon="rotate-ccw"
              loading={loading}
              onClick={onRefresh}
            >
              {loading ? t('home.motion.refreshing', 'Refreshing…') : t('home.motion.refresh', 'Refresh')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
