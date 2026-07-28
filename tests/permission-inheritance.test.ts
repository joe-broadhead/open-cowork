import { buildOpenCoworkAgentConfig } from '@open-cowork/runtime-host/agent-config'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAgentPermissionMatrix,
  createPermissionInheritanceReporter,
  findPermissionInheritanceIssues,
  remoteApprovalFixtureMatrix,
  validatePermissionInheritance,
} from '@open-cowork/runtime-host/permission-inheritance'
import { createDownstreamCatalogFixture } from '../scripts/perf/downstream-catalog-fixture.ts'

test('generated built-in agent config keeps read-only delegated agents within parent sensitive permissions', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: ['mcp__github__*', 'mcp__skills__*'],
    allowToolPatterns: ['websearch', 'webfetch', 'bash', 'edit', 'write', 'apply_patch'],
    bash: 'allow',
    fileWrite: 'allow',
    task: 'allow',
    web: 'allow',
    webSearch: 'allow',
  })

  const matrix = buildAgentPermissionMatrix(agents)
  const plan = matrix.find((entry) => entry.agentName === 'plan')
  const chiefOfStaff = matrix.find((entry) => entry.agentName === 'chief-of-staff')
  const explore = matrix.find((entry) => entry.agentName === 'explore')

  assert.ok(plan)
  assert.ok(chiefOfStaff)
  assert.ok(explore)
  assert.equal(plan.taskTargets.general, undefined)
  assert.equal(plan.taskTargets.autoresearch, undefined)
  assert.equal(plan.taskTargets.explore, 'allow')
  assert.equal(chiefOfStaff.taskTargets.general, undefined)
  assert.equal(chiefOfStaff.taskTargets.explore, 'allow')
  assert.equal(explore.sensitive.bash, 'deny')
  assert.equal(explore.sensitive.write, 'deny')
  assert.deepEqual(findPermissionInheritanceIssues(agents), [])
})

test('permission inheritance analyzer catches write-capable child regressions', () => {
  const issues = findPermissionInheritanceIssues({
    parent: {
      mode: 'primary',
      permission: {
        task: { child: 'allow' },
        bash: 'deny',
        edit: 'deny',
        write: 'deny',
        apply_patch: 'deny',
      },
    },
    child: {
      mode: 'subagent',
      permission: {
        task: 'deny',
        bash: 'allow',
        edit: 'deny',
        write: 'deny',
        apply_patch: 'deny',
      },
    },
  })

  assert.deepEqual(issues.map((issue) => [issue.parentAgent, issue.childAgent, issue.key, issue.reasonCode]), [
    ['parent', 'child', 'bash', 'child-more-permissive-than-parent'],
  ])
})

test('permission inheritance analyzer catches ask-to-allow child escalation', () => {
  const issues = findPermissionInheritanceIssues({
    parent: {
      mode: 'primary',
      permission: {
        task: { child: 'allow' },
        bash: 'ask',
      },
    },
    child: {
      mode: 'subagent',
      permission: {
        bash: 'allow',
      },
    },
  })

  assert.deepEqual(issues.map((issue) => [issue.parentAgent, issue.childAgent, issue.key, issue.parentAction, issue.childAction]), [
    ['parent', 'child', 'bash', 'ask', 'allow'],
  ])
})

test('permission inheritance expands scalar task access across eligible subagents deterministically', () => {
  const agents = {
    'z-child': {
      mode: 'subagent',
      permission: { bash: 'ask' },
    },
    parent: {
      mode: 'primary',
      permission: {
        task: 'ask',
        bash: 'deny',
      },
    },
    peer: {
      mode: 'primary',
      permission: { bash: 'allow' },
    },
    'a-child': {
      mode: 'subagent',
      permission: { bash: 'allow' },
    },
  }

  const parent = buildAgentPermissionMatrix(agents)
    .find((entry) => entry.agentName === 'parent')
  assert.deepEqual(parent?.taskTargets, {
    'a-child': 'ask',
    'z-child': 'ask',
  })
  assert.deepEqual(
    findPermissionInheritanceIssues(agents)
      .map(({ parentAgent, childAgent, key, parentAction, childAction }) => ({
        parentAgent,
        childAgent,
        key,
        parentAction,
        childAction,
      })),
    [
      {
        parentAgent: 'parent',
        childAgent: 'a-child',
        key: 'bash',
        parentAction: 'deny',
        childAction: 'allow',
      },
      {
        parentAgent: 'parent',
        childAgent: 'z-child',
        key: 'bash',
        parentAction: 'deny',
        childAction: 'ask',
      },
    ],
  )
})

