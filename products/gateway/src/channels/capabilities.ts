export type ChannelRenderCapability =
  | 'plainText'
  | 'markdown'
  | 'richBlocks'
  | 'streamingDraft'
  | 'buttons'
  | 'tables'
  | 'collapsibleDetails'
  | 'media'

export type ChannelRenderCapabilities = Partial<Record<ChannelRenderCapability, boolean>>

export type ChannelRenderMode = 'rich' | 'markdown' | 'plainText'

export type ChannelAdapterCapability =
  | 'richText'
  | 'richCards'
  | 'inlineActions'
  | 'callbacks'
  | 'filesMedia'
  | 'threading'
  | 'identityBinding'
  | 'deepLinks'
  | 'notifications'
  | 'edits'
  | 'deletes'
  | 'fallbackBehavior'

export type ChannelCapabilityStatus = 'supported' | 'partial' | 'planned' | 'unsupported'
export type ChannelSurfaceStage = 'production' | 'alpha' | 'planned'
export type ChannelConnectorState =
  | 'not_configured'
  | 'credentials_needed'
  | 'provider_connected'
  | 'webhook_needed'
  | 'polling_ready'
  | 'verification_pending'
  | 'trusted_target_pending'
  | 'bound'
  | 'ready'
  | 'degraded'
  | 'blocked'

export type ChannelOnboardingAction =
  | 'connect'
  | 'verify'
  | 'trust'
  | 'bind'
  | 'repair'
  | 'disconnect'

export type ChannelSetupMode = 'polling' | 'webhook' | 'local' | 'embeddedSignup' | 'providerManaged'
export type ChannelCredentialSource = 'environment' | 'config' | 'operatorGenerated' | 'providerConsole' | 'oauth'
export type ChannelTrustMode = 'manualAllowlist' | 'claimCode' | 'localSession' | 'providerInstall'
export type ChannelSetupDiagnosticSeverity = 'info' | 'warning' | 'blocked'
export type ChannelSetupPathStatus = 'implemented' | 'scaffolded' | 'documented_only'
export type ChannelSetupDiagnosticCode =
  | 'provider_disabled'
  | 'missing_credentials'
  | 'provider_auth_failed'
  | 'callback_url_missing'
  | 'verify_token_mismatch'
  | 'signature_verification_missing'
  | 'unsafe_route_exposure'
  | 'missing_allowlist'
  | 'claim_required'
  | 'binding_missing'
  | 'provider_unavailable'

export interface ChannelConnectorStateDefinition {
  summary: string
  nextActions: ChannelOnboardingAction[]
  terminal?: boolean
  failure?: boolean
}

export interface ChannelCredentialRequirement {
  key: string
  label: string
  source: ChannelCredentialSource
  secret: boolean
  env?: string
  configKey?: string
  summary: string
}

export interface ChannelWebhookRouteRequirement {
  method: 'GET' | 'POST'
  path: string
  purpose: string
}

export interface ChannelWebhookRequirement {
  routes: ChannelWebhookRouteRequirement[]
  signature: ChannelCapabilityStatus
  challenge?: string
  publicExposure: string
}

export interface ChannelTrustRequirement {
  summary: string
  allowlistConfigKey?: string
  targetIdRedaction: 'required' | 'notApplicable'
  modes: Array<{
    mode: ChannelTrustMode
    status: ChannelCapabilityStatus
    summary: string
    fallback?: string
  }>
}

export interface ChannelSetupDiagnosticDefinition {
  code: ChannelSetupDiagnosticCode
  state: ChannelConnectorState
  severity: ChannelSetupDiagnosticSeverity
  summary: string
  remediation: string
}

export interface ChannelSetupPathDefinition {
  key: string
  label: string
  modes: ChannelSetupMode[]
  status: ChannelSetupPathStatus
  summary: string
  nextActions: string[]
  prerequisites?: string[]
  env?: string[]
  configKeys?: string[]
  docs?: Array<{ label: string; url: string }>
}

