import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useFocusTrap } from './useFocusTrap.js'
import { DisabledHint } from './DisabledHint.js'
import { Icon } from './Icon.js'
import { cn, nextEnabledIndex } from './utils.js'

export type SelectOption = {
  value: string
  label: string
  disabled?: boolean
  disabledReason?: string
}

export type SelectProps = {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  label?: string
  disabled?: boolean
  disabledReason?: string | null
  className?: string
}

export function Select({
  options,
  value,
  onChange,
  label = 'Select option',
  disabled = false,
  disabledReason,
  className,
}: SelectProps) {
  const id = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const selectedOption = options[selectedIndex] || options[0]
  const selectedEnabledIndex = options[selectedIndex]?.disabled ? nextEnabledIndex(options, selectedIndex, 1) : selectedIndex
  const emptyReason = options.length === 0 ? 'No options available.' : null
  const isDisabled = disabled || Boolean(disabledReason) || Boolean(emptyReason)
  const disabledId = disabledReason ? `${id}-disabled` : undefined
  const emptyId = emptyReason ? `${id}-empty` : undefined
  const listboxId = `${id}-listbox`
  const describedBy = [disabledId, emptyId].filter(Boolean).join(' ') || undefined

  useFocusTrap(listRef, { active: open, onEscape: () => setOpen(false) })

  useEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  const openList = () => {
    if (isDisabled) return
    setActiveIndex(selectedEnabledIndex >= 0 ? selectedEnabledIndex : selectedIndex)
    setOpen(true)
  }

  const select = (option: SelectOption | undefined) => {
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openList()
    }
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = nextEnabledIndex(options, activeIndex, event.key === 'ArrowDown' ? 1 : -1)
      if (next >= 0) setActiveIndex(next)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(options[activeIndex])
    }
  }

  return (
    <span className={cn('ui-control-stack', className)}>
      <span className="ui-popover-root">
        <button
          type="button"
          className="ui-select-trigger"
          aria-label={`${label}: ${selectedOption?.label || 'No selection'}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-describedby={describedBy}
          disabled={isDisabled}
          onClick={() => (open ? setOpen(false) : openList())}
          onKeyDown={onTriggerKeyDown}
        >
          <span>{selectedOption?.label || label}</span>
          <Icon name="chevron-down" size={16} />
        </button>
        {open ? (
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="ui-popover"
            onKeyDown={onListKeyDown}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                ref={(node) => { optionRefs.current[index] = node }}
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-active={index === activeIndex}
                disabled={option.disabled}
                className="ui-popover-item"
                onClick={() => select(option)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="ui-popover-item__content">
                  <span>{option.label}</span>
                  {option.disabled && option.disabledReason ? <span className="ui-popover-item__hint">{option.disabledReason}</span> : null}
                </span>
                {option.value === value ? <Icon name="check" size={16} /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </span>
      {disabledReason ? <DisabledHint id={disabledId!} reason={disabledReason} /> : null}
      {emptyReason ? <DisabledHint id={emptyId!} reason={emptyReason} /> : null}
    </span>
  )
}

export type MenuItem = {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
  disabledReason?: string
}

export type MenuProps = {
  label: string
  triggerLabel?: string
  items: MenuItem[]
  onSelect: (id: string) => void
  disabled?: boolean
  disabledReason?: string | null
  className?: string
}

export function Menu({
  label,
  triggerLabel = label,
  items,
  onSelect,
  disabled = false,
  disabledReason,
  className,
}: MenuProps) {
  const id = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const emptyReason = items.length === 0 ? 'No actions available.' : null
  const isDisabled = disabled || Boolean(disabledReason) || Boolean(emptyReason)
  const disabledId = disabledReason ? `${id}-disabled` : undefined
  const emptyId = emptyReason ? `${id}-empty` : undefined
  const menuId = `${id}-menu`
  const describedBy = [disabledId, emptyId].filter(Boolean).join(' ') || undefined

  useFocusTrap(menuRef, { active: open, onEscape: () => setOpen(false) })

  useEffect(() => {
    if (!open) return
    itemRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  const openMenu = () => {
    if (isDisabled) return
    const first = items.findIndex((item) => !item.disabled)
    setActiveIndex(Math.max(first, 0))
    setOpen(true)
  }

  const choose = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return
    onSelect(item.id)
    setOpen(false)
  }

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = nextEnabledIndex(items, activeIndex, event.key === 'ArrowDown' ? 1 : -1)
      if (next >= 0) setActiveIndex(next)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(items[activeIndex])
    }
  }

  return (
    <span className={cn('ui-control-stack', className)}>
      <span className="ui-popover-root">
        <button
          type="button"
          className="ui-menu-trigger"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-describedby={describedBy}
          disabled={isDisabled}
          onClick={() => (open ? setOpen(false) : openMenu())}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openMenu()
            }
          }}
        >
          <span>{triggerLabel}</span>
          <Icon name="chevron-down" size={16} />
        </button>
        {open ? (
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className="ui-popover"
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item, index) => (
              <button
                key={item.id}
                ref={(node) => { itemRefs.current[index] = node }}
                type="button"
                role="menuitem"
                data-active={index === activeIndex}
                disabled={item.disabled}
                className="ui-popover-item"
                onClick={() => choose(item)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="ui-popover-item__content">
                  <span className="ui-popover-item__label">
                    {item.icon}
                    {item.label}
                  </span>
                  {item.disabled && item.disabledReason ? <span className="ui-popover-item__hint">{item.disabledReason}</span> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </span>
      {disabledReason ? <DisabledHint id={disabledId!} reason={disabledReason} /> : null}
      {emptyReason ? <DisabledHint id={emptyId!} reason={emptyReason} /> : null}
    </span>
  )
}
