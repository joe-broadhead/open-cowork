import { type ReactNode } from 'react'
import { cn } from './utils.js'

export type WorkbenchLayoutProps = {
  leftPane?: ReactNode
  mainPane: ReactNode
  reviewPane?: ReactNode
  actionCluster?: ReactNode
  overlays?: ReactNode
  leftLabel?: string
  mainLabel?: string
  reviewLabel?: string
  reviewOpen?: boolean
  className?: string
}

export function WorkbenchLayout({
  leftPane,
  mainPane,
  reviewPane,
  actionCluster,
  overlays,
  leftLabel = 'Threads',
  mainLabel = 'Conversation',
  reviewLabel = 'Review',
  reviewOpen = Boolean(reviewPane),
  className,
}: WorkbenchLayoutProps) {
  return (
    <section
      className={cn(
        'ui-workbench-layout',
        Boolean(leftPane) && 'ui-workbench-layout--with-left',
        Boolean(reviewOpen && reviewPane) && 'ui-workbench-layout--with-review',
        className,
      )}
      data-workbench-layout="true"
      data-review-open={reviewOpen && reviewPane ? 'true' : 'false'}
    >
      {leftPane ? (
        <aside className="ui-workbench-layout__left" aria-label={leftLabel} data-workbench-pane="threads">
          {leftPane}
        </aside>
      ) : null}
      <section className="ui-workbench-layout__main" aria-label={mainLabel} data-workbench-pane="conversation">
        {actionCluster ? <div className="ui-workbench-layout__actions">{actionCluster}</div> : null}
        {mainPane}
      </section>
      {reviewPane ? (
        <aside className="ui-workbench-layout__review" aria-label={reviewLabel} data-workbench-pane="review" hidden={!reviewOpen}>
          {reviewPane}
        </aside>
      ) : null}
      {overlays}
    </section>
  )
}
