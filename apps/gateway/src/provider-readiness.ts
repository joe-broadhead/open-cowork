import type { ChannelCapabilities } from '@open-cowork/gateway-channel'

import type { GatewayProviderKind } from './config.js'

type GatewayCapabilitySummary = Pick<
  ChannelCapabilities,
  | 'threads'
  | 'messageEditing'
  | 'inlineButtons'
  | 'fileUploads'
  | 'fileDownloads'
  | 'typingIndicator'
  | 'maxTextLength'
  | 'preferredParseMode'
  | 'maxButtonsPerMessage'
  | 'maxButtonRowsPerMessage'
  | 'maxButtonTokenBytes'
  | 'maxFileBytes'
  | 'supportsEphemeralResponses'
>

export type GatewayProviderReadinessTier = 1 | 2 | 3 | 'demo'

export type GatewayProviderReadinessEntry = {
  kind: GatewayProviderKind
  displayName: string
  tier: GatewayProviderReadinessTier
  status: 'launch' | 'utility' | 'later' | 'demo'
  intendedUse: string
  capabilities: GatewayCapabilitySummary
  authRequirements: string[]
  ingressModes: string[]
  approvalMode: 'inline-buttons' | 'token-fallback' | 'inline-or-token'
  fileSupport: string
  rateLimitBehavior: string
  localContractTests: string[]
  liveSmoke: string
}

