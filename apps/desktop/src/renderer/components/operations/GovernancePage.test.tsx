import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  CapabilityRiskMetadata,
  GovernanceAuditEvent,
  GovernanceRegistryPayload,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { GovernancePage } from './GovernancePage'

const registry: GovernanceRegistryPayload = {
  schemaVersion: 1,
  generatedAt: '2026-05-13T09:00:00.000Z',
  organization: {
    schemaVersion: 1,
    id: 'local',
    tenantId: 'local',
    displayName: 'Local Governance',
    mode: 'local',
  },
  principals: [],
  groups: [],
  secretVaults: [],
  executionNodes: [],
  subjects: [{
    schemaVersion: 1,
    subjectKind: 'crew',
    subjectId: 'crew:field',
    name: 'field',
    displayName: 'Field Crew',
    description: 'Runs field operations.',
    owner: { kind: 'user', id: 'local-user', displayName: 'Local user' },
    approvers: [],
    lifecycle: 'active',
    scope: { kind: 'machine', id: 'machine', label: 'Machine' },
    memoryBoundary: { kind: 'none', id: null, label: 'No memory' },
    evalSuiteId: null,
    offboardingPath: 'Retire crew.',
    credentialBindings: [],
    dependencies: [],
    incidentControls: [{
      kind: 'retire_crew',
      label: 'Retire crew',
      available: true,
      requiresConfirmation: true,
    }],
  }],
  dependencyIndex: [{
    dependency: {
      kind: 'tool',
      id: 'browser',
      label: 'Browser',
      source: 'direct',
      required: true,
    },
    subjectIds: ['crew:field'],
  }],
}

const auditEvents: GovernanceAuditEvent[] = [{
  schemaVersion: 1,
  id: 'audit-1',
  kind: 'incident_control',
  subjectKind: 'crew',
  subjectId: 'crew:field',
  action: 'retire_crew',
  outcome: 'succeeded',
  actor: { kind: 'user', id: 'local-user', displayName: 'Local user' },
  reason: 'Routine cleanup.',
  beforeLifecycle: 'active',
  afterLifecycle: 'retired',
  metadata: {},
  createdAt: '2026-05-13T09:00:00.000Z',
}]

const risks: CapabilityRiskMetadata[] = [{
  schemaVersion: 1,
  capabilityId: 'tool:browser',
  toolPattern: 'mcp__browser__*',
  risk: 'high',
  writeCapable: true,
  approvalRequired: true,
  reason: 'Browser can reach external systems.',
}]

describe('GovernancePage', () => {
  it('shows permission policy, guardrails, dependency map, and recent audit incidents', async () => {
    installRendererTestCoworkApi({
      capabilities: {
        skills: vi.fn(async () => []),
        tools: vi.fn(async () => []),
      },
      model: {
        info: vi.fn(async () => null),
      },
      operations: {
        governanceRegistry: vi.fn(async () => registry),
        governanceAuditEvents: vi.fn(async () => auditEvents),
        capabilityRisks: vi.fn(async () => risks),
      },
      settings: {
        get: vi.fn(async () => ({
          selectedProviderId: null,
          selectedModelId: null,
          providerCredentials: {},
          integrationCredentials: {},
          integrationEnabled: {},
          bashPermission: 'ask',
          fileWritePermission: 'deny',
          enableBash: true,
          enableFileWrite: false,
          runtimeToolingBridgeEnabled: false,
          automationLaunchAtLogin: false,
          automationRunInBackground: false,
          automationDesktopNotifications: true,
          automationQuietHoursStart: null,
          automationQuietHoursEnd: null,
          defaultAutomationAutonomyPolicy: 'review-first',
          defaultAutomationExecutionMode: 'scoped_execution',
          operationalMaxAutonomy: 'approve',
          operationalWriteMaxParallel: 2,
          operationalMaxRunDurationMinutes: 90,
          operationalMaxCostUsd: 12,
          operationalMaxRetries: 4,
          improvementProposalsEnabled: true,
          improvementProposalsDisabledAgents: {},
          improvementProposalsDisabledProjects: {},
          improvementProposalsDisabledCrews: {},
          dreamConsolidationScheduleEnabled: false,
          dreamConsolidationIntervalHours: 168,
          effectiveProviderId: null,
          effectiveModel: null,
        })),
      },
    })

    render(<GovernancePage onOpenSettings={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Governance' })).toBeInTheDocument()
    expect(await screen.findByText('Local Governance')).toBeInTheDocument()
    expect(screen.getByText('Browser')).toBeInTheDocument()
    expect(screen.getByText(/Ask \/ max Allow/)).toBeInTheDocument()
    expect(screen.getByText(/Deny \/ max Allow/)).toBeInTheDocument()
    expect(screen.getByText(/retire crew/)).toBeInTheDocument()
    expect(screen.getByText('Routine cleanup.')).toBeInTheDocument()
  })
})
