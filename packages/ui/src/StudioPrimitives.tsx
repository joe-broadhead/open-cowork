import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useId,
  useState,
} from 'react'
import { Badge, type BadgeTone } from './Badge.js'
import { Button, type ButtonProps } from './Button.js'
import { Card } from './Card.js'
import { Icon, type IconName } from './Icon.js'
import { knowledgeSpaceHue } from './knowledge-hues.js'
import { cn, entityChroma } from './utils.js'

export type StudioTone = 'lead' | 'strategist' | 'builder' | 'reviewer' | 'operator' | 'neutral'
export type StudioStatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type StudioPresence = 'working' | 'available' | 'offline'

const statusToneMap: Record<StudioStatusTone, BadgeTone> = {
  neutral: 'neutral',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

function studioStatusDotClass(tone: StudioStatusTone): string {
  switch (tone) {
    case 'success': return 'studio-status-dot--ok'
    case 'warning': return 'studio-status-dot--warn'
    case 'danger': return 'studio-status-dot--error'
    case 'accent': return 'studio-status-dot--live'
    default: return 'studio-status-dot--idle'
  }
}

// A live/health STATUS reads as a semantic dot + label, not a filled pill. (Use a
// Badge only for a neutral/accent LABEL like a role — not for a status.)
export function StudioStatusDot({ tone = 'neutral', label }: { tone?: StudioStatusTone; label: ReactNode }) {
  return (
    <span className="studio-status-dot-label">
      <span className={cn('studio-status-dot', studioStatusDotClass(tone))} aria-hidden />
      {label}
    </span>
  )
}

function toneStyle(tone: StudioTone): CSSProperties {
  return { '--studio-tone': `var(--coworker-${tone})` } as CSSProperties
}

function laneStyle(tone: StudioLaneTone): CSSProperties {
  return { '--studio-lane-tone': `var(--lane-${tone})` } as CSSProperties
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function toFiniteNumber(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function percentStyle(name: string, value: number): CSSProperties {
  return { [name]: `${clampPercent(value)}%` } as CSSProperties
}

function priorityStyle(priority: KanbanPriority = 'medium'): CSSProperties {
  const color = {
    low: 'var(--color-green)',
    medium: 'var(--color-info)',
    high: 'var(--color-amber)',
    urgent: 'var(--color-red)',
  }[priority]
  return { '--studio-priority': color } as CSSProperties
}

export type StudioAction = Pick<ButtonProps, 'children' | 'onClick' | 'disabled' | 'disabledReason' | 'leftIcon' | 'rightIcon' | 'type'> & {
  id: string
  variant?: ButtonProps['variant']
}

function StudioActions({ actions }: { actions?: StudioAction[] }) {
  if (!actions?.length) return null
  return (
    <div className="studio-actions" role="toolbar" aria-label="Studio actions">
      {actions.map(({ id, variant = 'secondary', children, ...action }) => (
        <Button key={id} size="sm" variant={variant} {...action}>{children}</Button>
      ))}
    </div>
  )
}

export type StudioNavItem = {
  id: string
  label: string
  icon?: IconName
  href?: string
  badge?: ReactNode
  disabled?: boolean
  disabledReason?: string
}

export type StudioNavSection = {
  id: string
  label: string
  items: StudioNavItem[]
}

export type StudioShellProps = ComponentPropsWithoutRef<'div'> & {
  brand: {
    name: string
    mark?: ReactNode
    subtitle?: string
  }
  navSections: StudioNavSection[]
  activeItemId?: string
  header?: ReactNode
  sidebarFooter?: ReactNode
  presenceFooter?: ReactNode
  collapsed?: boolean
  onNavigate?: (item: StudioNavItem) => void
}

function StudioNavControl({
  item,
  active,
  onNavigate,
}: {
  item: StudioNavItem
  active: boolean
  onNavigate?: (item: StudioNavItem) => void
}) {
  const content = (
    <>
      {item.icon ? <Icon name={item.icon} size={16} /> : null}
      <span className="studio-nav__label">{item.label}</span>
      {item.badge ? <span className="studio-nav__badge">{item.badge}</span> : null}
    </>
  )
  const className = 'studio-nav__item'
  const common = {
    className,
    'data-active': active ? 'true' : undefined,
    'aria-current': active ? 'page' as const : undefined,
    title: item.disabledReason,
  }

  if (item.href && !item.disabled) {
    return <a href={item.href} {...common}>{content}</a>
  }

  if (onNavigate) {
    return (
      <button
        type="button"
        {...common}
        disabled={item.disabled}
        aria-disabled={item.disabled || undefined}
        onClick={() => onNavigate(item)}
      >
        {content}
      </button>
    )
  }

  return <span {...common} aria-disabled={item.disabled || undefined}>{content}</span>
}

export function StudioShell({
  brand,
  navSections,
  activeItemId,
  header,
  sidebarFooter,
  presenceFooter,
  collapsed = false,
  onNavigate,
  children,
  className,
  ...props
}: StudioShellProps) {
  return (
    <div {...props} className={cn('studio-shell', collapsed && 'studio-shell--collapsed', className)}>
      <aside className="studio-shell__sidebar">
        <div className="studio-shell__brand">
          <div className="studio-shell__mark" aria-hidden="true">{brand.mark ?? brand.name.slice(0, 2).toUpperCase()}</div>
          <div className="studio-shell__brand-copy">
            <div className="studio-shell__brand-name">{brand.name}</div>
            {brand.subtitle ? <div className="studio-shell__brand-subtitle">{brand.subtitle}</div> : null}
          </div>
        </div>
        <nav className="studio-nav" aria-label="Studio sections">
          {navSections.map((section) => (
            <section key={section.id} className="studio-nav__section" aria-labelledby={`studio-nav-${section.id}`}>
              <h2 id={`studio-nav-${section.id}`} className="studio-nav__section-label">{section.label}</h2>
              <div className="studio-nav__items">
                {section.items.map((item) => (
                  <StudioNavControl key={item.id} item={item} active={item.id === activeItemId} onNavigate={onNavigate} />
                ))}
              </div>
            </section>
          ))}
        </nav>
        {presenceFooter ? <div className="studio-shell__presence-footer">{presenceFooter}</div> : null}
        {sidebarFooter ? <div className="studio-shell__sidebar-footer">{sidebarFooter}</div> : null}
      </aside>
      <div className="studio-shell__workspace">
        {header ? <div className="studio-shell__topbar">{header}</div> : null}
        <div className="studio-shell__main">{children}</div>
      </div>
    </div>
  )
}

export type StudioPageHeaderProps = ComponentPropsWithoutRef<'header'> & {
  eyebrow?: string
  title: string
  description?: string
  actions?: StudioAction[]
  meta?: ReactNode
}

export function StudioPageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  className,
  ...props
}: StudioPageHeaderProps) {
  return (
    <header {...props} className={cn('studio-page-header', className)}>
      <div className="studio-page-header__copy">
        {eyebrow ? <Badge tone="accent">{eyebrow}</Badge> : null}
        <div>
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {meta ? <div className="studio-page-header__meta">{meta}</div> : null}
      </div>
      <StudioActions actions={actions} />
    </header>
  )
}

export type CoworkerAvatarProps = ComponentPropsWithoutRef<'span'> & {
  name: string
  initials?: string
  tone?: StudioTone
  size?: 'sm' | 'md' | 'lg'
  shape?: 'round' | 'squircle'
  presence?: StudioPresence | {
    status: StudioPresence
    label?: string
    pulse?: boolean
  }
}

export function CoworkerAvatar({
  name,
  initials,
  tone = 'neutral',
  size = 'md',
  shape = 'round',
  presence,
  className,
  children,
  ...props
}: CoworkerAvatarProps) {
  const label = initials || name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  const presenceState = typeof presence === 'string' ? { status: presence } : presence
  const shouldPulse = presenceState ? presenceState.pulse ?? presenceState.status === 'working' : false
  return (
    <span
      {...props}
      className={cn('studio-coworker-avatar', `studio-coworker-avatar--${size}`, `studio-coworker-avatar--${shape}`, className)}
      style={{ ...toneStyle(tone), ...props.style }}
      aria-label={name}
    >
      {label}
      {children}
      {presenceState ? (
        <span
          role="img"
          className={cn(
            'studio-presence-dot',
            `studio-presence-dot--${presenceState.status}`,
            shouldPulse && 'studio-presence-dot--pulse',
          )}
          aria-label={presenceState.label || presenceState.status}
          title={presenceState.label || presenceState.status}
        />
      ) : null}
    </span>
  )
}

export type CoworkerCardProps = ComponentPropsWithoutRef<'article'> & {
  name: string
  role: string
  summary?: string
  tone?: StudioTone
  mode?: string
  presence?: CoworkerAvatarProps['presence']
  abilities?: string[]
  styleBars?: Array<{
    id: string
    label: string
    value: number
  }>
  status?: {
    label: string
    tone?: StudioStatusTone
  }
  actions?: StudioAction[]
}

export function CoworkerCard({
  name,
  role,
  summary,
  tone = 'neutral',
  mode,
  presence,
  abilities,
  styleBars,
  status,
  actions,
  className,
  ...props
}: CoworkerCardProps) {
  return (
    <article {...props} className={cn('studio-coworker-card', className)} style={{ ...toneStyle(tone), ...props.style }}>
      <div className="studio-coworker-card__header">
        <CoworkerAvatar name={name} tone={tone} presence={presence} />
        <div className="studio-coworker-card__identity">
          <h3>{name}</h3>
          <p>{role}</p>
        </div>
        {status ? <StudioStatusDot tone={status.tone} label={status.label} /> : null}
      </div>
      {summary ? <p className="studio-coworker-card__summary">{summary}</p> : null}
      {abilities?.length ? (
        <div className="studio-chip-list" aria-label={`${name} abilities`}>
          {mode ? <Badge tone="accent">{mode}</Badge> : null}
          {abilities.map((ability) => <Badge key={ability} tone="neutral">{ability}</Badge>)}
        </div>
      ) : mode ? (
        <div className="studio-chip-list"><Badge tone="accent">{mode}</Badge></div>
      ) : null}
      {styleBars?.length ? <WorkingStyleBars bars={styleBars} compact /> : null}
      <StudioActions actions={actions} />
    </article>
  )
}

export type ComposerShellProps = ComponentPropsWithoutRef<'form'> & {
  label: string
  placeholder?: string
  helper?: ReactNode
  toolbar?: ReactNode
  assignMenu?: ReactNode
  context?: ReactNode
  actions?: StudioAction[]
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
}

export function ComposerShell({
  label,
  placeholder,
  helper,
  toolbar,
  assignMenu,
  context,
  actions,
  className,
  children,
  ...props
}: ComposerShellProps) {
  return (
    <form {...props} className={cn('studio-composer', className)}>
      {context ? <div className="studio-composer__context">{context}</div> : null}
      <label className="studio-composer__label">
        <span>{label}</span>
        <textarea name="text" rows={3} placeholder={placeholder} />
      </label>
      {children}
      <div className="studio-composer__footer">
        <div className="studio-composer__toolbar">{assignMenu}{toolbar || helper}</div>
        <StudioActions actions={actions} />
      </div>
    </form>
  )
}

export type StudioLaneTone = 'planning' | 'delegated' | 'review' | 'approval' | 'artifact'

export type TaskLaneItem = {
  id: string
  title: string
  meta?: string
  description?: string
  status?: {
    label: string
    tone?: StudioStatusTone
  }
}

export type TaskLaneProps = ComponentPropsWithoutRef<'section'> & {
  title: string
  description?: string
  tone?: StudioLaneTone
  items: TaskLaneItem[]
  emptyLabel?: string
}

export function TaskLane({
  title,
  description,
  tone = 'planning',
  items,
  emptyLabel = 'No items',
  className,
  ...props
}: TaskLaneProps) {
  return (
    <section {...props} className={cn('studio-task-lane', className)} style={{ ...laneStyle(tone), ...props.style }}>
      <header className="studio-task-lane__header">
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        <span className="studio-task-lane__count">{items.length}</span>
      </header>
      {items.length ? (
        <ol className="studio-task-lane__items">
          {items.map((item) => (
            <li key={item.id} className="studio-task-lane__item">
              <div>
                <h4>{item.title}</h4>
                {item.meta ? <p className="studio-task-lane__meta">{item.meta}</p> : null}
              </div>
              {item.status ? <StudioStatusDot tone={item.status.tone} label={item.status.label} /> : null}
              {item.description ? <p>{item.description}</p> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="studio-empty-line">{emptyLabel}</p>
      )}
    </section>
  )
}

export type ConversationLaneActivity = {
  id: string
  icon?: IconName
  verb: string
  object?: string
  time?: string
  done?: boolean
}

export type ConversationLaneCardProps = Omit<ComponentPropsWithoutRef<'details'>, 'title'> & {
  title: string
  coworker: {
    name: string
    role?: string
    initials?: string
    tone?: StudioTone
    presence?: CoworkerAvatarProps['presence']
  }
  task?: string
  tone?: StudioLaneTone
  status?: 'live' | 'done' | 'waiting'
  runtimeLabel?: string
  activities?: ConversationLaneActivity[]
  handoff?: ReactNode
}

export function ConversationLaneCard({
  title,
  coworker,
  task,
  tone = 'delegated',
  status = 'waiting',
  runtimeLabel,
  activities,
  handoff,
  className,
  open,
  onToggle,
  ...props
}: ConversationLaneCardProps) {
  const isControlled = open !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = useState(status === 'live')

  return (
    <details
      {...props}
      className={cn('studio-conversation-lane-card', `studio-conversation-lane-card--${status}`, className)}
      style={{ ...laneStyle(tone), ...props.style }}
      open={isControlled ? open : uncontrolledOpen}
      onToggle={(event) => {
        if (!isControlled) setUncontrolledOpen(event.currentTarget.open)
        onToggle?.(event)
      }}
    >
      <summary className="studio-conversation-lane-card__head">
        <CoworkerAvatar
          name={coworker.name}
          initials={coworker.initials}
          tone={coworker.tone || 'neutral'}
          presence={coworker.presence || (status === 'live' ? 'working' : status === 'done' ? 'available' : undefined)}
          size="sm"
        />
        <span className="studio-conversation-lane-card__copy">
          <span className="studio-conversation-lane-card__name">{coworker.name}</span>
          {coworker.role ? <span className="studio-conversation-lane-card__role">{coworker.role}</span> : null}
          <span className="studio-conversation-lane-card__task">{task || title}</span>
        </span>
        <span className="studio-conversation-lane-card__meta">
          {status === 'live' ? <span className="studio-status-live"><span />Live</span> : null}
          {status === 'done' ? <span className="studio-status-done"><Icon name="check" size={16} />Done</span> : null}
          {status === 'waiting' ? <span className="studio-status-waiting">Waiting</span> : null}
          {runtimeLabel ? <span>{runtimeLabel}</span> : null}
          <Icon name="chevron-right" size={16} />
        </span>
      </summary>
      <div className="studio-conversation-lane-card__body">
        {activities?.length ? (
          <ol className="studio-activity-list">
            {activities.map((activity) => (
              <li key={activity.id} className={cn('studio-activity-row', activity.done && 'studio-activity-row--done')}>
                <span className="studio-activity-row__icon" aria-hidden="true">
                  <Icon name={activity.icon || (activity.done ? 'check' : 'activity')} size={16} />
                </span>
                <span className="studio-activity-row__copy">
                  <strong>{activity.verb}</strong>
                  {activity.object ? <span>{activity.object}</span> : null}
                </span>
                {activity.time ? <time>{activity.time}</time> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="studio-empty-line">No projected activity yet.</p>
        )}
        {handoff ? <div className="studio-handoff-chip"><Icon name="git-fork" size={16} />{handoff}</div> : null}
      </div>
    </details>
  )
}

export type KanbanPriority = 'low' | 'medium' | 'high' | 'urgent'

export type KanbanTask = {
  id: string
  title: string
  description?: string
  priority?: KanbanPriority
  assignee?: {
    name: string
    initials?: string
    tone?: StudioTone
    presence?: CoworkerAvatarProps['presence']
  }
  run?: {
    label: string
    live?: boolean
  }
  meta?: ReactNode
}

export type KanbanColumn = {
  id: string
  title: string
  tasks: KanbanTask[]
  over?: boolean
  emptyLabel?: string
}

export type KanbanBoardProps = ComponentPropsWithoutRef<'section'> & {
  columns: KanbanColumn[]
}

export function KanbanBoard({ columns, className, id, ...props }: KanbanBoardProps) {
  const generatedBoardId = useId()
  const headingIdPrefix = id || generatedBoardId

  return (
    <section {...props} id={id} className={cn('studio-kanban-board', className)}>
      {columns.map((column) => (
        <KanbanColumnView key={column.id} column={column} headingIdPrefix={headingIdPrefix} />
      ))}
    </section>
  )
}

function KanbanColumnView({ column, headingIdPrefix }: { column: KanbanColumn; headingIdPrefix: string }) {
  const headingId = `${headingIdPrefix}-${column.id}-heading`

  return (
    <section className={cn('studio-kanban-column', column.over && 'studio-kanban-column--over')} aria-labelledby={headingId}>
      <header className="studio-kanban-column__head">
        <h3 id={headingId}>{column.title}</h3>
        <span>{column.tasks.length}</span>
      </header>
      <div className="studio-kanban-column__body">
        {column.tasks.length ? column.tasks.map((task) => <KanbanTaskCard key={task.id} task={task} />) : (
          <p className="studio-kanban-column__empty">{column.emptyLabel || 'No tasks'}</p>
        )}
      </div>
    </section>
  )
}

export type KanbanTaskCardProps = ComponentPropsWithoutRef<'article'> & {
  task: KanbanTask
  dragging?: boolean
}

export function KanbanTaskCard({ task, dragging = false, className, ...props }: KanbanTaskCardProps) {
  return (
    <article
      {...props}
      className={cn('studio-kanban-task-card', dragging && 'studio-kanban-task-card--dragging', className)}
      style={{ ...priorityStyle(task.priority), ...props.style }}
    >
      <div className="studio-kanban-task-card__top">
        <span role="img" className="studio-kanban-task-card__priority" aria-label={`${task.priority || 'medium'} priority`} />
        <div>
          <h4 className="studio-u-card-title">{task.title}</h4>
          {task.description ? <p className="studio-u-card-text">{task.description}</p> : null}
        </div>
      </div>
      <footer className="studio-kanban-task-card__foot studio-u-flex-center">
        {task.assignee ? (
          <>
            <CoworkerAvatar
              name={task.assignee.name}
              initials={task.assignee.initials}
              tone={task.assignee.tone || 'neutral'}
              presence={task.assignee.presence}
              size="sm"
            />
            <span>{task.assignee.name}</span>
          </>
        ) : (
          <span className="studio-unassigned"><Icon name="users" size={16} />Unassigned</span>
        )}
        {task.run ? <span className={cn('studio-run-pill', task.run.live && 'studio-run-pill--live')}><span />{task.run.label}</span> : null}
        {task.meta ? <span className="studio-kanban-task-card__meta">{task.meta}</span> : null}
      </footer>
    </article>
  )
}

export type RunTimelineStep = {
  id: string
  label: string
}

export type RunTimelineProps = ComponentPropsWithoutRef<'section'> & {
  stateLabel: string
  live?: boolean
  steps: RunTimelineStep[]
  currentStepId: string
  completedStepIds?: string[]
  sessionId?: string
}

export function RunTimeline({
  stateLabel,
  live = false,
  steps,
  currentStepId,
  completedStepIds = [],
  sessionId,
  className,
  ...props
}: RunTimelineProps) {
  return (
    <section {...props} className={cn('studio-run-timeline', className)} aria-label="Run timeline">
      <div className="studio-run-timeline__state">
        <span className={cn(live && 'studio-status-live')}>{live ? <span /> : null}{stateLabel}</span>
      </div>
      <ol className="studio-run-timeline__steps">
        {steps.map((step) => {
          const done = completedStepIds.includes(step.id)
          const current = step.id === currentStepId
          return (
            <li key={step.id} className={cn('studio-run-timeline__step', done && 'studio-run-timeline__step--done', current && 'studio-run-timeline__step--current')}>
              <span className="studio-run-timeline__dot" />
              <span>{step.label}</span>
            </li>
          )
        })}
      </ol>
      {sessionId ? <div className="studio-run-timeline__meta">Session <code>{sessionId}</code></div> : null}
    </section>
  )
}

export type PermissionPolicy = 'allow' | 'ask' | 'deny'

export type PermissionEditorRowProps = ComponentPropsWithoutRef<'article'> & {
  toolName: string
  description?: string
  icon?: IconName
  policy: PermissionPolicy
  rules?: string[]
  onPolicyChange?: (policy: PermissionPolicy) => void
  onRuleChange?: (index: number, value: string) => void
}

export function PermissionEditorRow({
  toolName,
  description,
  icon = 'shield-check',
  policy,
  rules,
  onPolicyChange,
  onRuleChange,
  className,
  ...props
}: PermissionEditorRowProps) {
  const options: PermissionPolicy[] = ['allow', 'ask', 'deny']
  return (
    <article {...props} className={cn('studio-permission-row', className)}>
      <div className="studio-permission-row__head">
        <span className="studio-permission-row__icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
        <div className="studio-permission-row__copy">
          <h3>{toolName}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        <div className="studio-policy-toggle" role="group" aria-label={`${toolName} permission`}>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className={cn('studio-policy-toggle__option', `studio-policy-toggle__option--${option}`)}
              data-active={option === policy ? 'true' : undefined}
              aria-pressed={option === policy}
              onClick={() => onPolicyChange?.(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      {rules?.length ? (
        <div className="studio-permission-row__rules">
          {rules.map((rule, index) => (
            <label key={`rule-${index}`} className="studio-permission-rule">
              <span>Rule {index + 1}</span>
              <input value={rule} readOnly={!onRuleChange} onChange={(event) => onRuleChange?.(index, event.currentTarget.value)} />
            </label>
          ))}
        </div>
      ) : null}
    </article>
  )
}

export type ReviewPanelProps = ComponentPropsWithoutRef<'aside'> & {
  title: string
  summary?: string
  status?: {
    label: string
    tone?: StudioStatusTone
  }
  actions?: StudioAction[]
}

export function ReviewPanel({
  title,
  summary,
  status,
  actions,
  children,
  className,
  ...props
}: ReviewPanelProps) {
  return (
    <aside {...props} className={cn('studio-review-panel', className)}>
      <header className="studio-review-panel__header">
        <div>
          <h2>{title}</h2>
          {summary ? <p>{summary}</p> : null}
        </div>
        {status ? <StudioStatusDot tone={status.tone} label={status.label} /> : null}
      </header>
      <div className="studio-review-panel__body">{children}</div>
      <StudioActions actions={actions} />
    </aside>
  )
}

export type StudioApprovalCardProps = ComponentPropsWithoutRef<'article'> & {
  title: string
  requester?: string
  body?: string
  danger?: boolean
  actions?: StudioAction[]
}

export function StudioApprovalCard({
  title,
  requester,
  body,
  danger = false,
  actions,
  className,
  children,
  ...props
}: StudioApprovalCardProps) {
  return (
    <article {...props} className={cn('studio-decision-card', danger && 'studio-decision-card--danger', className)}>
      <div className="studio-decision-card__icon" aria-hidden="true">
        <Icon name={danger ? 'alert-circle' : 'circle-help'} size={20} />
      </div>
      <div className="studio-decision-card__copy">
        <h3>{title}</h3>
        {requester ? <p className="studio-decision-card__meta">{requester}</p> : null}
        {body ? <p>{body}</p> : null}
        {children}
        <StudioActions actions={actions} />
      </div>
    </article>
  )
}

export type DeliverableCardProps = ComponentPropsWithoutRef<'article'> & {
  title: string
  meta?: string
  icon?: IconName
  tone?: StudioTone
  preview?: ReactNode
  previewLabel?: string
  capturedLabel?: string
  actions?: StudioAction[]
  captureAction?: StudioAction
}

export function DeliverableCard({
  title,
  meta,
  icon = 'file-text',
  tone = 'neutral',
  preview,
  previewLabel = 'Preview pending',
  capturedLabel,
  actions,
  captureAction,
  className,
  ...props
}: DeliverableCardProps) {
  const captureButton = captureAction
    ? (() => {
        const { id: _id, variant, children, ...buttonProps } = captureAction
        return { buttonProps, children, variant }
      })()
    : null

  return (
    <article {...props} className={cn('studio-deliverable-card', className)} style={{ ...toneStyle(tone), ...props.style }}>
      <div className="studio-deliverable-card__head">
        <span className="studio-deliverable-card__icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
        <div>
          <h3>{title}</h3>
          {meta ? <p>{meta}</p> : null}
        </div>
      </div>
      <div className="studio-deliverable-card__preview">
        {preview || <span>{previewLabel}</span>}
      </div>
      <StudioActions actions={actions} />
      {captureButton ? (
        <Button className="studio-deliverable-card__capture" size="sm" variant={captureButton.variant || 'secondary'} {...captureButton.buttonProps}>
          {captureButton.children}
        </Button>
      ) : null}
      {capturedLabel ? <div className="studio-deliverable-card__captured"><Icon name="check" size={16} />{capturedLabel}</div> : null}
    </article>
  )
}

export type StudioObjectCardProps = ComponentPropsWithoutRef<'article'> & {
  title: string
  description?: string
  icon?: IconName
  meta?: ReactNode
  status?: {
    label: string
    tone?: StudioStatusTone
  }
  actions?: StudioAction[]
}

export type StudioArtifactCardProps = StudioObjectCardProps

export function StudioArtifactCard(props: StudioObjectCardProps) {
  return <StudioObjectCard {...props} defaultIcon="file" className={cn('studio-object-card--artifact', props.className)} />
}

export type ProjectCardProps = StudioObjectCardProps & {
  progress?: number
  progressLabel?: string
}

export function ProjectCard({ progress, progressLabel, ...props }: ProjectCardProps) {
  return (
    <StudioObjectCard
      {...props}
      defaultIcon="folder"
      className={cn('studio-object-card--project', props.className)}
      footer={progress !== undefined ? (
        <div className="studio-project-progress" aria-label={progressLabel || `${clampPercent(progress)}% complete`}>
          <span className="studio-u-progress-track"><i className="studio-u-progress-fill" style={percentStyle('--studio-progress', progress)} /></span>
          <em>{progressLabel || `${clampPercent(progress)}%`}</em>
        </div>
      ) : undefined}
    />
  )
}

export function ChannelStatusCard(props: StudioObjectCardProps) {
  return <StudioObjectCard {...props} defaultIcon="activity" className={cn('studio-object-card--channel', props.className)} />
}

export type ChannelRowProps = ComponentPropsWithoutRef<'article'> & {
  title: string
  description?: string
  icon?: IconName
  status?: {
    label: string
    tone?: StudioStatusTone
  }
  meta?: ReactNode
}

export function ChannelRow({
  title,
  description,
  icon = 'radio',
  status,
  meta,
  className,
  ...props
}: ChannelRowProps) {
  return (
    <article {...props} className={cn('studio-channel-row studio-u-flex-center studio-u-row-surface', className)}>
      <span className="studio-channel-row__icon studio-u-icon-chip" aria-hidden="true"><Icon name={icon} size={20} /></span>
      <div className="studio-channel-row__copy studio-u-fill-min">
        <h3 className="studio-u-card-title">{title}</h3>
        {description ? <p className="studio-u-card-text">{description}</p> : null}
      </div>
      {meta ? <div className="studio-channel-row__meta">{meta}</div> : null}
      {status ? <StudioStatusDot tone={status.tone} label={status.label} /> : null}
    </article>
  )
}

export type PersonRowProps = Omit<ComponentPropsWithoutRef<'article'>, 'role'> & {
  name: string
  detail?: ReactNode
  initials?: string
  tone?: StudioTone
  presence?: CoworkerAvatarProps['presence']
  role?: {
    label: string
    description?: string
    tone?: StudioStatusTone
  }
}

export function PersonRow({
  name,
  detail,
  initials,
  tone = 'neutral',
  presence,
  role,
  className,
  ...props
}: PersonRowProps) {
  return (
    <article {...props} className={cn('studio-person-row', className)}>
      <CoworkerAvatar name={name} initials={initials} tone={tone} presence={presence} size="sm" />
      <div className="studio-person-row__copy">
        <h3>{name}</h3>
        {detail ? <div>{detail}</div> : null}
      </div>
      {role ? (
        <div className="studio-person-row__role">
          <Badge tone={statusToneMap[role.tone || 'neutral']}>{role.label}</Badge>
          {role.description ? <span>{role.description}</span> : null}
        </div>
      ) : null}
    </article>
  )
}

export type WizardStep = {
  id: string
  label: string
  icon?: IconName
  completed?: boolean
}

export type WizardStepsProps = Omit<ComponentPropsWithoutRef<'nav'>, 'onSelect'> & {
  steps: WizardStep[]
  activeStepId: string
  onSelect?: (step: WizardStep) => void
}

export function WizardSteps({ steps, activeStepId, onSelect, className, ...props }: WizardStepsProps) {
  return (
    <nav {...props} className={cn('studio-wizard-steps', className)} aria-label="Wizard steps">
      {steps.map((step, index) => (
        <button
          key={step.id}
          type="button"
          data-active={step.id === activeStepId ? 'true' : undefined}
          aria-current={step.id === activeStepId ? 'step' : undefined}
          onClick={() => onSelect?.(step)}
        >
          <span>{step.completed ? <Icon name="check" size={16} /> : index + 1}</span>
          {step.icon ? <Icon name={step.icon} size={16} /> : null}
          {step.label}
        </button>
      ))}
    </nav>
  )
}

export type WizardStepPaneProps = ComponentPropsWithoutRef<'section'> & {
  title: string
  hint?: ReactNode
}

export function WizardStepPane({ title, hint, children, className, ...props }: WizardStepPaneProps) {
  return (
    <section {...props} className={cn('studio-wizard-step-pane', className)}>
      <h3>{title}</h3>
      {hint ? <p>{hint}</p> : null}
      {children}
    </section>
  )
}

export type TraitSliderProps = Omit<ComponentPropsWithoutRef<'input'>, 'type' | 'value' | 'onChange'> & {
  label: string
  value: number
  minLabel?: string
  maxLabel?: string
  icon?: IconName
  onValueChange?: (value: number) => void
}

export function TraitSlider({
  label,
  value,
  minLabel,
  maxLabel,
  icon,
  onValueChange,
  className,
  ...props
}: TraitSliderProps) {
  const min = toFiniteNumber(props.min, 0)
  const max = toFiniteNumber(props.max, 100)
  const lower = Math.min(min, max)
  const upper = Math.max(min, max)
  const clampedValue = Math.min(upper, Math.max(lower, value))
  const range = upper - lower
  const progress = range > 0 ? ((clampedValue - lower) / range) * 100 : 100
  const displayValue = Number.isInteger(clampedValue) ? clampedValue : Number(clampedValue.toFixed(2))

  return (
    <label className={cn('studio-trait-slider', className)}>
      <span className="studio-trait-slider__label">
        <span>{icon ? <Icon name={icon} size={16} /> : null}{label}</span>
        <strong>{displayValue}</strong>
      </span>
      <input
        {...props}
        type="range"
        value={clampedValue}
        min={lower}
        max={upper}
        style={{ ...percentStyle('--studio-progress', progress), ...props.style }}
        onChange={(event) => onValueChange?.(Number(event.currentTarget.value))}
      />
      {(minLabel || maxLabel) ? <span className="studio-trait-slider__ends"><span>{minLabel}</span><span>{maxLabel}</span></span> : null}
    </label>
  )
}

export type WorkingStyleBarsProps = ComponentPropsWithoutRef<'div'> & {
  bars: Array<{
    id: string
    label: string
    value: number
  }>
  compact?: boolean
}

export function WorkingStyleBars({ bars, compact = false, className, ...props }: WorkingStyleBarsProps) {
  return (
    <div {...props} className={cn('studio-working-style-bars', compact && 'studio-working-style-bars--compact', className)}>
      {bars.map((bar) => (
        <div key={bar.id} className="studio-working-style-bars__row">
          <span>{bar.label}</span>
          <span><i style={percentStyle('--studio-progress', bar.value)} /></span>
        </div>
      ))}
    </div>
  )
}

export type WikiSpace = {
  id: string
  name: string
  icon?: IconName
  /** Human-readable visibility label (e.g. "Company-wide", "Team", "Private"). */
  visibility?: string
  /** The viewer's role in this Space (e.g. "Maintainer", "Contributor", "Reader"). */
  role?: string
  pages: Array<{
    id: string
    title: string
  }>
}

export type WikiSpaceRailProps = ComponentPropsWithoutRef<'aside'> & {
  spaces: WikiSpace[]
  activePageId?: string
  reviewAction?: ReactNode
  /** A Pages/Graph view switch rendered at the top of the rail. */
  viewToggle?: ReactNode
  onSelectPage?: (space: WikiSpace, page: WikiSpace['pages'][number]) => void
}

export function WikiSpaceRail({ spaces, activePageId, reviewAction, viewToggle, onSelectPage, className, ...props }: WikiSpaceRailProps) {
  return (
    <aside {...props} className={cn('studio-wiki-rail', className)}>
      {viewToggle ? <div className="studio-wiki-rail__view">{viewToggle}</div> : null}
      {reviewAction ? <div className="studio-wiki-rail__review">{reviewAction}</div> : null}
      <div className="studio-wiki-rail__spaces">
        {spaces.map((space, spaceIndex) => (
          <section key={space.id} className="studio-wiki-space" aria-labelledby={`studio-wiki-space-${space.id}`}>
            <h3 id={`studio-wiki-space-${space.id}`}>
              <span aria-hidden="true" className="entity-tile" style={{ '--entity-chroma': knowledgeSpaceHue(spaceIndex) } as CSSProperties}>{space.icon ? <Icon name={space.icon} size={16} /> : null}</span>
              {space.name}
            </h3>
            {space.visibility || space.role ? (
              <div className="studio-wiki-space__meta">
                {space.visibility ? <span className="studio-wiki-space__visibility">{space.visibility}</span> : null}
                {space.role ? <span className="studio-wiki-space__role">{space.role}</span> : null}
              </div>
            ) : null}
            <div>
              {space.pages.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  data-active={page.id === activePageId ? 'true' : undefined}
                  onClick={() => onSelectPage?.(space, page)}
                >
                  {page.title}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}

export type WikiPageBlock =
  | { id: string; type: 'heading'; text: string }
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'callout'; text: string; icon?: IconName }
  | { id: string; type: 'list'; items: string[] }

export type WikiPageProps = ComponentPropsWithoutRef<'article'> & {
  breadcrumbs?: string[]
  title: string
  meta?: ReactNode
  /** Header-aligned actions (e.g. a "Propose edit" button), rendered top-right. */
  actions?: ReactNode
  blocks: WikiPageBlock[]
  links?: Array<{
    id: string
    label: string
    icon?: IconName
  }>
}

export function WikiPage({ breadcrumbs, title, meta, actions, blocks, links, className, ...props }: WikiPageProps) {
  return (
    <article {...props} className={cn('studio-wiki-page', className)}>
      {breadcrumbs?.length ? <div className="studio-wiki-page__crumbs">{breadcrumbs.join(' / ')}</div> : null}
      <header className="studio-wiki-page__head">
        <h1>{title}</h1>
        {actions || meta ? (
          <div className="studio-wiki-page__head-side">
            {actions ? <div className="studio-wiki-page__actions">{actions}</div> : null}
            {meta ? <div>{meta}</div> : null}
          </div>
        ) : null}
      </header>
      <div className="studio-wiki-page__body">
        {blocks.map((block) => {
          if (block.type === 'heading') return <h2 key={block.id}>{block.text}</h2>
          if (block.type === 'callout') return <div key={block.id} className="studio-wiki-page__callout">{block.icon ? <Icon name={block.icon} size={16} /> : null}{block.text}</div>
          if (block.type === 'list') {
            return (
              <ul key={block.id}>
                {block.items.map((item, index) => <li key={`${block.id}-${index}`}>{item}</li>)}
              </ul>
            )
          }
          return <p key={block.id}>{block.text}</p>
        })}
      </div>
      {links?.length ? (
        <footer className="studio-wiki-page__links">
          <h5 className="studio-wiki-page__links-title">Knowledge trail <small>— the work this page came from, all auditable</small></h5>
          {links.map((link) => <span key={link.id}>{link.icon ? <Icon name={link.icon} size={16} /> : null}{link.label}</span>)}
        </footer>
      ) : null}
    </article>
  )
}

function StudioObjectCard({
  title,
  description,
  icon,
  defaultIcon,
  meta,
  status,
  actions,
  footer,
  className,
  ...props
}: StudioObjectCardProps & { defaultIcon: IconName; footer?: ReactNode }) {
  return (
    <Card {...props} className={cn('studio-object-card', className)}>
      <div className="studio-object-card__icon entity-tile" aria-hidden="true" style={{ '--entity-chroma': entityChroma(title) } as CSSProperties}>
        <Icon name={icon || defaultIcon} size={20} />
      </div>
      <div className="studio-object-card__copy">
        <div className="studio-object-card__title-row">
          <h3>{title}</h3>
          {status ? <StudioStatusDot tone={status.tone} label={status.label} /> : null}
        </div>
        {description ? <p>{description}</p> : null}
        {meta ? <div className="studio-object-card__meta">{meta}</div> : null}
        {footer}
        <StudioActions actions={actions} />
      </div>
    </Card>
  )
}
