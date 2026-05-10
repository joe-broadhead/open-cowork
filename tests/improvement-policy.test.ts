import test from 'node:test'
import assert from 'node:assert/strict'
import type { AppSettings } from '../packages/shared/src/app-config.ts'
import {
  buildImprovementPolicyDiagnostics,
  isImprovementProposalEnabledForScope,
} from '../apps/desktop/src/main/improvement-policy.ts'

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    selectedProviderId: null,
    selectedModelId: null,
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission: 'deny',
    fileWritePermission: 'deny',
    enableBash: false,
    enableFileWrite: false,
    runtimeToolingBridgeEnabled: true,
    automationLaunchAtLogin: false,
    automationRunInBackground: false,
    automationDesktopNotifications: true,
    automationQuietHoursStart: null,
    automationQuietHoursEnd: null,
    defaultAutomationAutonomyPolicy: 'review-first',
    defaultAutomationExecutionMode: 'planning_only',
    operationalMaxAutonomy: 'supervised',
    operationalWriteMaxParallel: 1,
    operationalMaxRunDurationMinutes: 120,
    operationalMaxCostUsd: null,
    operationalMaxRetries: 10,
    improvementProposalsEnabled: true,
    improvementProposalsDisabledAgents: {},
    improvementProposalsDisabledProjects: {},
    improvementProposalsDisabledCrews: {},
    ...overrides,
  }
}

test('improvement proposal policy disables globally and by scope', () => {
  assert.equal(isImprovementProposalEnabledForScope(settings()), true)
  assert.equal(isImprovementProposalEnabledForScope(settings({ improvementProposalsEnabled: false })), false)
  assert.equal(isImprovementProposalEnabledForScope(settings({
    improvementProposalsDisabledAgents: { build: true },
  }), { agentName: 'build' }), false)
  assert.equal(isImprovementProposalEnabledForScope(settings({
    improvementProposalsDisabledProjects: { '/workspace/acme': true },
  }), { projectId: '/workspace/acme' }), false)
  assert.equal(isImprovementProposalEnabledForScope(settings({
    improvementProposalsDisabledCrews: { 'growth-review': true },
  }), { crewId: 'growth-review' }), false)
  assert.equal(isImprovementProposalEnabledForScope(settings({
    improvementProposalsDisabledAgents: { build: false },
  }), { agentName: 'build' }), true)
})

test('improvement proposal diagnostics expose policy shape without local identifiers', () => {
  assert.deepEqual(buildImprovementPolicyDiagnostics(settings({
    improvementProposalsEnabled: false,
    improvementProposalsDisabledAgents: { build: true, explore: true },
    improvementProposalsDisabledProjects: { '/workspace/acme': true },
    improvementProposalsDisabledCrews: { 'growth-review': true, ignored: false },
  })), {
    proposalsEnabled: false,
    disabledAgentCount: 2,
    disabledProjectCount: 1,
    disabledCrewCount: 1,
  })
})
