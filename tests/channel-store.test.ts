import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID,
  CHANNEL_STORE_SCHEMA_VERSION,
  clearChannelStoreCache,
  createChannelDefinition,
  createLocalWebhookChannelPairing,
  createChannelDeliveryRecord,
  getChannelDb,
  listLocalWebhookPairings,
  listChannelDeliveryRecords,
  listChannelInboundItems,
  listChannelState,
  recordChannelInboundItem,
  rotateLocalWebhookPairingToken,
  verifyLocalWebhookPairingToken,
} from '../apps/desktop/src/main/channel-store.ts'
import {
  clearOperationalQueueStoreCache,
  listOperationalQueueItems,
  listWorkspaceProfiles,
} from '../apps/desktop/src/main/operational-queue-store.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-channel-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetStores(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearChannelStoreCache()
  clearOperationalQueueStoreCache()
}

function withChannelStore(name: string, fn: () => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetStores(userDataDir)
    fn()
  } finally {
    clearChannelStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

test('channel store records schema version and channel sandbox profile is channel-bound', () => withChannelStore('schema', () => {
  const version = getChannelDb().prepare('select value from channel_meta where key = ?').get('schema_version') as { value?: string } | undefined
  assert.equal(version?.value, String(CHANNEL_STORE_SCHEMA_VERSION))

  const sandbox = listWorkspaceProfiles().find((profile) => profile.id === CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID)
  assert.equal(sandbox?.kind, 'channel_sandbox')
  assert.equal(sandbox?.authority.isolation.channelBound, true)
  assert.equal(sandbox?.authority.filesystem.writeAllowed, false)
}))

test('unknown channel senders are audited and never enqueue execution', () => withChannelStore('unknown-sender', () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Support webhook',
    sourceKey: 'support',
    senderAllowlist: ['ops@example.com'],
    allowedCapabilityIds: ['tool:read_crm'],
    route: { activationMode: 'run_sop', targetSopId: 'sop-triage' },
  })

  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'attacker@example.net',
    subject: 'Please run this',
    body: 'Run the SOP.',
    externalMessageId: 'msg-1',
  })

  assert.equal(item.status, 'denied')
  assert.equal(item.auditState, 'denied_unknown_sender')
  assert.equal(item.source.sourceKey, 'support')
  assert.equal(item.source.externalMessageId, 'msg-1')
  assert.deepEqual(item.allowedCapabilityIds, ['tool:read_crm'])
  assert.equal(item.workspaceProfileId, CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID)
  assert.equal(item.queueItemId, null)
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('local webhook pairings store only token metadata and verify by source key', () => withChannelStore('webhook-pairing', () => {
  const paired = createLocalWebhookChannelPairing({
    name: 'Support webhook',
    sourceKey: 'support',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })

  assert.equal(paired.channel.provider, 'local_webhook')
  assert.match(paired.token, /^ocw_wh_/)
  assert.equal(paired.pairing.sourceKey, 'support')
  assert.equal(paired.pairing.tokenPrefix, paired.token.slice(0, 'ocw_wh_'.length + 6))
  assert.equal(listLocalWebhookPairings().length, 1)
  assert.equal(verifyLocalWebhookPairingToken('support', paired.token)?.channel.id, paired.channel.id)
  assert.equal(verifyLocalWebhookPairingToken('support', 'ocw_wh_wrong'), null)

  const rotated = rotateLocalWebhookPairingToken(paired.channel.id)
  assert.ok(rotated)
  assert.notEqual(rotated.token, paired.token)
  assert.equal(verifyLocalWebhookPairingToken('support', paired.token), null)
  assert.equal(verifyLocalWebhookPairingToken('support', rotated.token)?.channel.id, paired.channel.id)
}))

test('sender allowlists reject wildcard-only catch-all variants', () => withChannelStore('catch-all-allowlist', () => {
  const createWithPattern = (pattern: string) => createChannelDefinition({
    provider: 'local_webhook',
    name: `Webhook ${pattern}`,
    sourceKey: `webhook-${pattern.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'wildcard'}`,
    senderAllowlist: [pattern],
    route: { activationMode: 'run_sop', targetSopId: 'sop-triage' },
  })

  for (const pattern of ['*', '**', '***', '*@*', '*@**', '*@.', '*-*']) {
    assert.throws(() => createWithPattern(pattern), /catch-all wildcard/)
  }

  assert.doesNotThrow(() => createWithPattern('*@example.com'))
}))

