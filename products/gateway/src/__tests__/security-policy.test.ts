import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { clearConfigCacheForTest, getConfig } from '../config.js'
import { evaluateHttpRequestSecurity } from '../security.js'
import {
  decideChannelCommandSecurityPolicy,
  decideMcpRequestSecurityPolicy,
  decideSecurityPolicy,
  summarizeSecurityPolicyDecision,
} from '../security-policy.js'

describe('central security policy', () => {
  beforeEach(() => {
    clearConfigCacheForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
    clearConfigCacheForTest()
  })

  it('routes high-risk HTTP denials through reason-coded policy evidence', () => {
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-secret-token'
    const exposed = { ...getConfig().security, httpHost: '0.0.0.0', allowNonLocalHttp: true }

    const decision = evaluateHttpRequestSecurity({
      host: 'gateway.example.com',
      origin: 'https://gateway.example.com',
      remoteAddress: '203.0.113.10',
      method: 'GET',
      pathname: '/storage/export',
      authorization: 'Bearer operator-secret-token',
    }, exposed)

    expect(decision).toMatchObject({
      allowed: false,
      actor: 'rejected',
      requiredCapability: 'admin',
      grantedCapabilities: ['operator'],
      reasonCode: 'http_token_capability_denied',
      policyDecision: 'deny',
      evidence: {
        event: 'security.policy.decision',
        surface: 'http',
        actorType: 'http_token',
        decision: 'deny',
        reasonCode: 'http_token_capability_denied',
        redacted: true,
      },
    })
    expect(JSON.stringify(decision)).not.toContain('operator-secret-token')
  })

  it('denies untrusted channel actions without leaking raw provider identifiers', () => {
    const decision = decideSecurityPolicy({
      principal: { actorType: 'channel_actor', trustTier: 'untrusted', ref: 'telegram:private-chat-id:private-thread-id' },
      surface: 'channel_command',
      action: '/task cancel',
      capability: 'task_mutate',
      resource: { kind: 'task', id: 'task_private', projectId: 'project_1' },
      channelBinding: { trusted: false, projectId: 'project_1' },
    })

    expect(decision).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'untrusted_channel_action',
      evidence: { actorType: 'channel_actor', redacted: true },
    })
    expect(decision.evidence.actorRef).toMatch(/^[a-f0-9]{32}$/)
    expect(decision.evidence.resourceRef).toMatch(/^[a-f0-9]{32}$/)
    expect(JSON.stringify(decision)).not.toContain('private-chat-id')
    expect(JSON.stringify(decision)).not.toContain('task_private')
  })

  it('denies unsafe package and tool grants before activation', () => {
    const decision = decideSecurityPolicy({
      principal: { actorType: 'extension_manifest', trustTier: 'untrusted', ref: 'package:third-party-danger' },
      surface: 'extension_package',
      action: 'install',
      capability: 'asset_write',
      resource: { kind: 'extension_package', id: 'package_third_party_danger' },
      requestedGrants: ['tools:*', 'secretRefs:raw-provider-token-value'],
    })

    expect(decision).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'unsafe_package_grant',
      evidence: { surface: 'extension_package', capability: 'asset_write', redacted: true },
    })
    expect(JSON.stringify(decision)).not.toContain('raw-provider-token-value')
  })

  it('denies secret-reference access outside approved local/operator policy', () => {
    const decision = decideSecurityPolicy({
      principal: { actorType: 'agent', trustTier: 'untrusted', ref: 'agent:untrusted-helper' },
      surface: 'secret_reference',
      action: 'inject',
      capability: 'secret_reference',
      resource: { kind: 'secret_reference', id: 'secretref_model_key', projectId: 'project_1' },
      evidenceRequirement: 'value-free-secret-ref-only',
    })

    expect(decision).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'secret_access_denied',
      evidence: {
        surface: 'secret_reference',
        evidenceRequirement: 'value-free-secret-ref-only',
        redacted: true,
      },
    })
    expect(JSON.stringify(decision)).not.toContain('model_key')
  })

  it('denies cross-scope resource access with redacted evidence', () => {
    const decision = decideSecurityPolicy({
      principal: { actorType: 'worker', trustTier: 'operator_approved', ref: 'worker:private-worker-host' },
      surface: 'worker_action',
      action: 'run_task',
      capability: 'task_mutate',
      scope: { organizationId: 'org_1', workspaceId: 'workspace_1', projectId: 'project_1' },
      resource: { kind: 'task', id: 'task_other_project', organizationId: 'org_2', workspaceId: 'workspace_2', projectId: 'project_2' },
    })

    expect(decision).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'cross_scope_resource',
      evidence: { actorType: 'worker', surface: 'worker_action', redacted: true },
    })
    expect(JSON.stringify(decision)).not.toContain('org_2')
    expect(JSON.stringify(decision)).not.toContain('task_other_project')
  })

  it('represents allow, preview-only, requires-human, and degraded decisions explicitly', () => {
    const base = {
      principal: { actorType: 'local' as const, trustTier: 'local_trusted' as const, ref: 'local-machine' },
      surface: 'mcp' as const,
      action: 'task.update',
      capability: 'task_mutate' as const,
      resource: { kind: 'task' as const, id: 'task_1', projectId: 'project_1' },
    }

    expect(decideSecurityPolicy(base)).toMatchObject({ allowed: true, decision: 'allow', reasonCode: 'policy_allowed' })
    expect(decideSecurityPolicy({ ...base, previewOnly: true })).toMatchObject({ allowed: false, decision: 'preview_only', reasonCode: 'preview_only_policy' })
    expect(decideSecurityPolicy({ ...base, requiresHuman: true })).toMatchObject({ allowed: false, decision: 'requires_human', reasonCode: 'requires_human_approval' })
    expect(decideSecurityPolicy({ ...base, staleOrReplay: true })).toMatchObject({ allowed: false, decision: 'deny', reasonCode: 'stale_or_replayed_action' })
    expect(decideSecurityPolicy({ ...base, actorMismatch: true })).toMatchObject({ allowed: false, decision: 'deny', reasonCode: 'actor_mismatch' })
    expect(decideSecurityPolicy({ ...base, degraded: true })).toMatchObject({ allowed: false, decision: 'degraded', reasonCode: 'degraded_policy_source' })
  })

  it('denies privileged MCP mutations from untrusted clients with redacted evidence', () => {
    const decision = decideMcpRequestSecurityPolicy({
      method: 'DELETE',
      path: '/tasks/task_private_123',
      trustTier: 'untrusted',
      principalRef: 'mcp:remote-preview-client',
    })

    expect(decision).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'mcp_tool_capability_denied',
      evidence: { surface: 'mcp', actorType: 'mcp_client', capability: 'task_mutate', redacted: true },
    })
    expect(JSON.stringify(decision)).not.toContain('task_private_123')
    expect(JSON.stringify(decision)).not.toContain('remote-preview-client')
  })

  it('allows local trusted MCP compatibility while still classifying the policy surface', () => {
    const decision = decideMcpRequestSecurityPolicy({
      method: 'POST',
      path: '/tasks',
      body: { title: 'Local operator task' },
      trustTier: 'local_trusted',
      principalRef: 'local-mcp',
    })

    expect(decision).toMatchObject({
      allowed: true,
      decision: 'allow',
      reasonCode: 'policy_allowed',
      evidence: { surface: 'mcp', capability: 'task_mutate', trustTier: 'local_trusted', redacted: true },
    })
  })

  it('denies privileged channel command mutations through the channel policy wrapper', () => {
    const decision = decideChannelCommandSecurityPolicy({
      command: 'task.cancel',
      provider: 'telegram',
      actorRef: 'telegram:private-user-id',
      targetRef: 'telegram:private-chat-id',
      trusted: false,
    })

    const summary = summarizeSecurityPolicyDecision(decision)
    expect(decision).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'untrusted_channel_action',
      evidence: { surface: 'channel_command', actorType: 'channel_actor', redacted: true },
    })
    expect(summary).toMatchObject({ event: 'security.policy.decision', reasonCode: 'untrusted_channel_action', redacted: true })
    expect(JSON.stringify(decision)).not.toContain('private-user-id')
    expect(JSON.stringify(decision)).not.toContain('private-chat-id')
  })

  it('denies stale/replayed and wrong-actor channel actions through the policy wrapper', () => {
    const stale = decideChannelCommandSecurityPolicy({
      command: 'gate.approve',
      provider: 'telegram',
      actorRef: 'telegram:private-replay-user',
      targetRef: 'telegram:private-replay-target',
      trusted: true,
      staleOrReplay: true,
    })
    const wrongActor = decideChannelCommandSecurityPolicy({
      command: 'permission.approve',
      provider: 'telegram',
      actorRef: 'telegram:private-wrong-user',
      targetRef: 'telegram:private-trusted-chat',
      trusted: true,
      actorMismatch: true,
    })

    expect(stale).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'stale_or_replayed_action',
      evidence: { surface: 'channel_command', redacted: true },
    })
    expect(wrongActor).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'actor_mismatch',
      evidence: { surface: 'channel_command', redacted: true },
    })
    expect(JSON.stringify([stale, wrongActor])).not.toContain('private-replay-user')
    expect(JSON.stringify([stale, wrongActor])).not.toContain('private-trusted-chat')
  })

  it('denies untrusted worker actions before environment control', () => {
    const decision = decideMcpRequestSecurityPolicy({
      method: 'POST',
      path: '/environments/env_private/action',
      body: { action: 'abort' },
      trustTier: 'untrusted',
      principalRef: 'worker:outside-lease',
    })

    expect(decision).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'worker_action_denied',
      evidence: { surface: 'worker_action', capability: 'remote_execute', redacted: true },
    })
    expect(JSON.stringify(decision)).not.toContain('env_private')
    expect(JSON.stringify(decision)).not.toContain('outside-lease')
  })

  it('denies unsafe package and OpenCode asset activation through the MCP wrapper', () => {
    const decision = decideMcpRequestSecurityPolicy({
      method: 'PUT',
      path: '/profiles/dangerous_profile',
      body: { permissions: ['tools:*', 'secretRefs:raw-provider-token-value'] },
      trustTier: 'local_trusted',
      principalRef: 'local-mcp',
    })

    expect(decision).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'unsafe_package_grant',
      evidence: { surface: 'extension_package', capability: 'asset_write', redacted: true },
    })
    expect(JSON.stringify(decision)).not.toContain('raw-provider-token-value')
    expect(JSON.stringify(decision)).not.toContain('dangerous_profile')
  })

  it('keeps package validation inspectable while blocking unsafe activation paths', () => {
    const decision = decideMcpRequestSecurityPolicy({
      method: 'POST',
      path: '/agent-teams/validate',
      body: { permissions: ['tools:*'] },
      trustTier: 'local_trusted',
      principalRef: 'local-mcp',
    })

    expect(decision).toMatchObject({
      allowed: true,
      decision: 'allow',
      reasonCode: 'policy_allowed',
      evidence: { surface: 'mcp', capability: 'task_mutate', redacted: true },
    })
  })

  it('does not treat ordinary tool names as raw secret grants during local asset writes', () => {
    const decision = decideMcpRequestSecurityPolicy({
      method: 'PUT',
      path: '/profiles/safe_profile',
      body: { tools: ['webhook-diagnostics'], permissions: ['asset_write'] },
      trustTier: 'local_trusted',
      principalRef: 'local-mcp',
    })

    expect(decision).toMatchObject({
      allowed: true,
      decision: 'allow',
      reasonCode: 'policy_allowed',
      evidence: { surface: 'extension_package', capability: 'asset_write', redacted: true },
    })
  })

  it('denies evidence export for untrusted clients and requires human approval for unredacted export', () => {
    const untrusted = decideMcpRequestSecurityPolicy({
      method: 'GET',
      path: '/storage/export',
      trustTier: 'untrusted',
      principalRef: 'mcp:remote-preview-client',
    })
    const unredacted = decideMcpRequestSecurityPolicy({
      method: 'GET',
      path: '/evidence/export?redaction=none',
      trustTier: 'local_trusted',
      principalRef: 'local-mcp',
    })

    expect(untrusted).toMatchObject({
      allowed: false,
      decision: 'deny',
      reasonCode: 'evidence_export_denied',
      evidence: { surface: 'evidence_export', capability: 'evidence_export', redacted: true },
    })
    expect(unredacted).toMatchObject({
      allowed: false,
      decision: 'requires_human',
      reasonCode: 'requires_human_approval',
      evidence: { evidenceRequirement: 'unredacted-requires-human-approval', redacted: true },
    })
    expect(JSON.stringify(untrusted)).not.toContain('remote-preview-client')
  })
})
