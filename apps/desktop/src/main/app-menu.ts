import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import {
  AGENTS_SHORTCUT,
  CAPABILITIES_SHORTCUT,
  COMMAND_PALETTE_SHORTCUT,
  NEW_THREAD_SHORTCUT,
  SEARCH_THREADS_SHORTCUT,
  SETTINGS_SHORTCUT,
  normalizeVoicePttShortcut,
  VOICE_PTT_SHORTCUT,
} from '@open-cowork/shared'

function toGithubIssuesUrl(helpUrl: string): string | null {
  try {
    const parsed = new URL(helpUrl)
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return null
    const [owner, repoRaw] = segments
    if (!owner || !repoRaw) return null
    const repo = repoRaw.replace(/\.git$/, '')
    return `https://github.com/${owner}/${repo}/issues/new/choose`
  } catch {
    return null
  }
}

export function createApplicationMenuTemplate(options: {
  brandName: string
  helpUrl: string
  isPackaged: boolean
  getMainWindow: () => BrowserWindow | null
  openExternalNavigation: (url: string) => void
  voiceEnabled?: boolean
  voicePttShortcut?: string | null
}): MenuItemConstructorOptions[] {
  const { brandName, helpUrl, isPackaged, getMainWindow, openExternalNavigation } = options
  const voicePttShortcut = normalizeVoicePttShortcut(options.voicePttShortcut) || VOICE_PTT_SHORTCUT
  return [
    {
      label: brandName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings', accelerator: SETTINGS_SHORTCUT, click: () => getMainWindow()?.webContents.send('navigate', 'settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: NEW_THREAD_SHORTCUT, click: () => getMainWindow()?.webContents.send('action', 'new-thread') },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_value, index) => ({
          label: `Open Project Chat ${index + 1}`,
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: () => getMainWindow()?.webContents.send('action', `project-switch:${index + 1}`),
        })),
        { type: 'separator' },
        { label: 'Export Chat…', accelerator: 'CmdOrCtrl+Shift+E', click: () => getMainWindow()?.webContents.send('action', 'export') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Search Chats', accelerator: SEARCH_THREADS_SHORTCUT, click: () => getMainWindow()?.webContents.send('action', 'search') },
        ...(options.voiceEnabled === true
          ? [
              { type: 'separator' as const },
              {
                label: 'Toggle Voice Dictation',
                accelerator: voicePttShortcut,
                click: () => getMainWindow()?.webContents.send('action', 'voice-ptt-toggle'),
              },
            ]
          : []),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => getMainWindow()?.webContents.send('action', 'toggle-sidebar') },
        { label: 'Command Palette…', accelerator: COMMAND_PALETTE_SHORTCUT, click: () => getMainWindow()?.webContents.send('action', 'command-palette') },
        { label: 'Playbooks', click: () => getMainWindow()?.webContents.send('navigate', 'playbooks') },
        { label: 'Team', accelerator: AGENTS_SHORTCUT, click: () => getMainWindow()?.webContents.send('navigate', 'team') },
        { label: 'Tools & Skills', accelerator: CAPABILITIES_SHORTCUT, click: () => getMainWindow()?.webContents.send('navigate', 'tools') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: `${brandName} Documentation`, click: () => openExternalNavigation(helpUrl) },
        {
          label: 'Report an Issue',
          click: () => {
            const issuesUrl = toGithubIssuesUrl(helpUrl) || helpUrl
            openExternalNavigation(issuesUrl)
          },
        },
        ...(!isPackaged
          ? [
              { type: 'separator' as const },
              { role: 'toggleDevTools' as const },
            ]
          : []),
      ],
    },
  ]
}
