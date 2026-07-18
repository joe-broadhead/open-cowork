import type { GatewayConfig } from './config.js'
import type { ChannelCapabilities, ChannelWebhookRouteRequirement } from './channels/capabilities.js'
import { extractHostname, evaluateHttpRequestSecurity, getHttpAuthPosture, isLocalHostname, publicWebhookRoutesForProvider, type HttpCapability } from './security.js'

export type WebhookVerificationStatus = 'ready' | 'missing' | 'unsupported' | 'not_applicable'
export type WebhookExposureMode = 'public_webhook_mode' | 'authenticated_reverse_proxy' | 'local_only' | 'unsafe_public' | 'not_applicable'
export type WebhookVerifierState = 'ready' | 'warning' | 'blocked' | 'not_applicable'
export type WebhookVerifierIssueCode =
  | 'webhook_url_missing'
  | 'webhook_route_missing'
  | 'verify_token_mismatch'
  | 'signature_verification_missing'
  | 'public_webhook_mode_enabled'
  | 'public_webhook_mode_disabled'
  | 'authenticated_reverse_proxy_mode'
  | 'local_only_mode'
  | 'no_http_capability_tokens'
  | 'webhook_http_token_missing'
  | 'unsafe_broad_exposure'

export interface WebhookVerifierCredential {
  key: string
  configured: boolean
}

export interface WebhookRouteVerification {
  method: ChannelWebhookRouteRequirement['method']
  path: string
  purpose: string
  documentedPublicRoute: boolean
  publicWebhookExempt: boolean
  requiredCapability: HttpCapability
}

export interface WebhookVerifierIssue {
  code: WebhookVerifierIssueCode
  severity: 'info' | 'warning' | 'blocked'
  summary: string
  remediation: string
}

export interface WebhookVerificationResult {
  provider: string
  required: boolean
  state: WebhookVerifierState
  exposureMode: WebhookExposureMode
  publicWebhookMode: boolean
  publicWebhookRoutesOnly: boolean
  nonWebhookRoutesProtected: boolean
  httpAuthConfigured: boolean
  httpWebhookAuthConfigured: boolean
  httpAuthCapabilities: HttpCapability[]
  routes: WebhookRouteVerification[]
  challenge: WebhookVerificationStatus
  signature: WebhookVerificationStatus
  issues: WebhookVerifierIssue[]
}

export function verifyChannelWebhookExposure(
  capability: ChannelCapabilities,
  config: GatewayConfig,
  credentials: WebhookVerifierCredential[] = [],
): WebhookVerificationResult {
  const webhook = capability.onboarding.webhook
  const auth = getHttpAuthPosture()
  if (!webhook) {
    return {
      provider: capability.provider,
      required: false,
      state: 'not_applicable',
      exposureMode: 'not_applicable',
      publicWebhookMode: config.security.publicWebhookMode,
      publicWebhookRoutesOnly: true,
      nonWebhookRoutesProtected: nonWebhookRoutesProtected(config),
      httpAuthConfigured: auth.configured,
      httpWebhookAuthConfigured: webhookAuthConfigured(auth.capabilities),
      httpAuthCapabilities: auth.capabilities,
      routes: [],
      challenge: 'not_applicable',
      signature: 'not_applicable',
      issues: [],
    }
  }

  const routes = webhook.routes.map(route => routeVerification(capability.provider, route))
  const challenge = webhook.challenge ? challengeStatus(capability.provider, credentials) : 'not_applicable'
  const signature = webhook.signature === 'unsupported' ? 'unsupported' : signatureStatus(capability.provider, credentials)
  const exposureMode = resolveExposureMode(config, auth.configured)
  const webhookAuth = webhookAuthConfigured(auth.capabilities)
  const routesOnly = routes.every(route => route.documentedPublicRoute && route.publicWebhookExempt)
  const protectedNonWebhook = nonWebhookRoutesProtected(config)
  const issues = verifierIssues({
    capability,
    exposureMode,
    routes,
    challenge,
    signature,
    routesOnly,
    protectedNonWebhook,
    authConfigured: auth.configured,
    webhookAuthConfigured: webhookAuth,
  })
  const state = issues.some(issue => issue.severity === 'blocked')
    ? 'blocked'
    : issues.some(issue => issue.severity === 'warning')
      ? 'warning'
      : 'ready'

  return {
    provider: capability.provider,
    required: true,
    state,
    exposureMode,
    publicWebhookMode: config.security.publicWebhookMode,
    publicWebhookRoutesOnly: routesOnly,
    nonWebhookRoutesProtected: protectedNonWebhook,
    httpAuthConfigured: auth.configured,
    httpWebhookAuthConfigured: webhookAuth,
    httpAuthCapabilities: auth.capabilities,
    routes,
    challenge,
    signature,
    issues,
  }
}