test('permission inheritance expands wildcard task access but respects named deny overrides', () => {
  const agents = {
    parent: {
      mode: 'primary',
      permission: {
        task: {
          '*': 'allow',
          blocked: 'deny',
        },
        write: 'deny',
      },
    },
    blocked: {
      mode: 'subagent',
      permission: { write: 'allow' },
    },
    allowed: {
      mode: 'subagent',
      permission: { write: 'allow' },
    },
    primary: {
      mode: 'primary',
      permission: { write: 'allow' },
    },
  }

  const parent = buildAgentPermissionMatrix(agents)
    .find((entry) => entry.agentName === 'parent')
  assert.deepEqual(parent?.taskTargets, {
    allowed: 'allow',
    blocked: 'deny',
  })
  assert.deepEqual(
    findPermissionInheritanceIssues(agents)
      .map(({ parentAgent, childAgent, key }) => ({ parentAgent, childAgent, key })),
    [
      {
        parentAgent: 'parent',
        childAgent: 'allowed',
        key: 'write',
      },
    ],
  )
})

test('permission inheritance validation returns deterministic issue codes, paths, and revisions', () => {
  const parent = {
    mode: 'primary',
    permission: {
      task: {
        missing: 'allow',
        child: 'allow',
      },
      bash: 'deny',
      edit: 'deny',
    },
  }
  const child = {
    mode: 'subagent',
    permission: {
      bash: 'allow',
      edit: 'ask',
    },
  }

  const validation = validatePermissionInheritance({ parent, child })
  const reordered = validatePermissionInheritance({ child, parent })

  assert.equal(validation.revision, reordered.revision)
  assert.deepEqual(validation.issues, reordered.issues)
  assert.deepEqual(
    validation.issues.map(({ code, path, parentAgent, childAgent, key }) => ({
      code,
      path,
      parentAgent,
      childAgent,
      key,
    })),
    [
      {
        code: 'permission-inheritance/child-more-permissive-than-parent',
        path: 'agents["child"].permission["bash"]',
        parentAgent: 'parent',
        childAgent: 'child',
        key: 'bash',
      },
      {
        code: 'permission-inheritance/child-more-permissive-than-parent',
        path: 'agents["child"].permission["edit"]',
        parentAgent: 'parent',
        childAgent: 'child',
        key: 'edit',
      },
      {
        code: 'permission-inheritance/delegated-agent-missing',
        path: 'agents["parent"].permission.task["missing"]',
        parentAgent: 'parent',
        childAgent: 'missing',
        key: 'task',
      },
    ],
  )
})

test('permission inheritance reporter emits one structured diagnostic per configuration revision', () => {
  const reports: Array<{
    revision: string
    summary: string
    issues: readonly { code: string; path: string }[]
  }> = []
  const reporter = createPermissionInheritanceReporter((report) => reports.push(report))
  const unsafe = validatePermissionInheritance({
    parent: {
      mode: 'primary',
      permission: {
        task: { child: 'allow' },
        bash: 'deny',
      },
    },
    child: {
      mode: 'subagent',
      permission: { bash: 'allow' },
    },
  })

  assert.equal(reporter.report(unsafe), true)
  assert.equal(reporter.report(unsafe), false)
  assert.equal(reports.length, 1)
  assert.match(reports[0]!.summary, /Delegated permission inheritance issues \(1\)/)
  assert.equal(reports[0]!.issues[0]?.code, 'permission-inheritance/child-more-permissive-than-parent')
  assert.equal(reports[0]!.issues[0]?.path, 'agents["child"].permission["bash"]')

  const cleanRevision = validatePermissionInheritance({
    parent: {
      mode: 'primary',
      permission: {
        task: { child: 'allow' },
        bash: 'allow',
      },
    },
    child: {
      mode: 'subagent',
      permission: { bash: 'allow' },
    },
  })
  assert.equal(reporter.report(cleanRevision), false)
  assert.equal(reporter.report(unsafe), false)
  assert.equal(reports.length, 1)
})

test('agent config calculation does not report permission diagnostics as a side effect', (context) => {
  const calls: unknown[][] = []
  context.mock.method(console, 'log', (...args) => {
    calls.push(args)
  })
  const fixture = createDownstreamCatalogFixture()

  buildOpenCoworkAgentConfig({
    allToolPatterns: fixture.allToolPatterns,
    allowToolPatterns: fixture.allowPatterns,
    askToolPatterns: fixture.askPatterns,
    managedSkillNames: fixture.skillNames,
    availableSkillNames: fixture.skillNames,
    bash: 'ask',
    fileWrite: 'ask',
    task: 'allow',
    web: 'allow',
    webSearch: 'allow',
    projectDirectory: '/tmp/open-cowork-downstream-project',
    customDelegationAgents: fixture.customAgents,
  })

  assert.equal(calls.length, 0)
})

test('permission inheritance matrix reads external directory object rules', () => {
  const matrix = buildAgentPermissionMatrix({
    scoped: {
      permission: {
        external_directory: {
          '*': 'deny',
          '/tmp/shared/*': 'ask',
        },
      },
    },
  })

  assert.equal(matrix[0]?.sensitive.external_directory, 'ask')
})

test('remote approval fixture matrix names explicit authority policies', () => {
  assert.deepEqual(remoteApprovalFixtureMatrix().map((entry) => entry.permissionApproval), [
    'local-confirmation',
    'paired-local-confirmation',
    'cloud-rbac',
    'gateway-actor-rbac',
  ])
})
