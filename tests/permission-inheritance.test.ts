import test from 'node:test'
import assert from 'node:assert/strict'

import { buildOpenCoworkAgentConfig } from '../apps/desktop/src/main/agent-config.ts'
import {
  buildAgentPermissionMatrix,
  findPermissionInheritanceIssues,
  remoteApprovalFixtureMatrix,
} from '../apps/desktop/src/main/permission-inheritance.ts'

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
  const explore = matrix.find((entry) => entry.agentName === 'explore')

  assert.ok(plan)
  assert.ok(explore)
  assert.equal(plan.taskTargets.general, undefined)
  assert.equal(plan.taskTargets.autoresearch, undefined)
  assert.equal(plan.taskTargets.explore, 'allow')
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

test('remote approval fixture matrix names explicit authority policies', () => {
  assert.deepEqual(remoteApprovalFixtureMatrix().map((entry) => entry.permissionApproval), [
    'local-confirmation',
    'paired-local-confirmation',
    'cloud-rbac',
    'gateway-actor-rbac',
  ])
})