test('allowed channel SOP routes enqueue review work in the channel sandbox', () => withChannelStore('allowed-sop', () => {
  const channel = createChannelDefinition({
    provider: 'email',
    name: 'Ops inbox',
    sourceKey: 'ops-inbox',
    senderAllowlist: ['*@example.com'],
    allowedCapabilityIds: ['tool:read_crm', 'skill:summarize'],
    route: { activationMode: 'run_sop', targetSopId: 'sop-weekly-report' },
  })

  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'lead@example.com',
    subject: 'Weekly report',
    body: 'Draft the weekly report.',
  })
  const queued = listOperationalQueueItems()

  assert.equal(item.status, 'queued')
  assert.equal(item.auditState, 'queued_for_review')
  assert.equal(item.route.activationMode, 'run_sop')
  assert.equal(item.route.targetSopId, 'sop-weekly-report')
  assert.equal(item.workspaceProfileId, CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID)
  assert.equal(queued.length, 1)
  assert.equal(queued[0]?.runKind, 'channel')
  assert.equal(queued[0]?.runId, item.id)
  assert.equal(queued[0]?.workspaceProfileId, CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID)
  assert.deepEqual(queued[0]?.queueKeys, [`channel:${channel.id}`])
  assert.equal(queued[0]?.authority.isolation.channelBound, true)
}))

test('draft-reply routes create draft-first delivery records without direct sending', () => withChannelStore('draft-reply', () => {
  const channel = createChannelDefinition({
    provider: 'slack',
    name: 'Customer Slack',
    sourceKey: 'customer-slack',
    senderAllowlist: ['customer@example.com'],
    route: { activationMode: 'draft_reply' },
  })

  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'customer@example.com',
    subject: 'Can you summarize this?',
    body: 'Summarize the latest thread.',
  })
  const deliveries = listChannelDeliveryRecords()

  assert.equal(item.status, 'drafted')
  assert.equal(item.auditState, 'draft_created')
  assert.ok(item.deliveryRecordId)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]?.id, item.deliveryRecordId)
  assert.equal(deliveries[0]?.provider, 'slack')
  assert.equal(deliveries[0]?.status, 'draft')
  assert.equal(deliveries[0]?.draftFirst, true)
  assert.equal(deliveries[0]?.target, 'customer@example.com')
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('delivered channel records require approvals and keep audit links', () => withChannelStore('delivery-links', () => {
  const channel = createChannelDefinition({
    provider: 'teams',
    name: 'Finance Teams',
    sourceKey: 'finance-teams',
    senderAllowlist: ['finance@example.com'],
    route: { activationMode: 'ask_user' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'finance@example.com',
    subject: 'Send report',
    body: 'Please send the report.',
  })

  assert.throws(
    () => createChannelDeliveryRecord({
      channelId: channel.id,
      inboundItemId: item.id,
      provider: 'teams',
      target: 'finance-channel',
      status: 'delivered',
      title: 'Report',
      body: 'Ready.',
    }),
    /approval reference/,
  )

  const delivery = createChannelDeliveryRecord({
    channelId: channel.id,
    inboundItemId: item.id,
    provider: 'teams',
    target: 'finance-channel',
    status: 'delivered',
    title: 'Report',
    body: 'Ready.',
    workItemId: 'work-1',
    runKind: 'channel',
    runId: item.id,
    artifactIds: ['artifact-1'],
    policyDecisionIds: ['policy-1'],
    approvalIds: ['approval-1'],
  })

  assert.equal(delivery.status, 'delivered')
  assert.equal(delivery.draftFirst, true)
  assert.equal(delivery.inboundItemId, item.id)
  assert.equal(delivery.runKind, 'channel')
  assert.equal(delivery.runId, item.id)
  assert.deepEqual(delivery.artifactIds, ['artifact-1'])
  assert.deepEqual(delivery.policyDecisionIds, ['policy-1'])
  assert.deepEqual(delivery.approvalIds, ['approval-1'])
}))

test('disabled channels record denied audit state for otherwise allowed senders', () => withChannelStore('disabled', () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Disabled webhook',
    sourceKey: 'disabled',
    enabled: false,
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })

  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'ops@example.com',
    body: 'Should not route.',
  })

  assert.equal(item.status, 'denied')
  assert.equal(item.auditState, 'denied_channel_disabled')
  assert.equal(item.queueItemId, null)
  assert.equal(item.deliveryRecordId, null)
  assert.equal(listChannelInboundItems().length, 1)
  assert.equal(listChannelState().inboundItems.length, 1)
}))
