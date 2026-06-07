import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Badge, type BadgeTone } from './Badge.js'
import { Button, type ButtonProps } from './Button.js'
import { Card } from './Card.js'
import { Icon, type IconName } from './Icon.js'
import { cn } from './utils.js'

export type StudioTone = 'lead' | 'strategist' | 'builder' | 'reviewer' | 'operator' | 'neutral'
export type StudioStatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const statusToneMap: Record<StudioStatusTone, BadgeTone> = {
  neutral: 'neutral',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

function toneStyle(tone: StudioTone): CSSProperties {
  return { '--studio-tone': `var(--coworker-${tone})` } as CSSProperties
}

function laneStyle(tone: StudioLaneTone): CSSProperties {
  return { '--studio-lane-tone': `var(--lane-${tone})` } as CSSProperties
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
  onNavigate,
  children,
  className,
  ...props
}: StudioShellProps) {
  return (
    <div {...props} className={cn('studio-shell', className)}>
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
}

export function CoworkerAvatar({
  name,
  initials,
  tone = 'neutral',
  size = 'md',
  className,
  ...props
}: CoworkerAvatarProps) {
  const label = initials || name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  return (
    <span
      {...props}
      className={cn('studio-coworker-avatar', `studio-coworker-avatar--${size}`, className)}
      style={{ ...toneStyle(tone), ...props.style }}
      aria-label={name}
    >
      {label}
    </span>
  )
}

export type CoworkerCardProps = ComponentPropsWithoutRef<'article'> & {
  name: string
  role: string
  summary?: string
  tone?: StudioTone
  mode?: string
  abilities?: string[]
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
  abilities,
  status,
  actions,
  className,
  ...props
}: CoworkerCardProps) {
  return (
    <article {...props} className={cn('studio-coworker-card', className)} style={{ ...toneStyle(tone), ...props.style }}>
      <div className="studio-coworker-card__header">
        <CoworkerAvatar name={name} tone={tone} />
        <div className="studio-coworker-card__identity">
          <h3>{name}</h3>
          <p>{role}</p>
        </div>
        {status ? <Badge tone={statusToneMap[status.tone || 'neutral']}>{status.label}</Badge> : null}
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
      <StudioActions actions={actions} />
    </article>
  )
}

export type ComposerShellProps = ComponentPropsWithoutRef<'form'> & {
  label: string
  placeholder?: string
  helper?: ReactNode
  toolbar?: ReactNode
  actions?: StudioAction[]
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
}

export function ComposerShell({
  label,
  placeholder,
  helper,
  toolbar,
  actions,
  className,
  children,
  ...props
}: ComposerShellProps) {
  return (
    <form {...props} className={cn('studio-composer', className)}>
      <label className="studio-composer__label">
        <span>{label}</span>
        <textarea name="text" rows={3} placeholder={placeholder} />
      </label>
      {children}
      <div className="studio-composer__footer">
        <div className="studio-composer__toolbar">{toolbar || helper}</div>
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
              {item.status ? <Badge tone={statusToneMap[item.status.tone || 'neutral']}>{item.status.label}</Badge> : null}
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
        {status ? <Badge tone={statusToneMap[status.tone || 'neutral']}>{status.label}</Badge> : null}
      </header>
      <div className="studio-review-panel__body">{children}</div>
      <StudioActions actions={actions} />
    </aside>
  )
}

export type ApprovalCardProps = ComponentPropsWithoutRef<'article'> & {
  title: string
  requester?: string
  body?: string
  danger?: boolean
  actions?: StudioAction[]
}

export function ApprovalCard({
  title,
  requester,
  body,
  danger = false,
  actions,
  className,
  ...props
}: ApprovalCardProps) {
  return (
    <article {...props} className={cn('studio-decision-card', danger && 'studio-decision-card--danger', className)}>
      <div className="studio-decision-card__icon" aria-hidden="true">
        <Icon name={danger ? 'alert-circle' : 'circle-help'} size={20} />
      </div>
      <div className="studio-decision-card__copy">
        <h3>{title}</h3>
        {requester ? <p className="studio-decision-card__meta">{requester}</p> : null}
        {body ? <p>{body}</p> : null}
        <StudioActions actions={actions} />
      </div>
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

export function ArtifactCard(props: StudioObjectCardProps) {
  return <StudioObjectCard {...props} defaultIcon="file" className={cn('studio-object-card--artifact', props.className)} />
}

export function ProjectCard(props: StudioObjectCardProps) {
  return <StudioObjectCard {...props} defaultIcon="folder" className={cn('studio-object-card--project', props.className)} />
}

export function ChannelStatusCard(props: StudioObjectCardProps) {
  return <StudioObjectCard {...props} defaultIcon="activity" className={cn('studio-object-card--channel', props.className)} />
}

function StudioObjectCard({
  title,
  description,
  icon,
  defaultIcon,
  meta,
  status,
  actions,
  className,
  ...props
}: StudioObjectCardProps & { defaultIcon: IconName }) {
  return (
    <Card {...props} className={cn('studio-object-card', className)}>
      <div className="studio-object-card__icon" aria-hidden="true">
        <Icon name={icon || defaultIcon} size={20} />
      </div>
      <div className="studio-object-card__copy">
        <div className="studio-object-card__title-row">
          <h3>{title}</h3>
          {status ? <Badge tone={statusToneMap[status.tone || 'neutral']}>{status.label}</Badge> : null}
        </div>
        {description ? <p>{description}</p> : null}
        {meta ? <div className="studio-object-card__meta">{meta}</div> : null}
        <StudioActions actions={actions} />
      </div>
    </Card>
  )
}
