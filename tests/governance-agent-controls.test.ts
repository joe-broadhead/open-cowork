import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CustomAgentConfig } from '../packages/shared/src/index.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  pauseGovernanceAgent,
  retireGovernanceAgent,
} from '../apps/desktop/src/main/governance-agent-controls.ts'
import { customAgentGovernanceSubjectId } from '../apps/desktop/src/main/governance-registry.ts'
import {
  clearGovernanceAuditStoreCache,
  listGovernanceAuditEvents,
} from '../apps/desktop/src/main/governance-audit-store.ts'
import {
  listCustomAgents,
  saveCustomAgent,
} from '../apps/desktop/src/main/native-customizations.ts'
import { getMachineAgentsDir } from '../apps/desktop/src/main/runtime-paths.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-agent-controls-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function withAgentControlStore(name: string, fn: () => Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  return (async () => {
    try {
      process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
      clearConfigCaches()
      clearGovernanceAuditStoreCache()
      await fn()
    } finally {
      clearGovernanceAuditStoreCache()
      clearConfigCaches()
      if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
      else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })()
}

function customAgent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    scope: 'machine',
    directory: null,
    name: 'research-agent',
    description: 'Researches operating questions.',
    instructions: 'Use available context and produce a concise answer.',
    skillNames: [],
    toolIds: [],
    enabled: true,
    color: 'accent',
    ...overrides,
  }
}

test('pauseGovernanceAgent disables a custom agent, audits the lifecycle change, and reboots runtime', async () => withAgentControlStore('pause', async () => {
  const agent = customAgent()
  saveCustomAgent(agent, {})
  const subjectId = customAgentGovernanceSubjectId(agent)
  let permissionAgentEnabled: boolean | null = null
  let rebootCount = 0

  const result = await pauseGovernanceAgent({
    subjectId,
    reason: 'Security incident.',
  }, {
    buildCustomAgentPermission: async (updated) => {
      permissionAgentEnabled = updated.enabled
      return {}
    },
    rebootRuntime: async () => {
      rebootCount += 1
    },
  })

  assert.equal(result, true)
  assert.equal(permissionAgentEnabled, false)
  assert.equal(rebootCount, 1)
  assert.equal(listCustomAgents().find((entry) => entry.name === agent.name)?.enabled, false)

  const auditEvents = listGovernanceAuditEvents({ subjectKind: 'agent', subjectId })
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0]?.action, 'pause_agent')
  assert.equal(auditEvents[0]?.beforeLifecycle, 'active')
  assert.equal(auditEvents[0]?.afterLifecycle, 'paused')
  assert.equal(auditEvents[0]?.reason, 'Security incident.')
}))

test('retireGovernanceAgent removes a custom agent, audits retirement, and reboots runtime', async () => withAgentControlStore('retire', async () => {
  const agent = customAgent({ name: 'retire-agent', enabled: false })
  saveCustomAgent(agent, {})
  const subjectId = customAgentGovernanceSubjectId(agent)
  let rebootCount = 0

  const result = await retireGovernanceAgent({
    subjectId,
    reason: 'Owner offboarded.',
  }, {
    buildCustomAgentPermission: async () => ({}),
    rebootRuntime: async () => {
      rebootCount += 1
    },
  })

  assert.equal(result, true)
  assert.equal(rebootCount, 1)
  assert.equal(listCustomAgents().some((entry) => entry.name === agent.name), false)

  const auditEvents = listGovernanceAuditEvents({ subjectKind: 'agent', subjectId })
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0]?.action, 'retire_agent')
  assert.equal(auditEvents[0]?.beforeLifecycle, 'paused')
  assert.equal(auditEvents[0]?.afterLifecycle, 'retired')
  assert.equal(auditEvents[0]?.reason, 'Owner offboarded.')
}))

test('retireGovernanceAgent removes invalid legacy custom agent filenames surfaced in the registry', async () => withAgentControlStore('retire-invalid', async () => {
  const agentsDir = getMachineAgentsDir()
  mkdirSync(agentsDir, { recursive: true })
  const legacyAgentPath = join(agentsDir, 'Legacy Agent.md')
  writeFileSync(legacyAgentPath, `---
description: "Legacy manual file"
mode: subagent
permission: {}
---

Use available context.
`)
  const subjectId = customAgentGovernanceSubjectId({ name: 'legacy agent', scope: 'machine', directory: null })
  let rebootCount = 0

  const result = await retireGovernanceAgent({
    subjectId,
    reason: 'Remove invalid legacy agent.',
  }, {
    buildCustomAgentPermission: async () => ({}),
    rebootRuntime: async () => {
      rebootCount += 1
    },
  })

  assert.equal(result, true)
  assert.equal(rebootCount, 1)
  assert.equal(existsSync(legacyAgentPath), false)

  const auditEvents = listGovernanceAuditEvents({ subjectKind: 'agent', subjectId })
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0]?.action, 'retire_agent')
  assert.equal(auditEvents[0]?.beforeLifecycle, 'draft')
  assert.equal(auditEvents[0]?.afterLifecycle, 'retired')
}))