export interface ChannelOnboardingCapabilities {
  modes: ChannelSetupMode[]
  states: ChannelConnectorState[]
  actions: ChannelOnboardingAction[]
  credentials: ChannelCredentialRequirement[]
  setupPaths?: ChannelSetupPathDefinition[]
  webhook?: ChannelWebhookRequirement
  trust: ChannelTrustRequirement
  diagnostics: ChannelSetupDiagnosticDefinition[]
  notes?: string[]
}

export interface ChannelCapabilityDefinition {
  status: ChannelCapabilityStatus
  summary: string
  fallback?: string
}

export type ChannelCapabilityMatrix = Record<ChannelAdapterCapability, ChannelCapabilityDefinition>

export interface ChannelFallbackBehavior {
  order: ChannelRenderMode[]
  maxChars?: number
  semantics: string[]
}

export interface ChannelCapabilities extends ChannelRenderCapabilities {
  provider: string
  displayName: string
  stage: ChannelSurfaceStage
  categories: ChannelCapabilityMatrix
  fallback: ChannelFallbackBehavior
  onboarding: ChannelOnboardingCapabilities
  notes?: string[]
}

export const CHANNEL_ONBOARDING_ACTIONS: ChannelOnboardingAction[] = [
  'connect',
  'verify',
  'trust',
  'bind',
  'repair',
  'disconnect',
]

export const CHANNEL_CONNECTOR_STATE_DEFINITIONS: Record<ChannelConnectorState, ChannelConnectorStateDefinition> = {
  not_configured: {
    summary: 'No connector metadata or local configuration exists yet.',
    nextActions: ['connect'],
  },
  credentials_needed: {
    summary: 'The connector exists but required provider credentials or local config are missing.',
    nextActions: ['connect', 'repair'],
  },
  provider_connected: {
    summary: 'Provider credentials or install context are present enough to contact the provider.',
    nextActions: ['verify', 'trust'],
  },
  webhook_needed: {
    summary: 'The connector needs a provider callback route before inbound events can be accepted.',
    nextActions: ['verify', 'repair'],
  },
  polling_ready: {
    summary: 'The connector can receive provider events through polling or an equivalent stream.',
    nextActions: ['trust', 'bind'],
  },
  verification_pending: {
    summary: 'The connector needs a challenge, signature, or local verifier pass before it can accept inbound events.',
    nextActions: ['verify', 'repair'],
  },
  trusted_target_pending: {
    summary: 'The provider connection works, but no trusted channel target is allowed to mutate Gateway state.',
    nextActions: ['trust'],
  },
  bound: {
    summary: 'A trusted channel target is linked to a Gateway Session, Issue, or Project.',
    nextActions: ['disconnect'],
    terminal: true,
  },
  ready: {
    summary: 'The connector is configured, trusted, and bound to a Gateway Session, Issue, or Project.',
    nextActions: ['disconnect'],
    terminal: true,
  },
  degraded: {
    summary: 'The connector can partially operate, but setup or delivery evidence has warnings that need repair.',
    nextActions: ['repair'],
  },
  blocked: {
    summary: 'The connector must not be used until a missing provider, security, or trust blocker is resolved.',
    nextActions: ['repair'],
    failure: true,
  },
}

export const CHANNEL_ADAPTER_CAPABILITY_KEYS: ChannelAdapterCapability[] = [
  'richText',
  'richCards',
  'inlineActions',
  'callbacks',
  'filesMedia',
  'threading',
  'identityBinding',
  'deepLinks',
  'notifications',
  'edits',
  'deletes',
  'fallbackBehavior',
]

export const DEFAULT_RENDER_CAPABILITIES: Required<ChannelRenderCapabilities> = {
  plainText: true,
  markdown: false,
  richBlocks: false,
  streamingDraft: false,
  buttons: false,
  tables: false,
  collapsibleDetails: false,
  media: false,
}

type MatrixInput = Partial<Record<ChannelAdapterCapability, ChannelCapabilityDefinition>>

