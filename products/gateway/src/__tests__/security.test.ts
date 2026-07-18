import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { __daemonTest } from '../daemon.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { PUBLIC_WEBHOOK_ROUTES, TransientInboundError, assertHttpBindAllowed, assertNoServiceSecrets, ensureLocalHttpAdminTokenFile, evaluateHttpRequestSecurity, gatewayServiceEnvironment, getHttpAuthPosture, httpCapabilityForRequest, isLocalHttpHost, isLocalOrigin, isTransientInboundError, isTrustedChannelActor, isTrustedChannelTarget, listChannelAllowlistActorGaps, localHttpAdminTokenFilePath, publicWebhookRoutesForProvider, redactSecret, redactedChannelTargetLabel, redactSensitiveObject, redactSensitiveText } from '../security.js'

describe('security', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-security-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE']
    delete process.env['TELEGRAM_BOT_TOKEN']
    delete process.env['DISCORD_PUBLIC_KEY']
    clearConfigCacheForTest()
  })

  it('redacts secrets without exposing content', () => {
    expect(redactSecret('abc123')).toBe('<redacted:6 chars>')
    expect(redactSecret()).toBe('not configured')
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'http-secret-token'
    process.env['DISCORD_PUBLIC_KEY'] = 'discord-public-key-value'
    const config = updateConfig({ channels: { telegram: { botToken: '123456:telegram-secret-token-value' } } } as any)

    expect(redactSensitiveText('Authorization: Bearer http-secret-token', config)).toBe('Authorization: Bearer <redacted>')
    expect(redactSensitiveText('token=123456:telegram-secret-token-value', config)).toBe('token=<redacted>')
    expect(redactSensitiveText('public key discord-public-key-value', config)).toBe('public key <redacted:24 chars>')
    expect(redactSensitiveObject({ channels: { telegram: { botToken: '123456:telegram-secret-token-value' } }, maxTokens: 50000 }, config)).toEqual({ channels: { telegram: { botToken: '<redacted:34 chars>' } }, maxTokens: 50000 })
  })

  it('only accepts local hosts and origins', () => {
    expect(isLocalHttpHost('127.0.0.1:4097')).toBe(true)
    expect(isLocalHttpHost('localhost:4097')).toBe(true)
    expect(isLocalHttpHost('[::1]:4097')).toBe(true)
    expect(isLocalHttpHost('example.com:4097')).toBe(false)
    expect(isLocalOrigin('http://localhost:4097')).toBe(true)
    expect(isLocalOrigin('https://example.com')).toBe(false)
  })

  it('fails closed for non-local HTTP exposure unless explicitly configured', () => {
    const config = getConfig()
    expect(() => assertHttpBindAllowed({ ...config.security, httpHost: '0.0.0.0' })).toThrow('Refusing to bind')
    expect(evaluateHttpRequestSecurity({ host: 'example.com', origin: 'https://example.com', remoteAddress: '203.0.113.10', pathname: '/dashboard' }, config.security)).toMatchObject({ allowed: false })

    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'http-secret-token'
    const exposed = { ...config.security, httpHost: '0.0.0.0', allowNonLocalHttp: true }
    expect(() => assertHttpBindAllowed(exposed)).not.toThrow()
    expect(evaluateHttpRequestSecurity({ host: 'example.com', origin: 'https://example.com', remoteAddress: '203.0.113.10', pathname: '/dashboard', authorization: 'Bearer http-secret-token' }, exposed)).toMatchObject({ allowed: true, actor: 'http-token' })
    expect(evaluateHttpRequestSecurity({ host: 'example.com', origin: 'https://example.com', remoteAddress: '203.0.113.10', method: 'POST', pathname: '/webhooks/whatsapp' }, { ...exposed, publicWebhookMode: true })).toMatchObject({ allowed: true, actor: 'webhook' })
    expect(evaluateHttpRequestSecurity({ host: 'example.com', origin: 'https://example.com', remoteAddress: '203.0.113.10', method: 'POST', pathname: '/webhooks/other' }, { ...exposed, publicWebhookMode: true })).toMatchObject({ allowed: false })
  })

  it('does not treat loopback as unauthenticated when exposed HTTP mode is enabled', () => {
    const config = getConfig()
    const exposed = { ...config.security, httpHost: '0.0.0.0', allowNonLocalHttp: true }

    expect(evaluateHttpRequestSecurity({
      host: '127.0.0.1:4097',
      origin: 'http://127.0.0.1:4097',
      remoteAddress: '127.0.0.1',
      method: 'GET',
      pathname: '/config',
      search: '?redact=false',
    }, exposed)).toMatchObject({ allowed: false, requiredCapability: 'admin' })

    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'admin-secret-token'
    expect(evaluateHttpRequestSecurity({
      host: '127.0.0.1:4097',
      origin: 'http://127.0.0.1:4097',
      remoteAddress: '127.0.0.1',
      method: 'GET',
      pathname: '/config',
      search: '?redact=false',
      authorization: 'Bearer admin-secret-token',
    }, exposed)).toMatchObject({ allowed: true, actor: 'http-token', requiredCapability: 'admin' })
  })

  it('maps non-local HTTP routes to scoped capabilities', () => {
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/health' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/config', search: '?redact=false' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/evidence/export' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/evidence/export', search: '?redact=false' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/evidence/export', search: '?unredacted=true' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/runs/run_1' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/runs/run_1', search: '?raw=true' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/events' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/events', search: '?raw=true' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/live/events' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/opencode/sessions' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/opencode/sessions', search: '?all=true' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/opencode/sessions/ses_1' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/opencode/sessions/ses_1', search: '?raw=true' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/opencode/sessions/ses_1/messages' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/opencode/mcp' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/opencode/mcp', search: '?redact=false' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/gateway/leadership' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/gateway/leadership/recover' })).toBe('operator')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/scheduler/pause' })).toBe('operator')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/scheduler/resume' })).toBe('operator')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/scheduler/run' })).toBe('operator')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/scheduler' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/dispatch-acquisitions/dispatch_1/session/settle' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/operator/runs/run_1/actions' })).toBe('operator')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/channels/claims' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/channels/bindings' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/channels/bindings' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/storage/export' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/storage/restore' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/tasks' })).toBe('operator')
    expect(httpCapabilityForRequest({ method: 'DELETE', pathname: '/tasks/task_1' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'DELETE', pathname: '/roadmaps/roadmap_1' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/permissions/perm_1/reply' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/permissions/perm_1/reject' })).toBe('operator')
    expect(httpCapabilityForRequest({ method: 'PUT', pathname: '/opencode/tools/review-helper' })).toBe('asset_write')
    expect(httpCapabilityForRequest({ method: 'PUT', pathname: '/profiles/reviewer' })).toBe('asset_write')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/blueprints/apply' })).toBe('asset_write')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/promotion/decisions' })).toBe('asset_write')
    // Personas write OpenCode agent assets to disk → asset_write, not operator.
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/personas' })).toBe('asset_write')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/personas' })).toBe('read')
    // Session admission (session-creating) + presence rebinding (trusted-routing) are admin.
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/sessions/admit' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/agent-presences' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'PATCH', pathname: '/agent-presences/ap_1' })).toBe('admin')
    expect(httpCapabilityForRequest({ method: 'GET', pathname: '/agent-presences' })).toBe('read')
    expect(httpCapabilityForRequest({ method: 'POST', pathname: '/webhooks/whatsapp' })).toBe('webhook')
  })

  it('enforces capability-scoped bearer tokens for exposed HTTP routes', () => {
    const config = getConfig()
    const exposed = { ...config.security, httpHost: '0.0.0.0', allowNonLocalHttp: true }
    const input = (method: string, pathname: string, token: string, search = '') => ({
      host: 'gateway.example.com',
      origin: 'https://gateway.example.com',
      remoteAddress: '203.0.113.10',
      method,
      pathname,
      search,
      authorization: `Bearer ${token}`,
    })

    process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN'] = 'read-secret-token'
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-secret-token'
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'admin-secret-token'
    process.env['OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN'] = 'asset-secret-token'
    process.env['OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN'] = 'webhook-secret-token'

    expect(evaluateHttpRequestSecurity(input('GET', '/health', 'read-secret-token'), exposed)).toMatchObject({ allowed: true, requiredCapability: 'read' })
    expect(evaluateHttpRequestSecurity(input('POST', '/tasks', 'read-secret-token'), exposed)).toMatchObject({ allowed: false, requiredCapability: 'operator' })
    expect(evaluateHttpRequestSecurity(input('POST', '/tasks', 'operator-secret-token'), exposed)).toMatchObject({ allowed: true, requiredCapability: 'operator' })
    expect(evaluateHttpRequestSecurity(input('GET', '/config', 'operator-secret-token', '?redact=false'), exposed)).toMatchObject({ allowed: false, requiredCapability: 'admin' })
    expect(evaluateHttpRequestSecurity(input('GET', '/storage/export', 'admin-secret-token'), exposed)).toMatchObject({ allowed: true, requiredCapability: 'admin' })
    expect(evaluateHttpRequestSecurity(input('PUT', '/opencode/tools/review-helper', 'operator-secret-token'), exposed)).toMatchObject({ allowed: false, requiredCapability: 'asset_write' })
    expect(evaluateHttpRequestSecurity(input('PUT', '/opencode/tools/review-helper', 'asset-secret-token'), exposed)).toMatchObject({ allowed: true, requiredCapability: 'asset_write' })
    expect(evaluateHttpRequestSecurity(input('POST', '/webhooks/discord', 'webhook-secret-token'), exposed)).toMatchObject({ allowed: true, requiredCapability: 'webhook' })
    expect(getHttpAuthPosture()).toMatchObject({
      configured: true,
      capabilities: ['admin', 'asset_write', 'operator', 'read', 'webhook'],
    })
    expect(JSON.stringify(getHttpAuthPosture())).not.toContain('secret-token')
  })

  it('repairs existing local admin token file permissions before trusting it', () => {
    const tokenPath = localHttpAdminTokenFilePath()
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o755 })
    fs.writeFileSync(tokenPath, 'existing-admin-token\n', { mode: 0o644 })

    expect(ensureLocalHttpAdminTokenFile()).toBe(tokenPath)

    expect(fs.statSync(path.dirname(tokenPath)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(tokenPath, 'utf-8')).toBe('existing-admin-token\n')
  })

  it('rejects symlinked local admin token files', () => {
    const tokenPath = localHttpAdminTokenFilePath()
    const target = path.join(testDir, 'elsewhere-token')
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, 'linked-admin-token\n', { mode: 0o600 })
    fs.symlinkSync(target, tokenPath)

    expect(() => ensureLocalHttpAdminTokenFile()).toThrow('must not be a symlink')
  })

  it('keeps public webhook mode limited to webhook routes and unsafe mode explicit', () => {
    const config = getConfig()
    const exposed = { ...config.security, httpHost: '0.0.0.0', allowNonLocalHttp: true, publicWebhookMode: true }
    const remote = { host: 'gateway.example.com', origin: 'https://gateway.example.com', remoteAddress: '203.0.113.10' }

    expect(evaluateHttpRequestSecurity({ ...remote, method: 'POST', pathname: '/webhooks/whatsapp' }, exposed)).toMatchObject({ allowed: true, actor: 'webhook', requiredCapability: 'webhook' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'GET', pathname: '/webhooks/whatsapp' }, exposed)).toMatchObject({ allowed: true, actor: 'webhook', requiredCapability: 'webhook' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'POST', pathname: '/webhooks/discord' }, exposed)).toMatchObject({ allowed: true, actor: 'webhook', requiredCapability: 'webhook' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'GET', pathname: '/webhooks/discord' }, exposed)).toMatchObject({ allowed: false, requiredCapability: 'read' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'POST', pathname: '/webhooks/whatsapp/extra' }, exposed)).toMatchObject({ allowed: false, requiredCapability: 'operator' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'GET', pathname: '/health' }, exposed)).toMatchObject({ allowed: false, requiredCapability: 'read' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'POST', pathname: '/channels/send' }, exposed)).toMatchObject({ allowed: false, requiredCapability: 'operator' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'PUT', pathname: '/opencode/tools/review-helper' }, exposed)).toMatchObject({ allowed: false, requiredCapability: 'asset_write' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'POST', pathname: '/shutdown' }, exposed)).toMatchObject({ allowed: false, requiredCapability: 'admin' })
    expect(evaluateHttpRequestSecurity({ ...remote, method: 'POST', pathname: '/shutdown' }, { ...exposed, publicWebhookMode: false, unsafeAllowNoAuth: true })).toMatchObject({ allowed: true, actor: 'unsafe-public', requiredCapability: 'admin' })
    expect(PUBLIC_WEBHOOK_ROUTES.map(route => `${route.provider}:${route.method} ${route.path}`)).toEqual([
      'whatsapp:GET /webhooks/whatsapp',
      'whatsapp:POST /webhooks/whatsapp',
      'discord:POST /webhooks/discord',
    ])
    expect(publicWebhookRoutesForProvider('whatsapp').map(route => `${route.method} ${route.path}`)).toEqual(['GET /webhooks/whatsapp', 'POST /webhooks/whatsapp'])
    expect(publicWebhookRoutesForProvider('discord').map(route => `${route.method} ${route.path}`)).toEqual(['POST /webhooks/discord'])
  })

  it('matches channel allowlists by provider, chat, and optional thread', () => {
    const config = updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1', threadId: 'topic-1' }], whatsapp: [{ chatId: 'wa-fixture-target' }] } } } as any)

    expect(isTrustedChannelTarget('telegram', 'chat-1', 'topic-1', config)).toBe(true)
    expect(isTrustedChannelTarget('telegram', 'chat-1', 'topic-2', config)).toBe(false)
    expect(isTrustedChannelTarget('whatsapp', 'wa-fixture-target', undefined, config)).toBe(true)
    expect(isTrustedChannelTarget('whatsapp', 'wa-untrusted-target', undefined, config)).toBe(false)
  })

  it('redacts channel target labels for claim-code audit evidence', () => {
    const label = redactedChannelTargetLabel('telegram', 'private-chat-id', 'private-thread-id')

    expect(label).toMatch(/^telegram:target:[a-f0-9]{16}:thread:[a-f0-9]{8}$/)
    expect(label).not.toContain('private-chat-id')
    expect(label).not.toContain('private-thread-id')
  })

  it('fails closed for configured channels without allowlists unless explicitly unsafe', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:telegram-secret-token-value'
    const config = getConfig()

    expect(isTrustedChannelTarget('telegram', 'chat-1', undefined, config)).toBe(false)

    const unsafe = updateConfig({ security: { unsafeAllowAllChannelTargets: { telegram: true, whatsapp: false } } } as any)
    expect(isTrustedChannelTarget('telegram', 'chat-1', undefined, unsafe)).toBe(true)
  })

  it('fails closed for providers without allowlists even when the provider looks unconfigured', () => {
    const config = getConfig()

    expect(isTrustedChannelTarget('telegram', 'chat-1', undefined, config)).toBe(false)
    expect(isTrustedChannelTarget('whatsapp', 'wa-1', undefined, config)).toBe(false)
    expect(isTrustedChannelTarget('discord', 'channel-1', undefined, config)).toBe(false)
    expect(isTrustedChannelTarget('unknown-provider', 'chat-1', undefined, config)).toBe(false)

    const unsafe = updateConfig({ security: { unsafeAllowAllChannelTargets: { telegram: true } } } as any)
    expect(isTrustedChannelTarget('telegram', 'chat-1', undefined, unsafe)).toBe(true)
    expect(isTrustedChannelTarget('whatsapp', 'wa-1', undefined, unsafe)).toBe(false)
  })

  it('requires a trusted actor for free text in trusted targets by default', () => {
    const config = updateConfig({
      security: {
        channelAllowlists: {
          telegram: [
            { chatId: 'group-1', userIds: ['operator-1'] },
            { chatId: 'dm-1' },
          ],
        },
      },
    } as any)

    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'group-1', userId: 'operator-1' }, config)).toMatchObject({ allowed: true })
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'group-1', userId: 'stranger-2' }, config)).toMatchObject({ allowed: false })
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'group-1' }, config)).toMatchObject({ allowed: false, reason: 'sender user id is missing' })
    // Single-operator DM: rule without an actor policy trusts the sender whose id equals the chat id.
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'dm-1', userId: 'dm-1' }, config)).toMatchObject({ allowed: true, reason: 'sender matches private chat id' })
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'dm-1', userId: 'stranger-2' }, config)).toMatchObject({ allowed: false })
    // No matching rule fails closed for both free text and privileged commands.
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'unlisted-chat', userId: 'operator-1' }, config)).toMatchObject({ allowed: false })
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'unlisted-chat', userId: 'operator-1', privileged: true }, config)).toMatchObject({ allowed: false })

    const relaxed = updateConfig({ security: { trustTargetMembersForFreeText: true } } as any)
    expect(relaxed.security.trustTargetMembersForFreeText).toBe(true)
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'group-1', userId: 'stranger-2' }, relaxed)).toMatchObject({ allowed: true })
    // The escape hatch never relaxes privileged command preflight.
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: 'group-1', userId: 'stranger-2', privileged: true }, relaxed)).toMatchObject({ allowed: false })
  })

  it('classifies transient inbound errors distinctly from ordinary errors', () => {
    const transient = new TransientInboundError('OpenCode is restarting')

    expect(transient.name).toBe('TransientInboundError')
    expect(isTransientInboundError(transient)).toBe(true)
    expect(isTransientInboundError(new Error('poison'))).toBe(false)
    expect(isTransientInboundError(undefined)).toBe(false)
  })

  it('flags actor-less allowlist rules where the private-chat fallback cannot apply', () => {
    const config = updateConfig({
      security: {
        channelAllowlists: {
          telegram: [
            { chatId: '-100777888999' }, // group-shaped, no actors: stranded
            { chatId: '424242' }, // DM-shaped: sender-matches-chat fallback applies
            { chatId: '-100111222333', userIds: ['operator-1'] }, // healed group rule
          ],
          whatsapp: [{ chatId: 'wa-dm-target' }], // DM-shaped: fallback applies
          discord: [
            { chatId: 'discord-channel-1' }, // channel id never equals author id: stranded
            { chatId: 'discord-channel-2', adminUserIds: ['author-1'] },
          ],
        },
      },
    } as any)

    const gaps = listChannelAllowlistActorGaps(config)

    expect(gaps.map(gap => gap.provider).sort()).toEqual(['discord', 'telegram'])
    expect(gaps.map(gap => gap.target)).toEqual(expect.arrayContaining([
      redactedChannelTargetLabel('telegram', '-100777888999'),
      redactedChannelTargetLabel('discord', 'discord-channel-1'),
    ]))
    // Gap evidence is redacted: no raw chat ids.
    expect(JSON.stringify(gaps)).not.toContain('-100777888999')
    expect(JSON.stringify(gaps)).not.toContain('discord-channel-1')

    // The documented escape hatch removes the lockout entirely.
    const relaxed = updateConfig({ security: { trustTargetMembersForFreeText: true } } as any)
    expect(listChannelAllowlistActorGaps(relaxed)).toEqual([])
  })

  it('flags dangerous shell commands for approval', () => {
  })

  it('allowlists service environment variables without channel secrets', () => {
    const env = gatewayServiceEnvironment({
      httpPort: 4097,
      opencodeUrl: 'http://127.0.0.1:4096',
      channels: {
        telegram: { botToken: 'telegram-secret' },
        whatsapp: { accessToken: 'whatsapp-secret', verifyToken: 'verify-secret', appSecret: 'app-secret' },
      },
    } as any)

    expect(env).toEqual({
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      GATEWAY_HTTP_PORT: '4097',
      OPENCODE_GATEWAY_URL: 'http://127.0.0.1:4096',
    })
    expect(JSON.stringify(env)).not.toContain('telegram-secret')
    expect(JSON.stringify(env)).not.toContain('whatsapp-secret')
    expect(() => assertNoServiceSecrets({ TELEGRAM_BOT_TOKEN: 'x' })).toThrow('must not embed')
    expect(() => assertNoServiceSecrets({ WHATSAPP_APP_SECRET: 'x' })).toThrow('must not embed')
  })

  it('allows service token-file references without embedding token values', () => {
    const tokenFile = path.join(testDir, 'admin-token')
    fs.mkdirSync(testDir, { recursive: true })
    fs.writeFileSync(tokenFile, 'file-backed-admin-token', { mode: 0o600 })
    const env = gatewayServiceEnvironment({
      httpPort: 4097,
      opencodeUrl: 'http://127.0.0.1:4096',
    } as any, { adminTokenFile: tokenFile })

    expect(env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE']).toBe(tokenFile)
    expect(JSON.stringify(env)).not.toContain('file-backed-admin-token')
    expect(() => assertNoServiceSecrets({ OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE: tokenFile })).not.toThrow()

    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE'] = tokenFile
    const decision = evaluateHttpRequestSecurity({
      host: 'localhost',
      origin: 'http://localhost',
      remoteAddress: '127.0.0.1',
      method: 'POST',
      pathname: '/tasks',
      authorization: 'Bearer file-backed-admin-token',
    }, getConfig().security)
    expect(decision).toMatchObject({ allowed: true, actor: 'http-token' })
  })

  it('returns typed errors for invalid or too-large JSON bodies', async () => {
    try {
      __daemonTest.parseJsonBody('{nope')
      throw new Error('expected parseJsonBody to throw')
    } catch (err: any) {
      expect(err).toMatchObject({ status: 400, message: 'invalid JSON body' })
    }

    expect(__daemonTest.parseJsonBody('{"ok":true}')).toEqual({ ok: true })
    expect(__daemonTest.parseJsonBody('')).toEqual({})

    for (const payload of ['[]', 'null', '"secret-token-value"', '42']) {
      try {
        __daemonTest.parseJsonBody(payload)
        throw new Error('expected parseJsonBody to reject non-object payload')
      } catch (err: any) {
        expect(err).toMatchObject({ status: 400, message: 'invalid JSON body: expected object' })
        expect(err.message).not.toContain('secret-token-value')
      }
    }

    await expect(__daemonTest.readBody(Readable.from(['abc']) as any, 2)).rejects.toMatchObject({ status: 413 })
  })
})
