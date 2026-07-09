import {
  DEFAULT_WINDOW_ZOOM_FACTOR,
  normalizeWindowZoomFactor,
} from '@open-cowork/runtime-host/settings'

export type WindowZoomDirection = 'in' | 'out' | 'reset'

export type WindowZoomInput = {
  type: string
  control?: boolean
  meta?: boolean
  key: string
  code: string
}

export const WINDOW_ZOOM_STEP = 0.1

export function clampWindowZoomFactor(value: unknown) {
  return normalizeWindowZoomFactor(value) ?? DEFAULT_WINDOW_ZOOM_FACTOR
}

export function nextWindowZoomFactor(current: unknown, direction: WindowZoomDirection) {
  if (direction === 'reset') return DEFAULT_WINDOW_ZOOM_FACTOR
  const currentZoom = clampWindowZoomFactor(current)
  return clampWindowZoomFactor(currentZoom + (direction === 'in' ? WINDOW_ZOOM_STEP : -WINDOW_ZOOM_STEP))
}

export function windowZoomDirectionForInput(input: WindowZoomInput): WindowZoomDirection | null {
  if (input.type !== 'keyDown') return null
  if (!input.control && !input.meta) return null
  const key = input.key.toLowerCase()
  const code = input.code
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset'
  if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') return 'in'
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return 'out'
  return null
}
