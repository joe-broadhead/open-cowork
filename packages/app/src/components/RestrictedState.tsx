import { type ReactNode } from 'react'
import { EmptyState, type IconName } from './ui'

export type RestrictedStateProps = {
  /** Human title for the restricted panel, e.g. "Switch to Local for desktop Knowledge". */
  title: string
  /** Primary explanation of why the action is unavailable here. */
  body?: ReactNode
  /** Optional secondary line that names the specific gating reason. */
  reason?: string
  /**
   * Restricted affordance glyph. Defaults to the canonical protected/shield
   * marker so every "you can't do this in this workspace" panel reads the same.
   */
  icon?: IconName
  /** Optional action slot, e.g. a button that opens Cloud Web. */
  action?: ReactNode
}

/**
 * Canonical "this is restricted in this workspace" panel.
 *
 * Wraps the shared {@link EmptyState} so it inherits the graphite styling, then
 * gives it a consistent restricted shape: a protected glyph, a title, a body,
 * an optional reason line, and an optional action. Use this anywhere a surface
 * is genuinely blocked because the active workspace is cloud-managed/restricted,
 * rather than re-deriving the markup per page.
 *
 * Desktop-only: it may compose './ui' primitives but never touches
 * window.coworkApi.
 */
export function RestrictedState({
  title,
  body,
  reason,
  icon = 'shield-check',
  action,
}: RestrictedStateProps) {
  const hasExtras = reason != null || action != null
  return (
    <EmptyState
      icon={icon}
      title={title}
      // EmptyState renders `body` as a child node, so a ReactNode is safe at
      // runtime even though its prop is typed `string`; the cast bridges that
      // single boundary without widening the shared primitive.
      body={(body ?? '') as string}
      action={hasExtras ? (
        <div className="flex flex-col items-center gap-3">
          {reason != null ? <p className="text-xs text-text-muted">{reason}</p> : null}
          {action}
        </div>
      ) : undefined}
    />
  )
}