export const GATEWAY_PROVIDER_READINESS_MATRIX: GatewayProviderReadinessEntry[] = [
  {
    kind: 'telegram',
    displayName: 'Telegram',
    tier: 1,
    status: 'launch',
    intendedUse: 'Launch-ready direct-message and group-topic bot for self-hosted and managed Gateway installs.',
    capabilities: {
      threads: true,
      messageEditing: true,
      inlineButtons: true,
      fileUploads: true,
      fileDownloads: true,
      typingIndicator: true,
      maxTextLength: 4096,
      preferredParseMode: 'plain',
      maxButtonsPerMessage: 8,
      maxButtonRowsPerMessage: 4,
      maxButtonTokenBytes: 64,
      maxFileBytes: 20 * 1024 * 1024,
      supportsEphemeralResponses: true,
    },
    authRequirements: ['bot token', 'webhook secret when webhook mode is enabled'],
    ingressModes: ['polling', 'webhook'],
    approvalMode: 'inline-or-token',
    fileSupport: 'Uploads and downloads are supported within Telegram file-size limits.',
    rateLimitBehavior: 'Provider uses bounded Telegram retry/backoff for transient API and rate-limit responses.',
    localContractTests: [
      'packages/gateway-provider-telegram/src/telegram-provider.test.ts',
      'packages/gateway-provider-telegram/src/telegram-retry.test.ts',
      'apps/gateway/src/daemon.test.ts',
    ],
    liveSmoke: 'Use polling for private installs; webhook smoke requires HTTPS public URL plus Telegram webhook secret.',
  },
  {
    kind: 'slack',
    displayName: 'Slack',
    tier: 1,
    status: 'launch',
    intendedUse: 'Launch-ready team workspace channel with signed webhook ingress, Block Kit approvals, threads, and files.',
    capabilities: {
      threads: true,
      messageEditing: true,
      inlineButtons: true,
      fileUploads: true,
      fileDownloads: true,
      typingIndicator: false,
      maxTextLength: 3000,
      preferredParseMode: 'plain',
      maxButtonsPerMessage: 10,
      maxButtonRowsPerMessage: 5,
      maxButtonTokenBytes: 2000,
      maxFileBytes: 20 * 1024 * 1024,
      supportsEphemeralResponses: false,
    },
    authRequirements: ['bot token', 'signing secret'],
    ingressModes: ['webhook'],
    approvalMode: 'inline-or-token',
    fileSupport: 'Uploads and downloads are supported through Slack API file endpoints.',
    rateLimitBehavior: 'Provider surfaces Slack API failures to Gateway delivery retry/dead-letter policy.',
    localContractTests: [
      'packages/gateway-provider-slack/src/slack-provider.test.ts',
      'apps/gateway/src/daemon.test.ts',
    ],
    liveSmoke: 'Create a Slack app with Events and Interactivity pointed at /webhooks/slack; verify signed events and button callbacks.',
  },
  {
    kind: 'email',
    displayName: 'Email',
    tier: 1,
    status: 'launch',
    intendedUse: 'Launch-ready async channel for prompt-by-email and delayed workflow replies.',
    capabilities: {
      threads: true,
      messageEditing: false,
      inlineButtons: false,
      fileUploads: true,
      fileDownloads: false,
      typingIndicator: false,
      maxTextLength: 20_000,
      preferredParseMode: 'plain',
      maxButtonsPerMessage: 0,
      maxButtonRowsPerMessage: 0,
      maxButtonTokenBytes: 0,
      maxFileBytes: 15 * 1024 * 1024,
      supportsEphemeralResponses: false,
    },
    authRequirements: ['inbound webhook shared secret', 'SMTP credentials when SMTP auth is required'],
    ingressModes: ['webhook'],
    approvalMode: 'token-fallback',
    fileSupport: 'Inbound attachments are accepted; outbound artifacts should render as links.',
    rateLimitBehavior: 'SMTP and inbound webhook failures flow through Gateway delivery retry/dead-letter policy.',
    localContractTests: [
      'packages/gateway-provider-email/src/email-provider.test.ts',
      'apps/gateway/src/event-renderer.test.ts',
    ],
    liveSmoke: 'Send an inbound provider webhook or email fixture and verify the threaded reply path.',
  },
  {
    kind: 'webhook',
    displayName: 'Generic Webhook',
    tier: 2,
    status: 'utility',
    intendedUse: 'Local and integration bridge for custom systems that can sign Gateway ingress and accept signed delivery callbacks.',
    capabilities: {
      threads: true,
      messageEditing: true,
      inlineButtons: true,
      fileUploads: true,
      fileDownloads: false,
      typingIndicator: true,
      maxTextLength: 4096,
      preferredParseMode: 'plain',
      maxButtonsPerMessage: 8,
      maxButtonRowsPerMessage: 4,
      maxButtonTokenBytes: 64,
      maxFileBytes: 25 * 1024 * 1024,
      supportsEphemeralResponses: false,
    },
    authRequirements: ['shared secret for HMAC/timestamp ingress and outbound delivery signing'],
    ingressModes: ['webhook'],
    approvalMode: 'inline-or-token',
    fileSupport: 'Inbound files may be carried inline; outbound file downloads should be represented by links.',
    rateLimitBehavior: 'Bridge delivery uses bounded retry/backoff for transient HTTP failures.',
    localContractTests: [
      'packages/gateway-provider-webhook/src/webhook-provider.test.ts',
      'apps/gateway/src/daemon.test.ts',
    ],
    liveSmoke: 'Use a signed bridge fixture; public ingress must reject unsigned, stale, and replayed requests.',
  },
  {
    kind: 'cli',
    displayName: 'CLI',
    tier: 2,
    status: 'utility',
    intendedUse: 'Local integration and smoke-test channel; not a public webhook surface.',
    capabilities: {
      threads: true,
      messageEditing: false,
      inlineButtons: false,
      fileUploads: true,
      fileDownloads: false,
      typingIndicator: false,
      maxTextLength: 12_000,
      preferredParseMode: 'plain',
      maxButtonsPerMessage: 0,
      maxButtonRowsPerMessage: 0,
      maxButtonTokenBytes: 0,
      maxFileBytes: 10 * 1024 * 1024,
      supportsEphemeralResponses: false,
    },
    authRequirements: ['local process boundary; no public HTTP ingress'],
    ingressModes: ['stdio'],
    approvalMode: 'token-fallback',
    fileSupport: 'Inbound file metadata can be represented; outbound artifacts should render as links.',
    rateLimitBehavior: 'No provider-side rate limit; Gateway delivery retry/dead-letter still applies to cloud delivery records.',
    localContractTests: [
      'packages/gateway-provider-cli/src/cli-provider.test.ts',
      'scripts/gateway-cloud-smoke.mjs',
    ],
    liveSmoke: 'Use only on trusted local hosts or CI smoke environments.',
  },
  {
    kind: 'discord',
    displayName: 'Discord',
    tier: 3,
    status: 'later',
    intendedUse: 'Bridge-backed provider for later live-provider hardening.',
    capabilities: {
      threads: true,
      messageEditing: true,
      inlineButtons: true,
      fileUploads: true,
      fileDownloads: true,
      typingIndicator: true,
      maxTextLength: 2000,
      preferredParseMode: 'markdown',
      maxButtonsPerMessage: 25,
      maxButtonRowsPerMessage: 5,
      maxButtonTokenBytes: 64,
      maxFileBytes: 8 * 1024 * 1024,
      supportsEphemeralResponses: true,
    },
    authRequirements: ['bridge shared secret'],
    ingressModes: ['signed bridge webhook'],
    approvalMode: 'inline-or-token',
    fileSupport: 'Bridge advertises upload and download support within Discord-like limits.',
    rateLimitBehavior: 'Bridge delivery uses bounded webhook retry/backoff; live Discord app rate-limit behavior remains hardening work.',
    localContractTests: [
      'packages/gateway-provider-discord/src/discord-provider.test.ts',
      'packages/gateway-provider-webhook/src/webhook-provider.test.ts',
    ],
    liveSmoke: 'Deferred until a first-party Discord app adapter is promoted from bridge mode.',
  },
  {
    kind: 'whatsapp',
    displayName: 'WhatsApp',
    tier: 3,
    status: 'later',
    intendedUse: 'Bridge-backed provider for later WhatsApp Cloud API or Twilio hardening.',
    capabilities: {
      threads: false,
      messageEditing: false,
      inlineButtons: true,
      fileUploads: true,
      fileDownloads: true,
      typingIndicator: true,
      maxTextLength: 4096,
      preferredParseMode: 'plain',
      maxButtonsPerMessage: 3,
      maxButtonRowsPerMessage: 1,
      maxButtonTokenBytes: 64,
      maxFileBytes: 16 * 1024 * 1024,
      supportsEphemeralResponses: false,
    },
    authRequirements: ['bridge shared secret'],
    ingressModes: ['signed bridge webhook'],
    approvalMode: 'inline-or-token',
    fileSupport: 'Bridge advertises media upload and download support within WhatsApp-like limits.',
    rateLimitBehavior: 'Bridge delivery uses bounded webhook retry/backoff; live WhatsApp rate-limit behavior remains hardening work.',
    localContractTests: [
      'packages/gateway-provider-whatsapp/src/whatsapp-provider.test.ts',
      'packages/gateway-provider-webhook/src/webhook-provider.test.ts',
    ],
    liveSmoke: 'Deferred until a first-party WhatsApp Cloud API or Twilio adapter is promoted from bridge mode.',
  },
  {
    kind: 'signal',
    displayName: 'Signal',
    tier: 3,
    status: 'later',
    intendedUse: 'Bridge-backed provider for later signal-cli hardening.',
    capabilities: {
      threads: false,
      messageEditing: false,
      inlineButtons: false,
      fileUploads: true,
      fileDownloads: true,
      typingIndicator: true,
      maxTextLength: 4096,
      preferredParseMode: 'plain',
      maxButtonsPerMessage: 8,
      maxButtonRowsPerMessage: 4,
      maxButtonTokenBytes: 64,
      maxFileBytes: 100 * 1024 * 1024,
      supportsEphemeralResponses: false,
    },
    authRequirements: ['bridge shared secret'],
    ingressModes: ['signed bridge webhook'],
    approvalMode: 'token-fallback',
    fileSupport: 'Bridge advertises large media upload and download support; approvals use command-token fallback.',
    rateLimitBehavior: 'Bridge delivery uses bounded webhook retry/backoff; live signal-cli rate-limit behavior remains hardening work.',
    localContractTests: [
      'packages/gateway-provider-signal/src/signal-provider.test.ts',
      'packages/gateway-provider-webhook/src/webhook-provider.test.ts',
    ],
    liveSmoke: 'Deferred until a signal-cli bridge deployment recipe is promoted.',
  },
  {
    kind: 'fake',
    displayName: 'Fake',
    tier: 'demo',
    status: 'demo',
    intendedUse: 'Explicit loopback-only local/demo and CI smoke provider.',
    capabilities: {
      threads: false,
      messageEditing: true,
      inlineButtons: true,
      fileUploads: true,
      fileDownloads: true,
      typingIndicator: false,
      maxTextLength: 4096,
      preferredParseMode: 'plain',
      maxButtonsPerMessage: 8,
      maxButtonRowsPerMessage: 4,
      maxButtonTokenBytes: 128,
      maxFileBytes: 25 * 1024 * 1024,
      supportsEphemeralResponses: true,
    },
    authRequirements: ['explicit OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true', 'loopback bind by default'],
    ingressModes: ['local fake webhook'],
    approvalMode: 'inline-or-token',
    fileSupport: 'In-memory fake file behavior for deterministic tests only.',
    rateLimitBehavior: 'No provider-side rate limits; not for production ingress.',
    localContractTests: [
      'packages/gateway-testing/src/fake-channel.test.ts',
      'apps/gateway/src/daemon.test.ts',
      'scripts/gateway-cloud-smoke.mjs',
    ],
    liveSmoke: 'Allowed only for local loopback and CI smoke tests; public exposure requires an explicit demo override.',
  },
]

export function findGatewayProviderReadiness(kind: GatewayProviderKind) {
  return GATEWAY_PROVIDER_READINESS_MATRIX.find((entry) => entry.kind === kind) || null
}
