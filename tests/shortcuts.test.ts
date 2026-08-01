import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VOICE_PTT_SHORTCUT,
  normalizeVoicePttShortcut,
  validateVoicePttShortcut,
} from '@open-cowork/shared'

test('voice shortcut normalization owns default, syntax, and product conflicts', () => {
  assert.equal(normalizeVoicePttShortcut(null), VOICE_PTT_SHORTCUT)
  assert.equal(normalizeVoicePttShortcut(undefined), undefined)
  assert.equal(normalizeVoicePttShortcut('  '), VOICE_PTT_SHORTCUT)
  assert.equal(normalizeVoicePttShortcut('CmdOrCtrl+Alt+V'), 'CmdOrCtrl+Alt+V')

  assert.deepEqual(validateVoicePttShortcut('V'), {
    ok: false,
    reason: 'format',
  })
  assert.deepEqual(validateVoicePttShortcut('Shift+A'), {
    ok: false,
    reason: 'format',
  })
  assert.deepEqual(validateVoicePttShortcut('Shift+Tab'), {
    ok: false,
    reason: 'format',
  })
  assert.deepEqual(validateVoicePttShortcut('CmdOrCtrl+Shift+P'), {
    ok: false,
    reason: 'conflict',
    conflict: 'Command Palette',
  })
  assert.deepEqual(validateVoicePttShortcut('CmdOrCtrl+C'), {
    ok: false,
    reason: 'conflict',
    conflict: 'Copy',
  })
  assert.deepEqual(validateVoicePttShortcut('CmdOrCtrl+K'), {
    ok: false,
    reason: 'conflict',
    conflict: 'Search Chats',
  })
  assert.deepEqual(validateVoicePttShortcut('CmdOrCtrl+N'), {
    ok: false,
    reason: 'conflict',
    conflict: 'New Chat',
  })
  assert.deepEqual(validateVoicePttShortcut('CmdOrCtrl+Shift+E'), {
    ok: false,
    reason: 'conflict',
    conflict: 'Export Chat',
  })
  assert.deepEqual(validateVoicePttShortcut('CmdOrCtrl+1'), {
    ok: false,
    reason: 'conflict',
    conflict: 'Open Project Chat 1',
  })
  assert.deepEqual(validateVoicePttShortcut('Command+Control+F'), {
    ok: false,
    reason: 'conflict',
    conflict: 'Full Screen',
  })
  assert.deepEqual(validateVoicePttShortcut('CmdOrCtrl+F'), {
    ok: true,
    value: 'CmdOrCtrl+F',
  })
  assert.equal(normalizeVoicePttShortcut('CmdOrCtrl+Shift+P'), undefined)
  assert.equal(normalizeVoicePttShortcut('CmdOrCtrl+Ctrl+V'), undefined)
  assert.equal(normalizeVoicePttShortcut('Alt+Option+V'), undefined)
})
