import { buildChannelConnectorRegistry, type ChannelConnectorRegistry, type ChannelConnectorStatus } from './channel-connectors.js'
import { createChannelClaimCode } from './channel-claims.js'
import { getChannelCapabilities, type ChannelOnboardingAction } from './channels/capabilities.js'

export interface ChannelCommandResult {
  output: string
  exitCode: number
}

export interface ChannelCommandOptions {
  registry?: ChannelConnectorRegistry
}

const ACTION_SEQUENCE: ChannelOnboardingAction[] = ['connect', 'verify', 'trust', 'bind']

export function runChannelCommand(args: string[] = process.argv.slice(3)): void {
  const result = formatChannelCommand(args)
  console.log(result.output)
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

export function formatChannelCommand(args: string[], options: ChannelCommandOptions = {}): ChannelCommandResult {
  const registry = options.registry || buildChannelConnectorRegistry()
  const sub = args[0] || 'help'
  if (sub === 'help' || sub === '--help' || sub === '-h') return ok(channelUsage())
  if (sub === 'list') return ok(formatChannelList(registry, args))

  if (sub === 'status') {
    const provider = providerArg(args, 1)
    if (!provider) return ok(formatChannelList(registry, args))
    return withConnector(registry, provider, connector => ok(formatChannelStatus(connector, args)))
  }

  if (sub === 'setup') return providerCommand(registry, args, formatChannelSetup)
  if (sub === 'verify') return providerCommand(registry, args, formatChannelVerify)
  if (sub === 'trust') return providerCommand(registry, args, formatChannelTrust)
  if (sub === 'claim') return formatChannelClaim(args)
  if (sub === 'repair') return providerCommand(registry, args, formatChannelRepair)

  return fail(`Unknown channel command: ${sub}\n\n${channelUsage()}`)
}

function providerCommand(
  registry: ChannelConnectorRegistry,
  args: string[],
  formatter: (connector: ChannelConnectorStatus, args: string[]) => string,
): ChannelCommandResult {
  const provider = providerArg(args, 1)
  if (!provider) return fail(`Missing provider.\n\n${channelUsage()}`)
  return withConnector(registry, provider, connector => ok(formatter(connector, args)))
}

function withConnector(
  registry: ChannelConnectorRegistry,
  provider: string,
  run: (connector: ChannelConnectorStatus) => ChannelCommandResult,
): ChannelCommandResult {
  const connector = registry.connectors.find(row => row.provider === provider)
  if (!connector) {
    const providers = registry.connectors.map(row => row.provider).join(', ')
    return fail(`Unknown channel provider: ${provider}\nKnown providers: ${providers}`)
  }
  return run(connector)
}

function formatChannelList(registry: ChannelConnectorRegistry, args: string[]): string {
  if (hasArg(args, '--json')) return JSON.stringify({ connectorRegistry: registry, connectors: registry.connectors }, null, 2)
  const rows = registry.connectors.map(connector => {
    const next = connector.nextActions.length ? connector.nextActions.join(', ') : 'none'
    return `- ${connector.provider.padEnd(8)} ${connector.state.padEnd(23)} ${next}`
  })
  return [
    'Channel connectors',
    `Generated: ${registry.generatedAt}`,
    '',
    'Provider  State                   Next actions',
    ...rows,
    '',
    'Next: opencode-gateway channel status <provider>',
  ].join('\n')
}

function formatChannelStatus(connector: ChannelConnectorStatus, args: string[]): string {
  if (hasArg(args, '--json')) return JSON.stringify({ connector }, null, 2)
  const flow = connector.onboardingFlow
  const lines = [
    `${connector.displayName} channel`,
    `Provider: ${connector.provider}`,
    `State: ${connector.state} - ${connector.stateSummary}`,
    `Stage: ${connector.stage}`,
    `Modes: ${connector.modes.join(', ') || 'none'}`,
    connector.setupPaths.length ? `Setup path: ${activeSetupPathLabel(connector)}` : '',
    `Enabled: ${yesNo(connector.enabled)}`,
    `Configured: ${yesNo(connector.configured)}`,
    `Trusted target: ${yesNo(connector.trusted)}${connector.unsafeAllowAll ? ' (unsafe allow-all enabled)' : ''}`,
    `Bindings: ${connector.bindingCount}`,
    `Next actions: ${formatActions(connector)}`,
    `Current setup step: ${flow.primaryAction.label}`,
    `Primary action: ${flow.primaryAction.summary}${flow.primaryAction.command ? ` (${flow.primaryAction.command})` : ''}`,
  ]
  lines.push('', ...credentialLines(connector))
  lines.push('', ...callbackLines(connector))
  lines.push('', ...missingLines(connector))
  lines.push('', ...diagnosticLines(connector))
  lines.push('', ...evidenceLines(connector))
  lines.push('', `Next: ${nextCommand(connector)}`)
  return compactBlankLines(lines).join('\n')
}

function formatChannelSetup(connector: ChannelConnectorStatus, args: string[]): string {
  if (hasArg(args, '--json')) return JSON.stringify({ connector, setup: connector.onboardingFlow }, null, 2)
  const flow = connector.onboardingFlow
  const lines = [
    `${connector.displayName} setup`,
    `Current state: ${connector.state} - ${connector.stateSummary}`,
    `Universal path: ${flow.path.map(capitalize).join(' -> ')}`,
    `Current step: ${flow.primaryAction.label}`,
    `Primary action: ${flow.primaryAction.summary}${flow.primaryAction.command ? ` (${flow.primaryAction.command})` : ''}`,
    flow.fallbackAction ? `Fallback action: ${flow.fallbackAction.summary}${flow.fallbackAction.command ? ` (${flow.fallbackAction.command})` : ''}` : '',
    '',
    'Guided checklist',
    ...flow.steps.map(formatFlowStep),
    '',
    ...setupPathLines(connector),
    '',
    '1. Connect',
    ...connectGuidance(connector),
    '',
    '2. Verify',
    ...verifyGuidance(connector),
    '',
    '3. Trust',
    ...trustGuidance(connector),
    '',
    '4. Bind',
    ...bindGuidance(connector),
    '',
    `Next safe action: ${nextCommand(connector)}`,
  ]
  return compactBlankLines(lines).join('\n')
}

function formatChannelVerify(connector: ChannelConnectorStatus, args: string[]): string {
  if (hasArg(args, '--json')) return JSON.stringify({ connector, verification: verificationSummary(connector) }, null, 2)
  return compactBlankLines([
    `${connector.displayName} verification`,
    'Mode: local config and route readiness only. No provider messages are sent.',
    '',
    ...credentialLines(connector),
    '',
    ...callbackLines(connector),
    '',
    ...diagnosticLines(connector, ['missing_credentials', 'callback_url_missing', 'verify_token_mismatch', 'signature_verification_missing', 'provider_disabled']),
    '',
    `Result: ${verificationResult(connector)}`,
    `Next: ${connector.nextActions.includes('verify') ? `opencode-gateway channel verify ${connector.provider}` : nextCommand(connector)}`,
  ]).join('\n')
}

function formatChannelTrust(connector: ChannelConnectorStatus, args: string[]): string {
  if (hasArg(args, '--json')) return JSON.stringify({ connector, trust: trustSummary(connector) }, null, 2)
  return compactBlankLines([
    `${connector.displayName} trust`,
    ...trustGuidance(connector),
    '',
    `Trusted target configured: ${yesNo(connector.trusted)}`,
    connector.unsafeAllowAll ? `Warning: replace unsafe allow-all with ${allowlistKey(connector) || 'an explicit allowlist'} before production use.` : '',
    `Next: ${connector.nextActions.includes('trust') ? `opencode-gateway channel trust ${connector.provider}` : nextCommand(connector)}`,
  ]).join('\n')
}

function formatChannelClaim(args: string[]): ChannelCommandResult {
  const provider = providerArg(args, 1)
  if (!provider) return fail(`Missing provider.\n\n${channelUsage()}`)
  const action = claimActionArg(args)
  if (!action) return fail(`Unsupported claim action. Use trust_target or prove_denial.\n\n${channelUsage()}`)
  try {
    const result = createChannelClaimCode({
      provider,
      action,
      ttlMs: ttlArg(args),
      createdBy: actorArg(args) || 'channel-cli',
    })
    if (hasArg(args, '--json')) return ok(JSON.stringify({ claim: result.claim, code: result.code, instructions: result.instructions }, null, 2))
    const isDenialProbe = action === 'prove_denial'
    return ok([
      isDenialProbe ? `${provider} denial probe code` : `${provider} claim code`,
      `Code: ${result.code}`,
      `Expires: ${result.claim.expiresAt}`,
      '',
      result.instructions,
      isDenialProbe
        ? 'This command never prints the channel target ID. The target is not trusted; only a redacted denied-inbound proof is recorded.'
        : 'This command never prints the channel target ID. The target is trusted only after the code is sent from that provider channel.',
    ].join('\n'))
  } catch (err: any) {
    return fail(`Could not create claim code: ${err?.message || err}`)
  }
}

function formatChannelRepair(connector: ChannelConnectorStatus, args: string[]): string {
  if (hasArg(args, '--json')) return JSON.stringify({ connector, repairs: connector.missingPrerequisites }, null, 2)
  return compactBlankLines([
    `${connector.displayName} repair`,
    `State: ${connector.state} - ${connector.stateSummary}`,
    '',
    ...missingLines(connector),
    '',
    ...diagnosticLines(connector),
    '',
    `Next: ${nextCommand(connector)}`,
  ]).join('\n')
}

function formatFlowStep(step: ChannelConnectorStatus['onboardingFlow']['steps'][number]): string {
  const command = step.primaryAction.command ? ` Command: ${step.primaryAction.command}.` : ''
  const blockers = step.blockers.length ? ` Blockers: ${step.blockers.join(', ')}.` : ''
  return `- [${step.status}] ${step.label}: ${step.summary} Next: ${trimSentence(step.primaryAction.summary)}.${command}${blockers}`
}

function trimSentence(value: string): string {
  return value.replace(/\.+$/g, '')
}

function verificationSummary(connector: ChannelConnectorStatus): Record<string, unknown> {
  return {
    credentials: connector.credentials.map(credential => ({ key: credential.key, configured: credential.configured, env: credential.env, configKey: credential.configKey, secret: credential.secret })),
    callback: connector.callback,
    result: verificationResult(connector),
  }
}

function trustSummary(connector: ChannelConnectorStatus): Record<string, unknown> {
  return {
    trusted: connector.trusted,
    unsafeAllowAll: connector.unsafeAllowAll,
    allowlistConfigKey: allowlistKey(connector),
    guidance: trustGuidance(connector),
  }
}

function connectGuidance(connector: ChannelConnectorStatus): string[] {
  if (connector.provider === 'whatsapp') {
    return [
      '- Use Cloud API direct setup for live local operation.',
      '- Access token: Meta for Developers -> WhatsApp -> API Setup, or a permanent system-user token. Store in WHATSAPP_ACCESS_TOKEN or channels.whatsapp.accessToken.',
      '- Phone number ID: Meta WhatsApp API Setup -> From phone number ID. Store in WHATSAPP_PHONE_NUMBER_ID or channels.whatsapp.phoneNumberId.',
      '- Verify token: generate a local random value and enter the same value in Meta webhook verification. Store in WHATSAPP_VERIFY_TOKEN or channels.whatsapp.verifyToken.',
      '- App secret: Meta app Basic settings -> App secret. Store in WHATSAPP_APP_SECRET or channels.whatsapp.appSecret.',
      '- Values are never printed by this command; only presence, env names, and config keys are shown.',
      ...credentialPresence(connector),
    ]
  }
  if (connector.provider === 'telegram') {
    return [
      '- Create or reuse a bot with BotFather.',
      '- Store the bot token in TELEGRAM_BOT_TOKEN or channels.telegram.botToken.',
      '- Values are never printed by this command; only presence, env names, and config keys are shown.',
      ...credentialPresence(connector),
    ]
  }
  if (connector.provider === 'discord') {
    return [
      '- Discord is private alpha. Enable only in a controlled workspace with channels.discord.enabled or OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED=true.',
      '- Store bot token in DISCORD_BOT_TOKEN or channels.discord.botToken.',
      '- Store application public key in DISCORD_PUBLIC_KEY or channels.discord.publicKey.',
      '- Values are never printed by this command; only presence, env names, and config keys are shown.',
      ...credentialPresence(connector),
    ]
  }
  return [
    `- ${connector.displayName} is a local surface. No provider credential setup is required.`,
    `- Use bindings to connect the local ${connector.provider} surface to a Gateway Session, Issue, or Project.`,
  ]
}

function verifyGuidance(connector: ChannelConnectorStatus): string[] {
  if (!connector.callback.required) {
    if (connector.provider === 'telegram') return ['- Telegram uses polling. Verify by confirming the bot token is present and the daemon can start polling without auth errors.']
    return ['- No provider webhook is required. Verify local Session continuity and bindings.']
  }
  const routeText = connector.callback.routes.map(route => `${route.method} ${route.path}`).join(', ')
  const lines = [
    `- Webhook URL: expose only ${routeText} through the provider callback URL.`,
    `- Current route exposure: ${connector.callback.routeExposure}.`,
    `- Challenge status: ${connector.callback.challenge}.`,
    `- Signature status: ${connector.callback.signature}.`,
    '- Keep the dashboard, MCP, health, and other Gateway routes local or capability-protected.',
  ]
  if (connector.provider === 'whatsapp') {
    lines.unshift('- In Meta Webhooks, subscribe the WhatsApp callback URL ending in /webhooks/whatsapp.')
  }
  return lines
}

function trustGuidance(connector: ChannelConnectorStatus): string[] {
  const key = allowlistKey(connector)
  if (!key) return [`- ${connector.displayName} trusts the local operator/Session boundary; no raw external target ID is needed.`]
  return [
    `- Generate a short-lived claim code with opencode-gateway channel claim ${connector.provider}, then send it from the provider target to trust.`,
    `- Manual fallback: add explicit trusted targets to ${key}.`,
    connector.provider === 'whatsapp'
      ? '- Trusted sender means the WhatsApp sender/account target that should be allowed to mutate Gateway state.'
      : `- Trusted target means the stable ${connector.displayName} chat/channel/thread target that should be allowed to mutate Gateway state.`,
  ]
}

function bindGuidance(_connector: ChannelConnectorStatus): string[] {
  return [
    '- From a trusted target, bind context with the channel commands already supported by Gateway, such as /project bind or /bind session.',
    '- The binding should connect the channel target to a Gateway Session, Issue, or Project.',
  ]
}

function credentialLines(connector: ChannelConnectorStatus): string[] {
  if (!connector.credentials.length) return ['Credentials: none required']
  return [
    'Credentials:',
    ...connector.credentials.map(credential => {
      const sources = [
        credential.env ? `env ${credential.env}` : '',
        credential.configKey ? `config ${credential.configKey}` : '',
      ].filter(Boolean).join(' or ')
      return `- ${credential.label}: ${credential.configured ? 'present' : 'missing'} (${sources || credential.key}; ${credential.secret ? 'secret' : 'non-secret'})`
    }),
  ]
}

function setupPathLines(connector: ChannelConnectorStatus): string[] {
  if (!connector.setupPaths.length) return ['Setup options: use the connector modes listed above.']
  return [
    'Setup options:',
    ...connector.setupPaths.map(path => {
      const active = path.active ? 'active, ' : ''
      const configured = path.configured ? 'configured' : 'not configured'
      const availability = path.available ? 'available' : path.implementationStatus
      const refs = [...path.env, ...path.configKeys].slice(0, 5).join(', ')
      return `- ${path.label}: ${active}${availability}, ${configured}, state ${path.state}. ${path.summary}${refs ? ` Refs: ${refs}.` : ''}`
    }),
  ]
}

function activeSetupPathLabel(connector: ChannelConnectorStatus): string {
  const active = connector.setupPaths.find(path => path.active)
  if (!active) return 'none selected'
  return `${active.label} (${active.implementationStatus}, ${active.state})`
}

function credentialPresence(connector: ChannelConnectorStatus): string[] {
  return connector.credentials.map(credential => `- Current ${credential.label}: ${credential.configured ? 'present' : 'missing'} (${credential.env || credential.configKey || credential.key}).`)
}

function callbackLines(connector: ChannelConnectorStatus): string[] {
  if (!connector.callback.required) return ['Callback: not required']
  return [
    'Callback:',
    `- Verifier: ${connector.callback.verifier.state}`,
    `- Route exposure: ${connector.callback.routeExposure}`,
    `- Public webhook mode: ${yesNo(connector.callback.publicWebhookMode)}`,
    `- Public routes only: ${yesNo(connector.callback.verifier.publicWebhookRoutesOnly)}`,
    `- Non-webhook routes protected: ${yesNo(connector.callback.verifier.nonWebhookRoutesProtected)}`,
    `- HTTP capability tokens: ${connector.callback.verifier.httpAuthConfigured ? connector.callback.verifier.httpAuthCapabilities.join(', ') || 'configured' : 'none'}`,
    `- Webhook-capable HTTP token: ${yesNo(connector.callback.verifier.httpWebhookAuthConfigured)}`,
    `- Challenge: ${connector.callback.challenge}`,
    `- Signature: ${connector.callback.signature}`,
    ...connector.callback.routeChecks.map(route => `- ${route.method} ${route.path}: ${route.documentedPublicRoute ? 'documented' : 'missing'}; ${route.publicWebhookExempt ? 'public webhook exempt' : 'not public-exempt'}; ${route.purpose}`),
    ...connector.callback.verifier.issues
      .filter(issue => issue.severity !== 'info')
      .map(issue => `- ${issue.severity}: ${issue.code} - ${issue.summary}`),
  ]
}

function missingLines(connector: ChannelConnectorStatus): string[] {
  if (!connector.missingPrerequisites.length) return ['Missing prerequisites: none']
  return [
    'Missing prerequisites:',
    ...connector.missingPrerequisites.map(row => {
      const refs = [
        row.env ? `env ${row.env}` : '',
        row.configKey ? `config ${row.configKey}` : '',
      ].filter(Boolean).join(' or ')
      return `- ${row.label} (${row.kind}/${row.code}${refs ? `; ${refs}` : ''}): ${row.remediation}`
    }),
  ]
}

function diagnosticLines(connector: ChannelConnectorStatus, codes?: string[]): string[] {
  const diagnostics = codes ? connector.diagnostics.filter(row => codes.includes(row.code)) : connector.diagnostics
  if (!diagnostics.length) return ['Diagnostics: none']
  return [
    'Diagnostics:',
    ...diagnostics.map(row => `- [${row.severity}] ${row.code}: ${row.summary} Next: ${row.remediation}`),
  ]
}

function evidenceLines(connector: ChannelConnectorStatus): string[] {
  return [
    `Evidence refs: ${connector.evidenceRefs.length ? connector.evidenceRefs.join(', ') : 'none'}`,
  ]
}

function verificationResult(connector: ChannelConnectorStatus): string {
  const blockers: string[] = []
  if (!connector.enabled) blockers.push('provider is disabled')
  if (connector.credentials.some(credential => !credential.configured && credential.key !== 'discord_alpha_enabled')) blockers.push('required credentials are missing')
  if (connector.callback.required && connector.callback.routeExposure === 'local_only') blockers.push('webhook route is not exposed')
  if (connector.callback.challenge === 'missing' || connector.callback.signature === 'missing') blockers.push('challenge or signature verification is incomplete')
  return blockers.length ? `blocked - ${blockers.join('; ')}` : 'pass - local readiness checks are satisfied'
}

function nextCommand(connector: ChannelConnectorStatus): string {
  const preferred = connector.nextActions.find(action => ACTION_SEQUENCE.includes(action)) || connector.nextActions[0] || 'status'
  if (preferred === 'connect') return `opencode-gateway channel setup ${connector.provider}`
  if (preferred === 'repair') return `opencode-gateway channel repair ${connector.provider}`
  if (preferred === 'disconnect') return `review config before disabling ${connector.provider}`
  return `opencode-gateway channel ${preferred} ${connector.provider}`
}

function allowlistKey(connector: ChannelConnectorStatus): string | undefined {
  return connector.missingPrerequisites.find(row => row.kind === 'trust')?.configKey
    || getChannelCapabilities(connector.provider)?.onboarding.trust.allowlistConfigKey
}

function formatActions(connector: ChannelConnectorStatus): string {
  return connector.nextActions.length ? connector.nextActions.join(', ') : 'none'
}

function providerArg(args: string[], index: number): string | undefined {
  for (let i = index; i < args.length; i++) {
    const value = args[i]
    if (value && !value.startsWith('--')) return value
  }
  return undefined
}

function hasArg(args: string[], name: string): boolean {
  return args.includes(name)
}

function ttlArg(args: string[]): number | undefined {
  const index = args.findIndex(arg => arg === '--ttl' || arg === '--ttl-ms')
  if (index === -1) return undefined
  const raw = args[index + 1]
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return args[index] === '--ttl-ms' ? Number(raw) : Number(raw) * 1000
  const match = /^(\d+)(ms|s|m)$/i.exec(raw)
  if (!match) return undefined
  const value = Number(match[1])
  const unit = match[2]!.toLowerCase()
  if (unit === 'ms') return value
  if (unit === 's') return value * 1000
  return value * 60 * 1000
}

function claimActionArg(args: string[]): 'trust_target' | 'prove_denial' | undefined {
  if (hasArg(args, '--prove-denial') || hasArg(args, '--prove_denial')) return 'prove_denial'
  const raw = flagValue(args, '--action')
  if (!raw) return 'trust_target'
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_')
  if (normalized === 'trust_target' || normalized === 'prove_denial') return normalized
  return undefined
}

function actorArg(args: string[]): string | undefined {
  const index = args.findIndex(arg => arg === '--actor')
  return index === -1 ? undefined : args[index + 1]
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.findIndex(arg => arg === name)
  if (index === -1) return undefined
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function ok(output: string): ChannelCommandResult {
  return { output, exitCode: 0 }
}

function fail(output: string): ChannelCommandResult {
  return { output, exitCode: 1 }
}

function compactBlankLines(lines: string[]): string[] {
  const compacted: string[] = []
  for (const line of lines.filter(line => line !== undefined && line !== null)) {
    const text = String(line)
    if (!text && compacted[compacted.length - 1] === '') continue
    compacted.push(text)
  }
  while (compacted[compacted.length - 1] === '') compacted.pop()
  return compacted
}

function channelUsage(): string {
  return `Usage: opencode-gateway channel <command>

Commands:
  channel list                         List connector lifecycle states
  channel status [provider] [--json]   Show redacted connector status
  channel setup <provider>             Show the Connect -> Verify -> Trust -> Bind setup guide
  channel verify <provider>            Check local config completeness and webhook route readiness
  channel trust <provider>             Show trusted-target setup guidance
  channel claim <provider> [--ttl 10m] [--prove-denial]
                                       Generate a short-lived trust claim or one-shot denial proof code
  channel repair <provider>            Show redacted diagnostics and safe repair actions

Providers: telegram, whatsapp, discord`
}
