import assert from 'node:assert/strict'
import test from 'node:test'
import { VOICE_PTT_SHORTCUT } from '@open-cowork/shared'
import { createApplicationMenuTemplate } from '../apps/desktop/src/main/app-menu.ts'

function voiceMenuItem(options: { enabled?: boolean; shortcut?: string | null } = {}) {
  const template = createApplicationMenuTemplate({
    brandName: 'Open Cowork',
    helpUrl: 'https://example.test/help',
    isPackaged: true,
    getMainWindow: () => null,
    openExternalNavigation: () => {},
    voiceEnabled: options.enabled,
    voicePttShortcut: options.shortcut,
  })
  const edit = template.find((entry) => entry.label === 'Edit')
  const submenu = Array.isArray(edit?.submenu) ? edit.submenu : []
  return submenu.find((entry) => entry.label === 'Toggle Voice Dictation')
}

function submenuLabels(label: string) {
  const template = createApplicationMenuTemplate({
    brandName: 'Open Cowork',
    helpUrl: 'https://example.test/help',
    isPackaged: true,
    getMainWindow: () => null,
    openExternalNavigation: () => {},
  })
  const menu = template.find((entry) => entry.label === label)
  const submenu = Array.isArray(menu?.submenu) ? menu.submenu : []
  return submenu.flatMap((entry) => typeof entry.label === 'string' ? [entry.label] : [])
}

test('application menu uses canonical product language', () => {
  const fileLabels = submenuLabels('File')
  const editLabels = submenuLabels('Edit')
  const viewLabels = submenuLabels('View')

  assert.ok(fileLabels.includes('New Chat'))
  assert.ok(fileLabels.includes('Open Project Chat 1'))
  assert.ok(fileLabels.includes('Export Chat…'))
  assert.ok(editLabels.includes('Search Chats'))
  assert.ok(viewLabels.includes('Playbooks'))
  assert.ok(viewLabels.includes('Team'))
  assert.ok(viewLabels.includes('Tools & Skills'))
  assert.ok(![...fileLabels, ...editLabels, ...viewLabels].some((label) => (
    label === 'New Thread' || label === 'Search Threads' || label === 'Workflows' || label === 'Agents'
  )))
})

test('application menu omits Voice when the feature is disabled', () => {
  assert.equal(voiceMenuItem(), undefined)
})

test('application menu uses the persisted Voice shortcut and defaults safely after restart', () => {
  assert.equal(voiceMenuItem({ enabled: true, shortcut: 'CmdOrCtrl+Alt+V' })?.accelerator, 'CmdOrCtrl+Alt+V')
  assert.equal(voiceMenuItem({ enabled: true, shortcut: null })?.accelerator, VOICE_PTT_SHORTCUT)
  assert.equal(voiceMenuItem({ enabled: true, shortcut: 'CmdOrCtrl+Shift+P' })?.accelerator, VOICE_PTT_SHORTCUT)
})
