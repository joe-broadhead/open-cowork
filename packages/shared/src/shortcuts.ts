export const COMMAND_PALETTE_SHORTCUT = 'CmdOrCtrl+Shift+P'
export const CAPABILITIES_SHORTCUT = 'CmdOrCtrl+Shift+C'
export const AGENTS_SHORTCUT = 'CmdOrCtrl+Shift+A'
export const SEARCH_THREADS_SHORTCUT = 'CmdOrCtrl+K'
export const NEW_THREAD_SHORTCUT = 'CmdOrCtrl+N'
export const SETTINGS_SHORTCUT = 'CmdOrCtrl+,'

export type ShortcutLikeEvent = {
  metaKey: boolean
  ctrlKey: boolean
  altKey?: boolean
  shiftKey: boolean
  key: string
}

export function matchesAccelerator(event: ShortcutLikeEvent, accelerator: string) {
  const tokens = accelerator.split('+').map((token) => token.trim().toLowerCase())
  const keyToken = tokens[tokens.length - 1] || ''
  const requiredCmdOrCtrl = tokens.includes('cmdorctrl')
  const requiredShift = tokens.includes('shift')
  const requiredAlt = tokens.includes('alt') || tokens.includes('option')

  if (requiredCmdOrCtrl !== (event.metaKey || event.ctrlKey)) return false
  if (requiredShift !== !!event.shiftKey) return false
  if (requiredAlt !== !!event.altKey) return false

  return event.key.toLowerCase() === keyToken.toLowerCase()
}
