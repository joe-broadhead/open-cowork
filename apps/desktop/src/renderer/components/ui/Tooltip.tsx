import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'

type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

type DescribedChildProps = {
  'aria-describedby'?: string
}

export type TooltipProps = {
  content: ReactNode
  children: ReactNode
  side?: TooltipSide
  delay?: number
}

function readTooltipGap() {
  if (typeof window === 'undefined') return 8
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue('--space-2')
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : 8
}

function positionFor(side: TooltipSide, rect: DOMRect) {
  const gap = readTooltipGap()
  switch (side) {
    case 'right':
      return { top: rect.top + (rect.height / 2), left: rect.right + gap, transform: 'translateY(-50%)' }
    case 'bottom':
      return { top: rect.bottom + gap, left: rect.left + (rect.width / 2), transform: 'translateX(-50%)' }
    case 'left':
      return { top: rect.top + (rect.height / 2), left: rect.left - gap, transform: 'translate(-100%, -50%)' }
    case 'top':
    default:
      return { top: rect.top - gap, left: rect.left + (rect.width / 2), transform: 'translate(-50%, -100%)' }
  }
}

export function Tooltip({
  content,
  children,
  side = 'top',
  delay = 250,
}: TooltipProps) {
  const id = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const timeoutRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<ReturnType<typeof positionFor> | null>(null)

  const show = () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = window.setTimeout(() => setOpen(true), delay)
  }

  const hide = () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    setOpen(false)
  }

  useEffect(() => {
    if (!open || !anchorRef.current) return
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect) setPosition(positionFor(side, rect))
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, side])

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
  }, [])

  const describedChild = isValidElement(children) && open
    ? cloneElement(children as ReactElement<DescribedChildProps>, {
        'aria-describedby': [
          (children.props as DescribedChildProps)['aria-describedby'],
          id,
        ].filter(Boolean).join(' '),
      })
    : children

  return (
    // The wrapper only observes hover/focus to position descriptive text.
    // The child keeps the actual interactive semantics and keyboard behavior.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <span
      ref={anchorRef}
      className="ui-tooltip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {describedChild}
      {open && position ? (
        <span
          id={id}
          role="tooltip"
          className="ui-tooltip"
          style={position}
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}
