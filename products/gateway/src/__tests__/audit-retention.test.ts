import { describe, expect, it } from 'vitest'
import {
  AUDIT_CURRENT_SURFACES,
  AUDIT_EVENT_CLASSES,
  AUDIT_REQUIRED_SHAPE_FIELDS,
  AUDIT_RETENTION_POLICIES,
  buildAuditRetentionReport,
  validateAuditEventShape,
} from '../audit-retention.js'

describe('audit retention model', () => {
  it('defines compliance-oriented audit taxonomy, retention, and current surface mapping', () => {
    const report = buildAuditRetentionReport()

    expect(report).toMatchObject({
      mode: 'local_beta_redacted_evidence',
      releaseStatus: 'supported_public_local_beta',
      complianceLedgerStatus: 'local_append_only_foundation_not_certified',
      hostedStatus: 'unsupported',
      localEvidenceStatus: 'redacted_evidence_and_incident_bundles_supported',
      rawTranscriptPolicy: 'never_in_compliance_audit_or_shareable_evidence',
    })
    expect(AUDIT_EVENT_CLASSES.map(row => row.class)).toEqual(expect.arrayContaining([
      'user_action',
      'agent_action',
      'channel_event',
      'mcp_tool',
      'scheduler_transition',
      'storage_admin',
      'config_admin',
      'security_decision',
      'human_gate_decision',
      'evidence_export',
      'incident_response',
      'extension_change',
      'secret_reference',
    ]))
    expect(AUDIT_RETENTION_POLICIES.map(row => row.class)).toEqual(expect.arrayContaining([
      'local_beta_work_history',
      'security_audit',
      'incident_evidence',
      'team_compliance_ledger',
      'secret_metadata',
    ]))
    expect(AUDIT_CURRENT_SURFACES).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: 'workflow_events', supportedNow: true }),
      expect.objectContaining({ surface: 'security_audit_events', supportedNow: true }),
      expect.objectContaining({ surface: 'append_only_audit_ledger', supportedNow: true }),
      expect.objectContaining({ surface: 'extension_package_governance', supportedNow: false }),
    ]))
    expect(report.ledger).toMatchObject({
      schemaVersion: 1,
      storage: 'gateway.db:audit_ledger',
      appendOnly: true,
      hashChained: true,
      certification: 'not_certified_compliance_storage',
    })
    expect(report.totals.requiredShapeFields).toBe(AUDIT_REQUIRED_SHAPE_FIELDS.length)
  })

  it('keeps shareable evidence redaction boundaries explicit', () => {
    const report = buildAuditRetentionReport()

    expect(report.incidentEvidence.redactionRules).toEqual(expect.arrayContaining([
      'provider targets hashed/redacted',
      'session IDs redacted or hashed',
      'configured secrets and token-like strings redacted',
      'private transcript/message bodies omitted or redacted',
    ]))
    expect(report.incidentEvidence.forbiddenContents).toEqual(expect.arrayContaining([
      'bearer tokens',
      'model/provider API keys',
      'MCP credentials',
      'private transcript text',
    ]))
    expect(JSON.stringify(report)).not.toContain('8836435728:')
  })

  it('validates normalized audit event shapes for future replay and export tests', () => {
    const valid = validateAuditEventShape({
      eventId: 'evt_1',
      class: 'security_decision',
      actor: { kind: 'gateway_system', idRef: 'actor:gateway' },
      resource: { kind: 'channel_binding', idRef: 'channel:hash' },
      action: 'channel.inbound.deny',
      result: 'denied',
      occurredAt: '2026-06-21T12:00:00.000Z',
      traceId: 'trace_security_123',
      retentionClass: 'security_audit',
      redacted: true,
      evidenceRefs: ['event:1'],
    })

    expect(valid).toEqual([])

    const invalid = validateAuditEventShape({
      eventId: 'evt_2',
      class: 'secret_reference',
      actor: { kind: 'channel_identity', idRef: '' },
      resource: { kind: 'channel_message', idRef: 'message:raw' },
      action: '',
      result: 'ok',
      occurredAt: 'not-a-date',
      traceId: '',
      retentionClass: 'local_beta_work_history',
      redacted: false,
    })

    expect(invalid.map(row => row.code)).toEqual(expect.arrayContaining([
      'invalid_actor_kind',
      'missing_required_field',
      'invalid_resource_kind',
      'invalid_retention_class',
      'invalid_timestamp',
      'redaction_required',
    ]))
  })
})
