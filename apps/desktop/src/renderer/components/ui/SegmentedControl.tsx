import { useEffect, useId, useRef, useState } from 'react'
import { DisabledHint } from './DisabledHint'
import { cn, nextEnabledIndex } from './utils'

export type SegmentedControlOption = {
  value: string
  label: string
  disabled?: boolean
  disabledReason?: string
}

export type SegmentedControlProps = {
  options: SegmentedControlOption[]
  value: string
  onChange: (value: string) => void
  label: string
  disabled?: boolean
  disabledReason?: string | null
  className?: string
}

export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  disabled = false,
  disabledReason,
  className,
}: SegmentedControlProps) {
  const id = useId()
  const [activeIndex, setActiveIndex] = useState(Math.max(0, options.findIndex((option) => option.value === value)))
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const emptyReason = options.length === 0 ? 'No segments available.' : null
  const isDisabled = disabled || Boolean(disabledReason) || Boolean(emptyReason)
  const disabledId = disabledReason ? `${id}-disabled` : undefined
  const emptyId = emptyReason ? `${id}-empty` : undefined
  const describedBy = [disabledId, emptyId].filter(Boolean).join(' ') || undefined

  useEffect(() => {
    const selectedIndex = options.findIndex((option) => option.value === value)
    if (selectedIndex >= 0) setActiveIndex(selectedIndex)
  }, [options, value])

  const move = (direction: 1 | -1) => {
    const next = nextEnabledIndex(options, activeIndex, direction)
    if (next < 0) return
    setActiveIndex(next)
    refs.current[next]?.focus()
  }

  return (
    <span className={cn('ui-control-stack', className)}>
      <span
        role="tablist"
        aria-label={label}
        aria-describedby={describedBy}
        className="ui-segmented-control"
      >
        {options.map((option, index) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              ref={(node) => { refs.current[index] = node }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              disabled={isDisabled || option.disabled}
              className="ui-segmented-option"
              onClick={() => {
                if (!option.disabled) onChange(option.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                  event.preventDefault()
                  move(1)
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  move(-1)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (!option.disabled) onChange(option.value)
                }
              }}
            >
              {option.label}
            </button>
          )
        })}
      </span>
      {disabledReason ? <DisabledHint id={disabledId!} reason={disabledReason} /> : null}
      {emptyReason ? <DisabledHint id={emptyId!} reason={emptyReason} /> : null}
    </span>
  )
}
