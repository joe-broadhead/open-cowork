/**
 * Active PTT controller registry + accelerator matching (JOE-1110).
 *
 * Menu / global-action paths call requestVoicePttToggle(); the topmost
 * registered composer handler runs. Scope is app-focused only — not OS-wide.
 */
import { normalizeVoicePttShortcut, VOICE_PTT_SHORTCUT } from '@open-cowork/shared'

export type VoicePttToggleHandler = () => void | Promise<void>

const handlers: VoicePttToggleHandler[] = []

export function registerVoicePttToggleHandler(handler: VoicePttToggleHandler): () => void {
  handlers.push(handler)
  return () => {
    const index = handlers.indexOf(handler)
    if (index >= 0) handlers.splice(index, 1)
  }
}

export async function requestVoicePttToggle(): Promise<boolean> {
  const handler = handlers[handlers.length - 1]
  if (!handler) return false
  await handler()
  return true
}

/** Normalize an Electron-style accelerator for comparison. */
export function normalizeAccelerator(value: string | null | undefined): string {
  return normalizeVoicePttShortcut(value) || VOICE_PTT_SHORTCUT
}

type NavigatorPlatformSource = {
  platform?: string
  userAgentData?: {
    platform?: string
  }
}

function rendererPlatform(): string {
  if (typeof navigator === 'undefined') return ''
  const source = navigator as NavigatorPlatformSource
  return source.userAgentData?.platform?.trim() || source.platform || ''
}

/**
 * Match a KeyboardEvent against a validated Electron accelerator.
 * Supports letter keys, Space, and Digit0-9. Intentionally small — not a full parser.
 */
export function matchesAccelerator(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  accelerator: string,
  platform = rendererPlatform(),
): boolean {
  const parts = normalizeAccelerator(accelerator).split('+').filter(Boolean)
  if (parts.length === 0) return false

  let wantMetaOrCtrl = false
  let wantMeta = false
  let wantCtrl = false
  let wantAlt = false
  let wantShift = false
  let keyToken: string | null = null

  for (const part of parts) {
    const token = part.toLowerCase()
    if (token === 'cmdorctrl' || token === 'commandorcontrol') {
      wantMetaOrCtrl = true
      continue
    }
    if (token === 'cmd' || token === 'command' || token === 'super' || token === 'meta') {
      wantMeta = true
      continue
    }
    if (token === 'ctrl' || token === 'control') {
      wantCtrl = true
      continue
    }
    if (token === 'alt' || token === 'option') {
      wantAlt = true
      continue
    }
    if (token === 'shift') {
      wantShift = true
      continue
    }
    keyToken = token
  }

  if (!keyToken) return false

  if (wantMetaOrCtrl) {
    const macOS = platform.toLowerCase().includes('mac')
    if (event.metaKey !== macOS) return false
    if (event.ctrlKey !== !macOS) return false
  } else {
    if (wantMeta !== event.metaKey) return false
    if (wantCtrl !== event.ctrlKey) return false
  }
  if (wantAlt !== event.altKey) return false
  if (wantShift !== event.shiftKey) return false

  const keyAliases: Record<string, string> = {
    return: 'enter',
    esc: 'escape',
    up: 'arrowup',
    down: 'arrowdown',
    left: 'arrowleft',
    right: 'arrowright',
  }
  const expectedKey = keyAliases[keyToken] || keyToken
  const eventKey = event.key.toLowerCase()
  if (keyToken === 'space') {
    return eventKey === ' ' || eventKey === 'space' || event.code === 'Space'
  }
  if (/^\d$/.test(expectedKey)) {
    return eventKey === expectedKey || event.code === `Digit${expectedKey}`
  }
  return eventKey === expectedKey
}
