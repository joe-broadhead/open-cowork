import {
  useEffect,
  forwardRef,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type InputHTMLAttributes,
  type InputEvent,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react'
import { DisabledHint } from './DisabledHint.js'
import { Icon, type IconName } from './Icon.js'
import { IconButton } from './Button.js'
import { cn } from './utils.js'

type FieldSize = 'sm' | 'md' | 'lg'
type TextareaMaxHeight = 'sm' | 'md' | 'lg' | number | string
type TextareaStyle = CSSProperties & {
  '--ui-textarea-max-height'?: string
}

const TEXTAREA_MAX_HEIGHTS = {
  sm: 'calc(var(--space-12) * 2)',
  md: 'calc(var(--space-12) * 3)',
  lg: 'calc(var(--space-12) * 4)',
} as const

function resolveTextareaMaxHeight(maxHeight: TextareaMaxHeight | undefined) {
  if (typeof maxHeight === 'number') return `${maxHeight}px`
  if (!maxHeight) return undefined
  return TEXTAREA_MAX_HEIGHTS[maxHeight as keyof typeof TEXTAREA_MAX_HEIGHTS] || maxHeight
}

function assignRefs<T>(node: T, ...refs: Array<Ref<T> | undefined>) {
  for (const ref of refs) {
    if (!ref) continue
    if (typeof ref === 'function') {
      ref(node)
    } else {
      ref.current = node
    }
  }
}

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  size?: FieldSize
  leftIcon?: IconName
  error?: string | null
  clearable?: boolean
  onClear?: () => void
  disabledReason?: string | null
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function InputPrimitive({
  size = 'md',
  leftIcon,
  error,
  clearable = false,
  onClear,
  disabled,
  disabledReason,
  className,
  value,
  defaultValue,
  onChange,
  'aria-describedby': ariaDescribedBy,
  ...props
}, ref) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const errorId = error ? `${id}-error` : undefined
  const disabledId = disabledReason ? `${id}-disabled` : undefined
  const describedBy = [ariaDescribedBy, errorId, disabledId].filter(Boolean).join(' ') || undefined
  const isDisabled = disabled || Boolean(disabledReason)
  const isControlled = value !== undefined
  const [uncontrolledValue, setUncontrolledValue] = useState(() => defaultValue === undefined ? '' : String(defaultValue))
  const currentValue = isControlled ? value : uncontrolledValue
  const hasValue = currentValue !== undefined && String(currentValue).length > 0

  const clear = () => {
    onClear?.()
    const input = inputRef.current
    if (!input) return
    if (!isControlled) setUncontrolledValue('')
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    nativeSetter?.call(input, '')
    const event = new Event('input', { bubbles: true })
    input.dispatchEvent(event)
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!isControlled) setUncontrolledValue(event.currentTarget.value)
    onChange?.(event)
  }

  return (
    <label className="ui-field">
      <span className="ui-field__chrome">
        {leftIcon ? <span className="ui-field__left-icon"><Icon name={leftIcon} size={16} /></span> : null}
        <input
          {...props}
          ref={(node) => {
            inputRef.current = node
            assignRefs(node, ref)
          }}
          value={value}
          defaultValue={defaultValue}
          onChange={handleChange}
          disabled={isDisabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'ui-input',
            `ui-input--${size}`,
            leftIcon && 'ui-input--with-left-icon',
            clearable && 'ui-input--clearable',
            className,
          )}
        />
        {clearable && hasValue ? (
          <span className="ui-input__clear">
            <IconButton icon="x" label="Clear" size="sm" onClick={clear} disabled={isDisabled} />
          </span>
        ) : null}
      </span>
      {error ? <span id={errorId} className="ui-field__message ui-field__message--error">{error}</span> : null}
      {disabledReason ? <DisabledHint id={disabledId!} reason={disabledReason} /> : null}
    </label>
  )
})

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  autoGrow?: boolean
  maxHeight?: TextareaMaxHeight
  error?: string | null
  disabledReason?: string | null
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function TextareaPrimitive({
  autoGrow = false,
  maxHeight,
  error,
  disabled,
  disabledReason,
  className,
  onInput,
  'aria-describedby': ariaDescribedBy,
  ...props
}, ref) {
  const id = useId()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const errorId = error ? `${id}-error` : undefined
  const disabledId = disabledReason ? `${id}-disabled` : undefined
  const describedBy = [ariaDescribedBy, errorId, disabledId].filter(Boolean).join(' ') || undefined
  const isDisabled = disabled || Boolean(disabledReason)
  const resolvedMaxHeight = resolveTextareaMaxHeight(maxHeight)
  const textareaStyle: TextareaStyle | undefined = resolvedMaxHeight
    ? { ...props.style, '--ui-textarea-max-height': resolvedMaxHeight }
    : props.style

  const resize = () => {
    if (!autoGrow || !textareaRef.current) return
    const element = textareaRef.current
    element.style.height = 'auto'
    const limit = typeof maxHeight === 'number' ? maxHeight : Number.POSITIVE_INFINITY
    const next = Math.min(element.scrollHeight, limit)
    element.style.height = `${next}px`
  }

  useEffect(() => {
    resize()
  })

  const handleInput = (event: InputEvent<HTMLTextAreaElement>) => {
    resize()
    onInput?.(event)
  }

  return (
    <label className="ui-field">
      <textarea
        {...props}
        ref={(node) => {
          textareaRef.current = node
          assignRefs(node, ref)
        }}
        disabled={isDisabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn('ui-textarea', className)}
        onInput={handleInput}
        style={textareaStyle}
      />
      {error ? <span id={errorId} className="ui-field__message ui-field__message--error">{error}</span> : null}
      {disabledReason ? <DisabledHint id={disabledId!} reason={disabledReason} /> : null}
    </label>
  )
})