interface CapabilityDeclarationInput {
  provider: string
  displayName: string
  stage: ChannelSurfaceStage
  render: ChannelRenderCapabilities
  categories: MatrixInput
  fallback: ChannelFallbackBehavior
  onboarding: ChannelOnboardingCapabilities
  notes?: string[]
}

export function normalizeChannelRenderCapabilities(capabilities: ChannelRenderCapabilities = {}): Required<ChannelRenderCapabilities> {
  return { ...DEFAULT_RENDER_CAPABILITIES, ...capabilities, plainText: capabilities.plainText ?? true }
}

export function defineChannelCapabilities(input: CapabilityDeclarationInput): ChannelCapabilities {
  const render = normalizeChannelRenderCapabilities(input.render)
  return {
    provider: input.provider,
    displayName: input.displayName,
    stage: input.stage,
    ...render,
    categories: completeCapabilityMatrix(input.categories),
    fallback: input.fallback,
    onboarding: input.onboarding,
    ...(input.notes?.length ? { notes: input.notes } : {}),
  }
}

export function channelCapabilityState(capabilities: ChannelCapabilities | ChannelRenderCapabilities | undefined, capability: ChannelAdapterCapability): ChannelCapabilityStatus {
  const full = asChannelCapabilities(capabilities)
  if (full?.categories?.[capability]) return full.categories[capability].status
  if (capability === 'fallbackBehavior') return capabilities?.plainText === false ? 'unsupported' : 'supported'
  if (capability === 'richText') return capabilities?.markdown ? 'supported' : 'unsupported'
  if (capability === 'richCards') return capabilities?.richBlocks ? 'supported' : 'unsupported'
  if (capability === 'inlineActions' || capability === 'callbacks') return capabilities?.buttons ? 'partial' : 'unsupported'
  if (capability === 'filesMedia') return capabilities?.media ? 'supported' : 'unsupported'
  return 'unsupported'
}

export function supportsChannelCapability(capabilities: ChannelCapabilities | ChannelRenderCapabilities | undefined, capability: ChannelAdapterCapability): boolean {
  const state = channelCapabilityState(capabilities, capability)
  return state === 'supported' || state === 'partial'
}

export function actionDeliveryForCapabilities(
  capabilities: ChannelCapabilities | ChannelRenderCapabilities | undefined,
  nativeActionSenderAvailable: boolean,
): 'native' | 'text' {
  return nativeActionSenderAvailable && supportsChannelCapability(capabilities, 'inlineActions') ? 'native' : 'text'
}

export function getChannelCapabilities(provider: string): ChannelCapabilities | undefined {
  return CHANNEL_CAPABILITY_REGISTRY[provider]
}

export function listChannelCapabilities(): ChannelCapabilities[] {
  return Object.values(CHANNEL_CAPABILITY_REGISTRY)
}

