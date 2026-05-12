import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GovernancePrincipal } from '../packages/shared/src/governance.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { buildRuntimeConfig } from '../apps/desktop/src/main/runtime-config-builder.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'
import { getGovernanceRegistry } from '../apps/desktop/src/main/governance-registry.ts'
import { exportGovernanceAuditEvents } from '../apps/desktop/src/main/governance-audit-export.ts'
import {
  clearGovernanceAuditStoreCache,
  listGovernanceAuditEvents,
} from '../apps/desktop/src/main/governance-audit-store.ts'
import { revokeGovernanceTool } from '../apps/desktop/src/main/governance-tool-controls.ts'
import { listRevokedToolPermissionPatterns } from '../apps/desktop/src/main/governance-tool-policy.ts'
import {
  clearGovernanceToolPolicyCache,
  listRevokedGovernanceTools,
} from '../apps/desktop/src/main/governance-tool-policy-store.ts'
import { saveCustomMcp } from '../apps/desktop/src/main/native-customizations.ts'

function uniqueUserDataDir(name: string) {
  return mkdtempSync(join(tmpdir(), `open-cowork-tool-controls-${name}-`))
}

const viewer: GovernancePrincipal = {
  kind: 'user',
  id: 'viewer',
  displayName: 'Viewer',
  roles: ['viewer'],
  groupIds: [],
}

function writeToolConfig(configDir: string) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), `{
  "providers": {
    "available": ["test-provider"],
    "defaultProvider": "test-provider",
    "defaultModel": "fast",
    "descriptors": {
      "test-provider": {
        "runtime": "builtin",
        "name": "Test Provider",
        "description": "Static test provider.",
        "credentials": [],
        "models": [{ "id": "fast", "name": "Fast" }]
      }
    }
  },
  "tools": [
    {
      "id": "warehouse",
      "name": "Warehouse",
      "icon": "database",
      "description": "Query and export warehouse data.",
      "kind": "mcp",
      "namespace": "warehouse",
      "patterns": ["mcp__warehouse__*"],
      "allowPatterns": ["mcp__warehouse__query"],
      "askPatterns": ["mcp__warehouse__export"]
    }
  ],
  "skills": [
    {
      "name": "Analyst",
      "description": "Analyze warehouse metrics.",
      "badge": "Skill",
      "sourceName": "analyst",
      "toolIds": ["warehouse"]
    }
  ],
  "agents": [
    {
      "name": "data-analyst",
      "description": "Analyze business metrics.",
      "instructions": "Use warehouse evidence.",
      "skillNames": ["analyst"],
      "toolIds": ["warehouse"],
      "mode": "subagent"
    }
  ],
  "permissions": {
    "bash": "deny",
    "fileWrite": "deny",
    "task": "allow",
    "web": "deny",
    "webSearch": false
  }
}
`)
}

function withToolControlStore(
  name: string,
  fn: (paths: { userDataDir: string, configDir: string }) => Promise<void>,
) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const userDataDir = uniqueUserDataDir(name)
  const configDir = join(userDataDir, 'config')
  return (async () => {
    try {
      process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
      process.env.OPEN_COWORK_CONFIG_DIR = configDir
      writeToolConfig(configDir)
      clearConfigCaches()
      clearGovernanceAuditStoreCache()
      clearGovernanceToolPolicyCache()
      await fn({ userDataDir, configDir })
    } finally {
      clearGovernanceToolPolicyCache()
      clearGovernanceAuditStoreCache()
      clearConfigCaches()
      closeLogger()
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
      else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
      if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
      else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })()
}

test('revokeGovernanceTool records audit evidence and denies the tool in runtime permissions', async () => withToolControlStore('revoke-configured', async () => {
  const beforeConfig = buildRuntimeConfig() as Record<string, any>
  assert.equal(beforeConfig.permission['mcp__warehouse__query'], 'allow')
  assert.equal(beforeConfig.permission['mcp__warehouse__export'], 'ask')
  assert.equal(beforeConfig.agent.build.permission['mcp__warehouse__query'], 'allow')

  let rebootCount = 0
  const revoked = await revokeGovernanceTool({
    toolId: 'warehouse',
    reason: 'Compromised integration token.',
  }, {
    rebootRuntime: async () => {
      rebootCount += 1
    },
  })

  assert.equal(rebootCount, 1)
  assert.equal(revoked.toolId, 'warehouse')
  assert.equal(revoked.reason, 'Compromised integration token.')
  assert.deepEqual(listRevokedGovernanceTools().map((tool) => tool.toolId), ['warehouse'])
  assert.deepEqual(listRevokedToolPermissionPatterns(), [
    'mcp__warehouse__*',
    'mcp__warehouse__export',
    'mcp__warehouse__query',
    'warehouse_*',
    'warehouse_export',
    'warehouse_query',
  ])

  const afterConfig = buildRuntimeConfig() as Record<string, any>
  assert.equal(afterConfig.permission['mcp__warehouse__*'], 'deny')
  assert.equal(afterConfig.permission['warehouse_*'], 'deny')
  assert.equal(afterConfig.permission['mcp__warehouse__query'], 'deny')
  assert.equal(afterConfig.permission['mcp__warehouse__export'], 'deny')
  assert.equal(afterConfig.agent.build.permission['mcp__warehouse__query'], 'deny')
  assert.equal(afterConfig.agent['data-analyst'].permission['mcp__warehouse__query'], 'deny')

  const registry = await getGovernanceRegistry()
  const dependencyIndex = registry.dependencyIndex.find((entry) => entry.dependency.kind === 'tool' && entry.dependency.id === 'warehouse')
  assert.equal(dependencyIndex?.dependency.lifecycle, 'revoked')
  assert.equal(dependencyIndex?.subjectIds.some((subjectId) => subjectId.includes('data-analyst')), true)

  const subjectId = 'tool:warehouse'
  const auditEvents = listGovernanceAuditEvents({ subjectKind: 'tool', subjectId })
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0]?.action, 'revoke_tool')
  assert.equal(auditEvents[0]?.beforeLifecycle, 'active')
  assert.equal(auditEvents[0]?.afterLifecycle, 'revoked')
  assert.equal((auditEvents[0]?.metadata as Record<string, unknown>)?.toolId, 'warehouse')

  const exported = exportGovernanceAuditEvents({ subjectKind: 'tool', subjectId })
  const rows = exported.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.recordType, 'governance_incident')
  assert.equal((rows[0]?.payload as Record<string, unknown>)?.action, 'revoke_tool')
}))

