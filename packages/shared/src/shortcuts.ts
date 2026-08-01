export const COMMAND_PALETTE_SHORTCUT = 'CmdOrCtrl+Shift+P'
export const CAPABILITIES_SHORTCUT = 'CmdOrCtrl+Shift+C'
export const AGENTS_SHORTCUT = 'CmdOrCtrl+Shift+A'
export const SEARCH_THREADS_SHORTCUT = 'CmdOrCtrl+K'
export const NEW_THREAD_SHORTCUT = 'CmdOrCtrl+N'
export const SETTINGS_SHORTCUT = 'CmdOrCtrl+,'
/** Desktop-focused PTT toggle (JOE-1110). Not a system-wide Accessibility hotkey. */
export const VOICE_PTT_SHORTCUT = 'CmdOrCtrl+Shift+Space'

const VOICE_SHORTCUT_MODIFIER = '(?:CmdOrCtrl|CommandOrControl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)'
const VOICE_SHORTCUT_KEY = '(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Return|Escape|Esc|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)'
const VOICE_SHORTCUT_PATTERN = new RegExp(`^(?:${VOICE_SHORTCUT_MODIFIER}\\+)+${VOICE_SHORTCUT_KEY}$`)

const VOICE_SHORTCUT_CONFLICTS = [
  { shortcut: COMMAND_PALETTE_SHORTCUT, label: 'Command Palette' },
  { shortcut: CAPABILITIES_SHORTCUT, label: 'Tools & Skills' },
  { shortcut: AGENTS_SHORTCUT, label: 'Team' },
  { shortcut: SEARCH_THREADS_SHORTCUT, label: 'Search Chats' },
  { shortcut: NEW_THREAD_SHORTCUT, label: 'New Chat' },
  { shortcut: SETTINGS_SHORTCUT, label: 'Settings' },
  { shortcut: 'CmdOrCtrl+B', label: 'Toggle Sidebar' },
  { shortcut: 'CmdOrCtrl+Shift+E', label: 'Export Chat' },
  { shortcut: 'CmdOrCtrl+Z', label: 'Undo' },
  { shortcut: 'CmdOrCtrl+Shift+Z', label: 'Redo' },
  { shortcut: 'Ctrl+Y', label: 'Redo' },
  { shortcut: 'CmdOrCtrl+X', label: 'Cut' },
  { shortcut: 'CmdOrCtrl+C', label: 'Copy' },
  { shortcut: 'CmdOrCtrl+V', label: 'Paste' },
  { shortcut: 'CmdOrCtrl+A', label: 'Select All' },
  { shortcut: 'CmdOrCtrl+W', label: 'Close Window' },
  { shortcut: 'Command+M', label: 'Minimize Window' },
  { shortcut: 'Command+Q', label: 'Quit' },
  { shortcut: 'Command+H', label: 'Hide' },
  { shortcut: 'Command+Alt+H', label: 'Hide Others' },
  { shortcut: 'Command+Control+F', label: 'Full Screen' },
  ...Array.from({ length: 9 }, (_value, index) => ({
    shortcut: `CmdOrCtrl+${index + 1}`,
    label: `Open Project Chat ${index + 1}`,
  })),
] as const

function canonicalModifier(value: string) {
  const token = value.toLowerCase()
  if (token === 'cmdorctrl' || token === 'commandorcontrol') return 'cmdorctrl'
  if (token === 'command' || token === 'cmd' || token === 'super' || token === 'meta') return 'meta'
  if (token === 'control' || token === 'ctrl') return 'ctrl'
  if (token === 'option') return 'alt'
  return token
}

function acceleratorIdentities(value: string) {
  const parts = value.replace(/\s+/g, '').split('+').filter(Boolean)
  const key = parts.pop()?.toLowerCase() || ''
  let variants: string[][] = [[]]
  for (const part of parts) {
    const modifier = canonicalModifier(part)
    if (modifier === 'cmdorctrl') {
      variants = variants.flatMap((current) => [
        [...current, 'meta'],
        [...current, 'ctrl'],
      ])
    } else {
      variants = variants.map((current) => [...current, modifier])
    }
  }
  return Array.from(new Set(variants.map(
    (modifiers) => `${Array.from(new Set(modifiers)).sort().join('+')}+${key}`,
  )))
}

function hasAmbiguousModifiers(value: string) {
  const modifiers = value.split('+').slice(0, -1).map(canonicalModifier)
  const unique = new Set(modifiers)
  return unique.size !== modifiers.length
    || (unique.has('cmdorctrl') && (unique.has('meta') || unique.has('ctrl')))
}

function hasNonShiftModifier(value: string) {
  return value.split('+').slice(0, -1).some((modifier) => canonicalModifier(modifier) !== 'shift')
}

export type VoicePttShortcutValidation =
  | { ok: true; value: string }
  | { ok: false; reason: 'format' }
  | { ok: false; reason: 'conflict'; conflict: string }

/**
 * Validate the deliberately small, app-focused accelerator subset supported by
 * both Electron menus and the renderer key matcher. Empty values mean reset.
 */
export function validateVoicePttShortcut(value: unknown): VoicePttShortcutValidation {
  if (value === null || value === undefined) return { ok: true, value: VOICE_PTT_SHORTCUT }
  if (typeof value !== 'string') return { ok: false, reason: 'format' }
  const shortcut = value.replace(/\s+/g, '') || VOICE_PTT_SHORTCUT
  if (new TextEncoder().encode(shortcut).byteLength > 64
    || !VOICE_SHORTCUT_PATTERN.test(shortcut)
    || hasAmbiguousModifiers(shortcut)
    || !hasNonShiftModifier(shortcut)) {
    return { ok: false, reason: 'format' }
  }
  const identities = new Set(acceleratorIdentities(shortcut))
  const conflict = VOICE_SHORTCUT_CONFLICTS.find((entry) => (
    acceleratorIdentities(entry.shortcut).some((identity) => identities.has(identity))
  ))
  if (conflict) return { ok: false, reason: 'conflict', conflict: conflict.label }
  return { ok: true, value: shortcut }
}

/** Normalize settings input; undefined means a partial update omitted the field. */
export function normalizeVoicePttShortcut(value: unknown): string | undefined {
  // Callers that normalize partial settings use undefined to mean "no update";
  // null/blank remain the explicit reset-to-default forms.
  if (value === undefined) return undefined
  const result = validateVoicePttShortcut(value)
  return result.ok ? result.value : undefined
}
