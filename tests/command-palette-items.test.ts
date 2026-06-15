import test from 'node:test'
import assert from 'node:assert/strict'
import type { BuiltInAgentDetail, CustomAgentSummary, SessionInfo } from '@open-cowork/shared'
import { buildCommandPaletteItems, getShortcutPlatform } from '../apps/desktop/src/renderer/components/command-palette-items.ts'
import type { PrimaryAgentMode } from '../apps/desktop/src/renderer/stores/session.ts'

function createCallbacks() {
  const calls: Array<{ type: string; value?: string }> = []
  return {
    calls,
    callbacks: {
      onNavigate: (view: 'home' | 'chat' | 'agents' | 'capabilities') => {
        calls.push({ type: 'navigate', value: view })
      },
      onCreateThread: async (directory?: string) => {
        calls.push({ type: 'thread', value: directory || '' })
        return {
          id: 'session-1',
          title: 'Test',
          directory: directory || null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        } as SessionInfo
      },
      onEnsureSession: async () => {
        calls.push({ type: 'ensure' })
        return true
      },
      onInsertComposer: (text: string) => {
        calls.push({ type: 'insert', value: text })
      },
      onClearSessionPrimaryAgent: () => {
        calls.push({ type: 'clear-primary-agent' })
      },
      onSetAgentMode: (mode: PrimaryAgentMode) => {
        calls.push({ type: 'mode', value: mode })
      },
      onStartAgentChat: async (agentName: string) => {
        calls.push({ type: 'start-agent-chat', value: agentName })
      },
      onSelectDirectory: async () => '/tmp/project',
      onOpenSettings: () => {
        calls.push({ type: 'settings' })
      },
      onToggleSearch: () => {
        calls.push({ type: 'search' })
      },
      onRunCommand: async (name: string) => {
        calls.push({ type: 'command', value: name })
        return true
      },
    },
  }
}

test('buildCommandPaletteItems adapts shortcut hints for mac and non-mac platforms', () => {
  const { callbacks } = createCallbacks()
  const macItems = buildCommandPaletteItems({
    commands: [],
    builtinAgents: [],
    customAgents: [],
    platform: 'MacIntel',
    ...callbacks,
  })
  const linuxItems = buildCommandPaletteItems({
    commands: [],
    builtinAgents: [],
    customAgents: [],
    platform: 'Linux x86_64',
    ...callbacks,
  })

  assert.equal(macItems.find((item) => item.id === 'create:search')?.hint, 'Cmd + K')
  assert.equal(linuxItems.find((item) => item.id === 'create:search')?.hint, 'Ctrl + K')
})

test('getShortcutPlatform prefers userAgentData and falls back to legacy platform', () => {
  assert.equal(getShortcutPlatform({
    userAgentData: { platform: 'macOS' },
    platform: 'Linux x86_64',
  }), 'macOS')
  assert.equal(getShortcutPlatform({ platform: 'MacIntel' }), 'MacIntel')
  assert.equal(getShortcutPlatform({}), '')
})

test('buildCommandPaletteItems filters runtime commands and exposes valid agents only', async () => {
  const { callbacks, calls } = createCallbacks()
  const builtinAgents: BuiltInAgentDetail[] = [
    {
      name: 'build',
      label: 'Build',
      color: 'primary',
      description: 'Primary build mode',
      mode: 'primary',
      hidden: false,
      source: 'opencode',
      instructions: 'Build things',
      skills: [],
      toolAccess: [],
      nativeToolIds: [],
      configuredToolIds: [],
    },
    {
      name: 'research',
      label: 'Research',
      color: 'accent',
      description: 'Research subagent',
      mode: 'subagent',
      hidden: false,
      source: 'open-cowork',
      instructions: 'Research things',
      skills: [],
      toolAccess: [],
      nativeToolIds: [],
      configuredToolIds: [],
    },
    {
      name: 'chief-of-staff',
      label: 'Cleo',
      color: 'accent',
      description: 'Chief-of-Staff planner',
      mode: 'primary',
      hidden: false,
      source: 'open-cowork',
      instructions: 'Plan objectives',
      skills: [],
      toolAccess: [],
      nativeToolIds: [],
      configuredToolIds: [],
    },
  ]
  const customAgents: CustomAgentSummary[] = [
    {
      name: 'data-reviewer',
      description: 'Review data quality',
      instructions: 'Review data quality',
      enabled: true,
      valid: true,
      color: 'accent',
      skillNames: [],
      toolIds: [],
      scope: 'machine',
      directory: null,
      writeAccess: false,
      issues: [],
    },
    {
      name: 'broken-agent',
      description: 'Broken',
      instructions: 'Broken',
      enabled: true,
      valid: false,
      color: 'accent',
      skillNames: [],
      toolIds: [],
      scope: 'machine',
      directory: null,
      writeAccess: false,
      issues: [{ code: 'invalid', message: 'Invalid agent' }],
    },
  ]

  const items = buildCommandPaletteItems({
    commands: [
      { name: 'deploy', description: 'Deploy release', source: 'command' },
      { name: 'hidden-tool', description: 'Should not show', source: 'tool' },
    ],
    builtinAgents,
    customAgents,
    platform: 'MacIntel',
    ...callbacks,
  })

  assert.equal(items.some((item) => item.id === 'command:deploy'), true)
  assert.equal(items.some((item) => item.id === 'command:hidden-tool'), false)
  assert.equal(items.some((item) => item.id === 'builtin-agent:research'), true)
  assert.equal(items.some((item) => item.id === 'custom-agent:data-reviewer'), true)
  assert.equal(items.some((item) => item.id === 'custom-agent:broken-agent'), false)

  const customAgent = items.find((item) => item.id === 'custom-agent:data-reviewer')
  assert.ok(customAgent)
  await customAgent.run()
  const modeItem = items.find((item) => item.id === 'mode:build')
  assert.ok(modeItem)
  await modeItem.run()
  const cleoModeItem = items.find((item) => item.id === 'mode:chief-of-staff')
  assert.ok(cleoModeItem)
  await cleoModeItem.run()

  const buildModeIndex = calls.findIndex((call) => call.type === 'mode' && call.value === 'build')
  assert.equal(calls[buildModeIndex - 1]?.type, 'clear-primary-agent')
  assert.equal(calls.some((call) => call.type === 'mode' && call.value === 'chief-of-staff'), true)
})

test('command and search actions invoke the expected callbacks', async () => {
  const { callbacks, calls } = createCallbacks()
  const items = buildCommandPaletteItems({
    commands: [{ name: 'deploy', description: 'Deploy release', source: 'command' }],
    builtinAgents: [],
    customAgents: [],
    platform: 'MacIntel',
    ...callbacks,
  })

  const commandItem = items.find((item) => item.id === 'command:deploy')
  assert.ok(commandItem)
  await commandItem.run()

  const searchItem = items.find((item) => item.id === 'create:search')
  assert.ok(searchItem)
  searchItem.run()

  assert.deepEqual(calls, [
    { type: 'ensure' },
    { type: 'command', value: 'deploy' },
    { type: 'search' },
  ])
})
