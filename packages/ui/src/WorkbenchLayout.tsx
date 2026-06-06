import { type ReactNode, useEffect, useRef } from 'react'
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

const WORKBENCH_DRAWER_QUERY = '(max-width: 920px)'
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function isDrawerMode() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(WORKBENCH_DRAWER_QUERY).matches
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
  const reviewRef = useRef<HTMLElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const isReviewVisible = Boolean(reviewOpen && reviewPane)

  useEffect(() => {
    if (!isReviewVisible || !isDrawerMode()) return undefined
    const review = reviewRef.current
    if (!review) return undefined

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreFocusRef.current = previous && !review.contains(previous) ? previous : restoreFocusRef.current
    review.focus({ preventScroll: true })

    const focusableWithinReview = () => Array.from(review.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.tabIndex !== -1 && element.getAttribute('aria-hidden') !== 'true')

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = focusableWithinReview()
      if (focusable.length === 0) {
        event.preventDefault()
        review.focus({ preventScroll: true })
        return
      }

      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || document.activeElement === review)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const restoreTarget = restoreFocusRef.current
      if (restoreTarget && document.contains(restoreTarget) && review.contains(document.activeElement)) {
        restoreTarget.focus({ preventScroll: true })
      }
      restoreFocusRef.current = null
    }
  }, [isReviewVisible])

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
        <aside
          ref={reviewRef}
          className="ui-workbench-layout__review"
          aria-label={reviewLabel}
          data-workbench-pane="review"
          hidden={!isReviewVisible}
          tabIndex={isReviewVisible ? -1 : undefined}
        >
          {reviewPane}
        </aside>
      ) : null}
      {overlays}
    </section>
  )
}