export function telegramAdapterCapabilities(options: { richMessagesEnabled?: boolean } = {}): ChannelCapabilities {
  const rich = options.richMessagesEnabled !== false
  return defineChannelCapabilities({
    provider: 'telegram',
    displayName: 'Telegram',
    stage: 'production',
    render: {
      plainText: true,
      markdown: true,
      richBlocks: rich,
      buttons: rich,
      tables: rich,
      collapsibleDetails: rich,
      media: rich,
    },
    categories: {
      richText: supported('Markdown formatting is sent through the Bot API sendMessage path.'),
      richCards: rich
        ? supported('Structured Gateway cards render through Telegram rich messages.')
        : unsupported('Telegram rich messages are disabled by configuration.', 'Use Markdown or plain text fallbacks.'),
      inlineActions: rich
        ? partial('URL actions, short command callbacks, and copy-command controls render as inline keyboard rows.', 'Command payloads remain visible in fallback text.')
        : unsupported('Inline action rendering is disabled with Telegram rich messages.', 'Expose commands in Markdown or plain text.'),
      callbacks: rich
        ? partial('Short command actions are normalized from callback_query data into the same Gateway command payloads.', 'Long command actions use copy-command controls and remain visible in fallback text.')
        : unsupported('Callback query handling is disabled with Telegram rich messages.', 'Expose commands in Markdown or plain text.'),
      filesMedia: rich
        ? partial('Safe HTTP/HTTPS media references can render in rich blocks; inbound attachments are not normalized yet.', 'Unsupported media references render as text links.')
        : unsupported('Media blocks are disabled with Telegram rich messages.', 'Render media references as text.'),
      threading: supported('Telegram forum topic message_thread_id maps to Gateway threadId.'),
      identityBinding: supported('Gateway binds provider, chatId, threadId, and userId to Session context.'),
      deepLinks: partial('URL actions and /open replies can carry OpenCode Web/TUI links.', 'Plain text includes link text when native controls are unavailable.'),
      notifications: supported('Gateway can deliver sync, request, alert, and progress notifications to Telegram targets.'),
      edits: unsupported('Telegram message editing is not used by Gateway yet.', 'Send a follow-up notification.'),
      deletes: unsupported('Telegram message deletion is not used by Gateway yet.', 'Leave prior messages intact and send corrections.'),
      fallbackBehavior: supported('Rich send failures degrade to Markdown, then Telegram sendMessage retries without parse mode.'),
    },
    fallback: {
      order: ['rich', 'markdown', 'plainText'],
      maxChars: 4000,
      semantics: [
        'Preserve title, state, summary, facts, next action, and action command payloads.',
        'Retry plain text if Telegram rejects Markdown parse mode.',
      ],
    },
    onboarding: {
      modes: ['polling'],
      states: ['not_configured', 'credentials_needed', 'provider_connected', 'polling_ready', 'trusted_target_pending', 'bound', 'ready', 'degraded', 'blocked'],
      actions: CHANNEL_ONBOARDING_ACTIONS,
      credentials: [
        {
          key: 'telegram_bot_token',
          label: 'Telegram bot token',
          source: 'providerConsole',
          secret: true,
          env: 'TELEGRAM_BOT_TOKEN',
          configKey: 'channels.telegram.botToken',
          summary: 'Created with BotFather and used for long polling and outbound sends.',
        },
      ],
      trust: {
        summary: 'Gateway trusts explicit Telegram chat or chat/topic targets only.',
        allowlistConfigKey: 'security.channelAllowlists.telegram',
        targetIdRedaction: 'required',
        modes: [
          { mode: 'manualAllowlist', status: 'supported', summary: 'Operators can configure trusted chatId/threadId targets directly.' },
          { mode: 'claimCode', status: 'supported', summary: 'Operators can claim a Telegram target without copying raw chat IDs.', fallback: 'Use manual allowlist when claim delivery is unavailable.' },
        ],
      },
      diagnostics: [
        diagnostic('missing_credentials', 'credentials_needed', 'blocked', 'Telegram bot token is missing.', 'Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.'),
        diagnostic('provider_auth_failed', 'degraded', 'blocked', 'Telegram startup or getMe verification failed.', 'Rotate the bot token or inspect provider reachability, then restart Gateway.'),
        diagnostic('missing_allowlist', 'trusted_target_pending', 'blocked', 'No trusted Telegram target is configured.', 'Run opencode-gateway channel claim telegram or add security.channelAllowlists.telegram.'),
        diagnostic('binding_missing', 'trusted_target_pending', 'warning', 'Trusted Telegram target is not bound to a Session or Project.', 'Run /project bind or /bind session from the trusted target.'),
      ],
    },
  })
}