function routeVerification(provider: string, route: ChannelWebhookRouteRequirement): WebhookRouteVerification {
  const documented = publicWebhookRoutesForProvider(provider).some(publicRoute => publicRoute.method === route.method && publicRoute.path === route.path)
  return {
    method: route.method,
    path: route.path,
    purpose: route.purpose,
    documentedPublicRoute: documented,
    publicWebhookExempt: documented,
    requiredCapability: 'webhook',
  }
}

function resolveExposureMode(config: GatewayConfig, authConfigured: boolean): WebhookExposureMode {
  if (config.security.unsafeAllowNoAuth && config.security.allowNonLocalHttp) return 'unsafe_public'
  if (config.security.publicWebhookMode) return 'public_webhook_mode'
  if (config.security.allowNonLocalHttp && authConfigured) return 'authenticated_reverse_proxy'
  return 'local_only'
}

function challengeStatus(provider: string, credentials: WebhookVerifierCredential[]): WebhookVerificationStatus {
  if (provider === 'whatsapp') return hasCredential(credentials, 'whatsapp_verify_token') ? 'ready' : 'missing'
  if (provider === 'discord') return 'not_applicable'
  return 'not_applicable'
}

function signatureStatus(provider: string, credentials: WebhookVerifierCredential[]): WebhookVerificationStatus {
  if (provider === 'whatsapp') return hasCredential(credentials, 'whatsapp_app_secret') ? 'ready' : 'missing'
  if (provider === 'discord') return hasCredential(credentials, 'discord_public_key') ? 'ready' : 'missing'
  return 'not_applicable'
}

function hasCredential(credentials: WebhookVerifierCredential[], key: string): boolean {
  return credentials.some(credential => credential.key === key && credential.configured)
}