test('revokeGovernanceTool resolves project custom MCPs through a granted context', async () => withToolControlStore('revoke-project-mcp', async ({ userDataDir }) => {
  const projectDir = join(userDataDir, 'project')
  const otherProjectDir = join(userDataDir, 'other-project')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(otherProjectDir, { recursive: true })
  saveCustomMcp({
    scope: 'project',
    directory: projectDir,
    name: 'analytics',
    label: 'Analytics MCP',
    description: 'Project-scoped analytical tools.',
    type: 'http',
    url: 'https://analytics.example.test/mcp',
    permissionMode: 'allow',
  })
  saveCustomMcp({
    scope: 'project',
    directory: otherProjectDir,
    name: 'analytics',
    label: 'Other Analytics MCP',
    description: 'Another project with the same MCP namespace.',
    type: 'http',
    url: 'https://other-analytics.example.test/mcp',
    permissionMode: 'allow',
  })

  let rebootCount = 0
  const revoked = await revokeGovernanceTool({
    toolId: 'analytics',
    context: { directory: projectDir },
  }, {
    rebootRuntime: async () => {
      rebootCount += 1
    },
  })

  assert.equal(rebootCount, 1)
  assert.equal(revoked.label, 'Analytics MCP')
  assert.equal(revoked.scope, 'project')
  assert.equal(revoked.directory, projectDir)
  assert.deepEqual(revoked.patterns, ['mcp__analytics__*', 'analytics_*'])
  assert.deepEqual(listRevokedToolPermissionPatterns(), [])
  assert.deepEqual(listRevokedToolPermissionPatterns({ directory: projectDir }), ['analytics_*', 'mcp__analytics__*'])
  assert.deepEqual(listRevokedToolPermissionPatterns({ directory: otherProjectDir }), [])

  const registry = await getGovernanceRegistry({ directory: projectDir })
  assert.equal(
    registry.dependencyIndex.some((entry) => entry.dependency.kind === 'tool' && entry.dependency.id === 'analytics'),
    false,
    'revoking a project MCP should not invent agent dependencies until an agent references it',
  )
}))

test('revokeGovernanceTool records denied audit before mutating for unauthorized actors', async () => withToolControlStore('revoke-denied', async () => {
  let rebootCount = 0

  await assert.rejects(
    () => revokeGovernanceTool({
      toolId: 'warehouse',
      reason: 'Unauthorized revoke.',
    }, {
      actor: viewer,
      rebootRuntime: async () => {
        rebootCount += 1
      },
    }),
    /not authorized to revoke tool/,
  )

  assert.equal(rebootCount, 0)
  assert.deepEqual(listRevokedGovernanceTools(), [])
  assert.deepEqual(listRevokedToolPermissionPatterns(), [])

  const auditEvents = listGovernanceAuditEvents({ subjectKind: 'tool', subjectId: 'tool:warehouse' })
  assert.equal(auditEvents.length, 1)
  assert.equal(auditEvents[0]?.outcome, 'failed')
  assert.equal(auditEvents[0]?.beforeLifecycle, 'active')
  assert.equal(auditEvents[0]?.afterLifecycle, null)
  assert.equal((auditEvents[0]?.metadata.policyDecision as Record<string, unknown>)?.outcome, 'denied')
}))

test('revokeGovernanceTool refuses unknown tools without auditing or rebooting', async () => withToolControlStore('revoke-missing', async () => {
  let rebootCount = 0
  await assert.rejects(
    () => revokeGovernanceTool({
      toolId: 'missing-tool',
      reason: 'No such tool.',
    }, {
      rebootRuntime: async () => {
        rebootCount += 1
      },
    }),
    /No tool found for governance incident missing-tool/,
  )

  assert.equal(rebootCount, 0)
  assert.deepEqual(listRevokedGovernanceTools(), [])
  assert.deepEqual(listGovernanceAuditEvents(), [])
}))