export const WHATSAPP_CAPABILITIES = defineChannelCapabilities({
  provider: 'whatsapp',
  displayName: 'WhatsApp',
  stage: 'production',
  render: {
    plainText: true,
    buttons: true,
  },
  categories: {
    richText: unsupported('WhatsApp sends Gateway structured messages as bounded text today.', 'Render deterministic plain text.'),
    richCards: unsupported('WhatsApp templates/cards are not mapped for Gateway cards yet.', 'Render deterministic plain text.'),
    inlineActions: partial('The command menu can render as a WhatsApp interactive list.', 'Send command help as text when interactive delivery fails.'),
    callbacks: partial('Interactive list and button replies are normalized back to command payload text.', 'Users can type the same slash command manually.'),
    filesMedia: partial('Inbound media metadata is normalized; outbound media rendering is not implemented.', 'Expose media references as text.'),
    threading: unsupported('WhatsApp sender/account chats have no Gateway thread scope today.', 'Use chatId-only bindings.'),
    identityBinding: supported('Gateway binds WhatsApp sender/account IDs to Session context.'),
    deepLinks: partial('OpenCode links can be included as text, but no native deep-link controls are rendered.', 'Send link text in the fallback body.'),
    notifications: supported('Gateway can deliver sync, request, alert, and progress notifications to WhatsApp targets.'),
    edits: unsupported('WhatsApp message editing is not used by Gateway yet.', 'Send a follow-up notification.'),
    deletes: unsupported('WhatsApp message deletion is not used by Gateway yet.', 'Leave prior messages intact and send corrections.'),
    fallbackBehavior: supported('Structured messages degrade to bounded plain text; command menus fall back to text on Graph API failure.'),
  },
  fallback: {
    order: ['plainText'],
    maxChars: 4000,
    semantics: [
      'Preserve action command payloads in text so typed commands and native lists stay equivalent.',
      'Do not advance delivery state when the Graph API send fails.',
    ],
  },
  onboarding: {
    modes: ['webhook', 'embeddedSignup', 'providerManaged'],
    states: ['not_configured', 'credentials_needed', 'provider_connected', 'webhook_needed', 'verification_pending', 'trusted_target_pending', 'bound', 'ready', 'degraded', 'blocked'],
    actions: CHANNEL_ONBOARDING_ACTIONS,
    credentials: [
      {
        key: 'whatsapp_access_token',
        label: 'WhatsApp access token',
        source: 'providerConsole',
        secret: true,
        env: 'WHATSAPP_ACCESS_TOKEN',
        configKey: 'channels.whatsapp.accessToken',
        summary: 'Meta Cloud API token used for outbound Graph API sends.',
      },
      {
        key: 'whatsapp_phone_number_id',
        label: 'WhatsApp phone number ID',
        source: 'providerConsole',
        secret: false,
        env: 'WHATSAPP_PHONE_NUMBER_ID',
        configKey: 'channels.whatsapp.phoneNumberId',
        summary: 'Provider-managed sender identity used in Graph API message URLs.',
      },
      {
        key: 'whatsapp_verify_token',
        label: 'WhatsApp verify token',
        source: 'operatorGenerated',
        secret: true,
        env: 'WHATSAPP_VERIFY_TOKEN',
        configKey: 'channels.whatsapp.verifyToken',
        summary: 'Operator-generated challenge token used during Meta webhook verification.',
      },
      {
        key: 'whatsapp_app_secret',
        label: 'WhatsApp app secret',
        source: 'providerConsole',
        secret: true,
        env: 'WHATSAPP_APP_SECRET',
        configKey: 'channels.whatsapp.appSecret',
        summary: 'Meta app secret used to verify signed inbound POST webhooks.',
      },
    ],
    setupPaths: [
      {
        key: 'cloud_api_direct',
        label: 'Cloud API direct',
        modes: ['webhook'],
        status: 'implemented',
        summary: 'Direct Meta Cloud API setup uses local credentials, Gateway webhook verification, claim-code trust, and binding.',
        env: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'],
        configKeys: ['channels.whatsapp.accessToken', 'channels.whatsapp.phoneNumberId', 'channels.whatsapp.verifyToken', 'channels.whatsapp.appSecret'],
        prerequisites: [
          'Meta app with WhatsApp product enabled.',
          'Cloud API access token with permission to send messages.',
          'Registered WhatsApp phone number ID.',
          'Webhook callback URL ending in /webhooks/whatsapp with messages subscribed.',
          'Meta app secret for signed POST webhook verification.',
        ],
        nextActions: [
          'Enter the four direct setup values locally.',
          'Expose only GET/POST /webhooks/whatsapp and verify the callback.',
          'Use a claim code or explicit allowlist to trust the sender target.',
        ],
        docs: [
          { label: 'Meta Cloud API get started', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started' },
          { label: 'Meta access tokens', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/' },
          { label: 'Meta webhooks', url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/' },
        ],
      },
    ],
    webhook: {
      routes: [
        { method: 'GET', path: '/webhooks/whatsapp', purpose: 'Meta verification challenge.' },
        { method: 'POST', path: '/webhooks/whatsapp', purpose: 'Signed inbound WhatsApp messages.' },
      ],
      signature: 'supported',
      challenge: 'hub.verify_token must match the configured verify token.',
      publicExposure: 'Expose only /webhooks/whatsapp through a tunnel or authenticated reverse proxy; keep other routes local or capability-protected.',
    },
    trust: {
      summary: 'Gateway trusts explicit WhatsApp sender/account targets; WhatsApp currently has no thread scope.',
      allowlistConfigKey: 'security.channelAllowlists.whatsapp',
      targetIdRedaction: 'required',
      modes: [
        { mode: 'manualAllowlist', status: 'supported', summary: 'Operators can configure trusted sender/account IDs directly.' },
        { mode: 'claimCode', status: 'supported', summary: 'Operators can claim sender trust without copying raw phone/account IDs.', fallback: 'Use manual allowlist when claim delivery is unavailable.' },
      ],
    },
    diagnostics: [
      diagnostic('missing_credentials', 'credentials_needed', 'blocked', 'One or more WhatsApp Cloud API credentials are missing.', 'Configure access token, phone number ID, verify token, and app secret through env or local config.'),
      diagnostic('callback_url_missing', 'webhook_needed', 'blocked', 'WhatsApp has no verified callback URL for inbound messages.', 'Expose only /webhooks/whatsapp through the provider callback URL.'),
      diagnostic('verify_token_mismatch', 'verification_pending', 'blocked', 'Meta webhook verification token does not match Gateway config.', 'Update the provider verify token or WHATSAPP_VERIFY_TOKEN and retry verification.'),
      diagnostic('signature_verification_missing', 'verification_pending', 'blocked', 'WhatsApp app secret is missing, so inbound POST signatures cannot be verified.', 'Configure WHATSAPP_APP_SECRET or channels.whatsapp.appSecret before accepting inbound messages.'),
      diagnostic('unsafe_route_exposure', 'blocked', 'blocked', 'Webhook setup appears to expose more than documented webhook routes.', 'Restrict public exposure to GET/POST /webhooks/whatsapp and keep other routes capability-protected.'),
      diagnostic('missing_allowlist', 'trusted_target_pending', 'blocked', 'No trusted WhatsApp sender target is configured.', 'Run opencode-gateway channel claim whatsapp or add security.channelAllowlists.whatsapp.'),
      diagnostic('binding_missing', 'trusted_target_pending', 'warning', 'Trusted WhatsApp target is not bound to a Session or Project.', 'Run /project bind or /bind session from the trusted target.'),
    ],
  },
})

export function discordAdapterCapabilities(options: { enabled?: boolean; richMessagesEnabled?: boolean } = {}): ChannelCapabilities {
  const enabled = options.enabled === true
  const rich = enabled && options.richMessagesEnabled !== false
  return defineChannelCapabilities({
    provider: 'discord',
    displayName: 'Discord',
    stage: 'alpha',
    render: {
      plainText: true,
      markdown: true,
      richBlocks: rich,
      buttons: rich,
      tables: rich,
      collapsibleDetails: rich,
      media: rich,
    },
    categories: {
      richText: supported('Discord alpha sends Markdown-safe content through channel messages.'),
      richCards: rich
        ? partial('Structured Gateway cards map to Discord embeds with bounded fields, tables, details, and safe media links.', 'Retry Markdown/plain text if Discord rejects the embed payload.')
        : unsupported('Discord rich messages are disabled until the alpha flag and rich-message toggle are enabled.', 'Use Markdown/plain text fallback.'),
      inlineActions: rich
        ? partial('URL actions become link buttons and short command actions become component custom IDs.', 'Expose command payloads in fallback text when native buttons are unavailable.')
        : unsupported('Discord components are disabled with rich messages.', 'Expose slash commands in Markdown/plain text.'),
      callbacks: partial('Signed Discord interactions normalize component custom IDs and slash commands back to Gateway text commands.', 'Users can type the same slash command manually.'),
      filesMedia: partial('Inbound attachment metadata is normalized and safe HTTP(S) image media may render in embeds.', 'Unsupported media references render as text links.'),
      threading: partial('Outbound delivery can target Discord thread IDs; inbound events preserve stable channel IDs from Discord payloads.', 'Use chatId-only bindings where parent thread context is unavailable.'),
      identityBinding: supported('Gateway uses stable Discord user IDs and trusted channel target checks, never display names, as identity.'),
      deepLinks: partial('HTTP(S) actions render as Discord link buttons when rich messages are enabled.', 'Show URLs in Markdown/plain text fallback.'),
      notifications: supported('Gateway can deliver sync, request, alert, delegation, and progress notifications through the Discord send path.'),
      edits: unsupported('Discord message editing is intentionally out of scope for the proof adapter.', 'Send a follow-up notification that supersedes prior state.'),
      deletes: unsupported('Discord deletion is intentionally out of scope for the proof adapter.', 'Leave prior messages intact and send corrections.'),
      fallbackBehavior: supported('Structured messages degrade to shared Markdown/plain text and rich-send failures retry the fallback.'),
    },
    fallback: {
      order: rich ? ['rich', 'markdown', 'plainText'] : ['markdown', 'plainText'],
      maxChars: 2000,
      semantics: [
        'Keep Discord private-alpha scoped and avoid Discord-only product behavior.',
        'Typed commands, component payloads, and fallbacks must resolve to the same Gateway command handlers.',
      ],
    },
    onboarding: {
      modes: ['webhook', 'providerManaged'],
      states: ['not_configured', 'credentials_needed', 'provider_connected', 'webhook_needed', 'verification_pending', 'trusted_target_pending', 'bound', 'ready', 'degraded', 'blocked'],
      actions: CHANNEL_ONBOARDING_ACTIONS,
      credentials: [
        {
          key: 'discord_alpha_enabled',
          label: 'Discord alpha enablement',
          source: 'config',
          secret: false,
          env: 'OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED',
          configKey: 'channels.discord.enabled',
          summary: 'Explicit local opt-in required before the private-alpha adapter starts.',
        },
        {
          key: 'discord_bot_token',
          label: 'Discord bot token',
          source: 'providerConsole',
          secret: true,
          env: 'DISCORD_BOT_TOKEN',
          configKey: 'channels.discord.botToken',
          summary: 'Bot token used for outbound sends.',
        },
        {
          key: 'discord_public_key',
          label: 'Discord public key',
          source: 'providerConsole',
          secret: false,
          env: 'DISCORD_PUBLIC_KEY',
          configKey: 'channels.discord.publicKey',
          summary: 'Application public key used to verify signed interaction webhooks.',
        },
      ],
      webhook: {
        routes: [
          { method: 'POST', path: '/webhooks/discord', purpose: 'Signed Discord interactions.' },
        ],
        signature: 'supported',
        publicExposure: 'Expose only /webhooks/discord through a tunnel or authenticated reverse proxy; keep other routes local or capability-protected.',
      },
      trust: {
        summary: 'Gateway trusts explicit Discord channel or channel/thread targets after signed interaction verification.',
        allowlistConfigKey: 'security.channelAllowlists.discord',
        targetIdRedaction: 'required',
        modes: [
          { mode: 'manualAllowlist', status: 'supported', summary: 'Operators can configure trusted channel/thread IDs directly.' },
          { mode: 'claimCode', status: 'supported', summary: 'Operators can claim trusted channel setup without raw ID copying.', fallback: 'Use manual allowlist when claim delivery is unavailable.' },
          { mode: 'providerInstall', status: 'planned', summary: 'Provider app installation can guide future setup but does not replace Gateway target trust.', fallback: 'Use alpha manual setup.' },
        ],
      },
      diagnostics: [
        diagnostic('provider_disabled', 'not_configured', 'warning', 'Discord alpha adapter is disabled.', 'Set channels.discord.enabled or OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED only for a controlled alpha workspace.'),
        diagnostic('missing_credentials', 'credentials_needed', 'blocked', 'Discord bot token or public key is missing.', 'Configure DISCORD_BOT_TOKEN and DISCORD_PUBLIC_KEY before using Discord.'),
        diagnostic('callback_url_missing', 'webhook_needed', 'blocked', 'Discord interaction webhook route is not exposed to Discord.', 'Expose only POST /webhooks/discord through the provider callback URL.'),
        diagnostic('signature_verification_missing', 'verification_pending', 'blocked', 'Discord public key is missing, so interactions cannot be verified.', 'Configure DISCORD_PUBLIC_KEY before accepting interactions.'),
        diagnostic('missing_allowlist', 'trusted_target_pending', 'blocked', 'No trusted Discord channel/thread target is configured.', 'Run opencode-gateway channel claim discord or add security.channelAllowlists.discord.'),
        diagnostic('binding_missing', 'trusted_target_pending', 'warning', 'Trusted Discord target is not bound to a Session or Project.', 'Run /project bind or /bind session from the trusted target.'),
      ],
    },
    notes: enabled ? ['Private alpha adapter; enable explicitly before use.'] : ['Disabled until channels.discord.enabled or OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED is true.'],
  })
}

export const DISCORD_ALPHA_CAPABILITIES = discordAdapterCapabilities({ enabled: true })

export const CHANNEL_CAPABILITY_REGISTRY: Record<string, ChannelCapabilities> = {
  telegram: telegramAdapterCapabilities(),
  whatsapp: WHATSAPP_CAPABILITIES,
  discord: DISCORD_ALPHA_CAPABILITIES,
}

function completeCapabilityMatrix(input: MatrixInput): ChannelCapabilityMatrix {
  const entries = CHANNEL_ADAPTER_CAPABILITY_KEYS.map(capability => [
    capability,
    input[capability] || unsupported('Not declared for this channel surface.', 'Use deterministic plain text fallback.'),
  ])
  return Object.fromEntries(entries) as ChannelCapabilityMatrix
}

function supported(summary: string, fallback?: string): ChannelCapabilityDefinition {
  return { status: 'supported', summary, ...(fallback ? { fallback } : {}) }
}

function partial(summary: string, fallback?: string): ChannelCapabilityDefinition {
  return { status: 'partial', summary, ...(fallback ? { fallback } : {}) }
}

function unsupported(summary: string, fallback?: string): ChannelCapabilityDefinition {
  return { status: 'unsupported', summary, ...(fallback ? { fallback } : {}) }
}

function diagnostic(
  code: ChannelSetupDiagnosticCode,
  state: ChannelConnectorState,
  severity: ChannelSetupDiagnosticSeverity,
  summary: string,
  remediation: string,
): ChannelSetupDiagnosticDefinition {
  return { code, state, severity, summary, remediation }
}

function asChannelCapabilities(capabilities: ChannelCapabilities | ChannelRenderCapabilities | undefined): ChannelCapabilities | undefined {
  return capabilities && typeof (capabilities as ChannelCapabilities).provider === 'string' && (capabilities as ChannelCapabilities).categories
    ? capabilities as ChannelCapabilities
    : undefined
}
