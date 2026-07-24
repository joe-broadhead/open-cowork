import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCommandPaletteItems } from '../packages/app/src/components/command-palette-items.ts'

function collectNavIds(features: Parameters<typeof buildCommandPaletteItems>[0]['features']) {
  const items = buildCommandPaletteItems({
    commands: [],
    builtinAgents: [],
    customAgents: [],
    features,
    onNavigate: () => undefined,
    onCreateThread: async () => null,
    onEnsureSession: async () => true,
    onInsertComposer: () => undefined,
    onClearSessionPrimaryAgent: () => true,
    onSetAgentMode: () => undefined,
    onStartAgentChat: () => undefined,
    onSelectDirectory: async () => null,
    onOpenSettings: () => undefined,
    onToggleSearch: () => undefined,
    onRunCommand: async () => true,
  })
  return items.filter((item) => item.id.startsWith('nav:')).map((item) => item.id).sort()
}

test('command palette omits secondary Studio nav when features default (omitted)', () => {
  const ids = collectNavIds(undefined)
  assert.ok(ids.includes('nav:home'))
  assert.ok(ids.includes('nav:projects'))
  assert.ok(ids.includes('nav:team'))
  assert.ok(ids.includes('nav:playbooks'))
  assert.ok(ids.includes('nav:tools'))
  assert.ok(!ids.includes('nav:knowledge'))
  assert.ok(!ids.includes('nav:approvals'))
  assert.ok(!ids.includes('nav:channels'))
  assert.ok(!ids.includes('nav:artifacts'))
})

test('command palette includes secondary nav only when features explicitly true', () => {
  const ids = collectNavIds({
    knowledge: true,
    approvals: true,
    channels: true,
    artifacts: true,
  })
  assert.ok(ids.includes('nav:knowledge'))
  assert.ok(ids.includes('nav:approvals'))
  assert.ok(ids.includes('nav:channels'))
  assert.ok(ids.includes('nav:artifacts'))
})