function verifierIssues(input: {
  capability: ChannelCapabilities
  exposureMode: WebhookExposureMode
  routes: WebhookRouteVerification[]
  challenge: WebhookVerificationStatus
  signature: WebhookVerificationStatus
  routesOnly: boolean
  protectedNonWebhook: boolean
  authConfigured: boolean
  webhookAuthConfigured: boolean
}): WebhookVerifierIssue[] {
  const issues: WebhookVerifierIssue[] = []
  const display = input.capability.displayName
  const routeText = input.routes.map(route => `${route.method} ${route.path}`).join(', ')

  for (const route of input.routes.filter(route => !route.documentedPublicRoute)) {
    issues.push({
      code: 'webhook_route_missing',
      severity: 'blocked',
      summary: `${display} expected webhook route is not in the documented public webhook allowlist.`,
      remediation: `Register only the documented ${route.method} ${route.path} webhook route before exposing provider traffic.`,
    })
  }

  if (input.exposureMode === 'local_only') {
    issues.push({
      code: 'webhook_url_missing',
      severity: 'blocked',
      summary: `${display} webhook traffic is local-only; no provider callback URL is exposed.`,
      remediation: `Expose only ${routeText} through a provider callback tunnel or use an authenticated reverse proxy.`,
    })
    issues.push({
      code: 'local_only_mode',
      severity: 'info',
      summary: 'Gateway is in local-only HTTP mode.',
      remediation: 'Keep this mode unless a provider webhook callback must reach this daemon.',
    })
  } else if (input.exposureMode === 'public_webhook_mode') {
    issues.push({
      code: 'public_webhook_mode_enabled',
      severity: 'info',
      summary: 'Public webhook mode is enabled for documented provider webhook routes only.',
      remediation: 'Keep admin, operator, dashboard, assets, and other routes behind normal Gateway HTTP capabilities.',
    })
  } else if (input.exposureMode === 'authenticated_reverse_proxy') {
    issues.push({
      code: 'authenticated_reverse_proxy_mode',
      severity: 'info',
      summary: 'Gateway is configured for authenticated non-local HTTP access.',
      remediation: 'Use a webhook-capable Gateway HTTP token or an authenticating reverse proxy that forwards only provider webhook routes.',
    })
    if (!input.webhookAuthConfigured) {
      issues.push({
        code: 'webhook_http_token_missing',
        severity: 'blocked',
        summary: 'Authenticated webhook ingress is missing a Gateway token that can satisfy the webhook route capability.',
        remediation: 'Configure OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN or OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN, or keep the provider route behind an authenticating proxy that supplies one.',
      })
    }
  } else if (input.exposureMode === 'unsafe_public') {
    issues.push({
      code: 'unsafe_broad_exposure',
      severity: 'blocked',
      summary: 'Unsafe unauthenticated exposed HTTP mode is enabled.',
      remediation: 'Disable security.unsafeAllowNoAuth and expose only documented webhook routes or require scoped Gateway HTTP tokens.',
    })
  }

  if (input.exposureMode !== 'public_webhook_mode') {
    issues.push({
      code: 'public_webhook_mode_disabled',
      severity: 'info',
      summary: 'Public webhook mode is disabled.',
      remediation: 'Use authenticated reverse proxy mode or enable public webhook mode only for documented webhook routes.',
    })
  }

  if (input.challenge === 'missing') {
    issues.push({
      code: 'verify_token_mismatch',
      severity: 'blocked',
      summary: `${display} webhook challenge cannot pass because the local verify credential is missing or mismatched.`,
      remediation: `Configure the provider challenge value locally, then retry verification against ${routeText}.`,
    })
  }

  if (input.signature === 'missing') {
    issues.push({
      code: 'signature_verification_missing',
      severity: 'blocked',
      summary: `${display} inbound POST signatures cannot be verified.`,
      remediation: 'Configure the provider signing secret or public key before accepting inbound POST webhooks.',
    })
  }

  if (!input.routesOnly || !input.protectedNonWebhook) {
    issues.push({
      code: 'unsafe_broad_exposure',
      severity: 'blocked',
      summary: 'Webhook setup would expose non-webhook Gateway routes.',
      remediation: `Restrict unauthenticated public access to ${routeText}; admin, operator, dashboard, asset, and storage routes must stay capability-protected.`,
    })
  }

  if (input.exposureMode !== 'local_only' && !input.authConfigured) {
    issues.push({
      code: 'no_http_capability_tokens',
      severity: 'warning',
      summary: 'No Gateway HTTP capability tokens are configured for this exposed context.',
      remediation: 'Configure scoped Gateway HTTP tokens for any non-webhook route that may be reachable outside localhost.',
    })
  }

  return dedupeIssues(issues)
}

function webhookAuthConfigured(capabilities: HttpCapability[]): boolean {
  return capabilities.includes('webhook') || capabilities.includes('admin')
}

function nonWebhookRoutesProtected(config: GatewayConfig): boolean {
  if (!config.security.allowNonLocalHttp && isLocalHostname(extractHostname(config.security.httpHost || '127.0.0.1'))) return true
  const remote = {
    host: 'gateway.example.com',
    origin: 'https://gateway.example.com',
    remoteAddress: '203.0.113.10',
  }
  const probes = [
    { method: 'GET', pathname: '/dashboard' },
    { method: 'POST', pathname: '/channels/send' },
    { method: 'PUT', pathname: '/opencode/tools/review-helper' },
    { method: 'POST', pathname: '/shutdown' },
  ]
  return probes.every(probe => !evaluateHttpRequestSecurity({ ...remote, ...probe }, config.security).allowed)
}

function dedupeIssues(issues: WebhookVerifierIssue[]): WebhookVerifierIssue[] {
  const seen = new Set<string>()
  return issues.filter(issue => {
    const key = `${issue.code}:${issue.summary}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
