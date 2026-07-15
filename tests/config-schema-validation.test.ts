import { validateConfigSemantics, validateResolvedConfig } from '@open-cowork/runtime-host'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'fs'
function readRootConfig() {
  return JSON.parse(readFileSync('open-cowork.config.json', 'utf-8'))
}

function cloneConfig() {
  return JSON.parse(JSON.stringify(readRootConfig()))
}

test('root open-cowork.config.json validates against the public schema', () => {
  const config = readRootConfig()
  assert.doesNotThrow(() => validateResolvedConfig(config, 'open-cowork.config.json'))
})

test('capability bundle schema requires collections and accepts kind-qualified uninstall selectors', () => {
  const config = cloneConfig()
  config.capabilityBundles = [{
    format: 'open-cowork-capability-bundle-v1',
    name: 'schema-pack',
    version: '1.0.0',
    owner: 'open-cowork',
    resources: [
      { kind: 'skill', id: 'shared-id', ownedByBundle: true },
      { kind: 'workflow', id: 'shared-id', ownedByBundle: true },
    ],
    permissions: [],
    uninstall: {
      removes: [{ kind: 'skill', id: 'shared-id' }],
      preserves: [{ kind: 'workflow', id: 'shared-id' }],
    },
  }]
  assert.doesNotThrow(() => validateResolvedConfig(config, 'capability bundle config'))

  const missingResources = cloneConfig()
  missingResources.capabilityBundles = [{
    format: 'open-cowork-capability-bundle-v1',
    name: 'schema-pack',
    version: '1.0.0',
    owner: 'open-cowork',
    permissions: [],
  }]
  assert.throws(() => validateResolvedConfig(missingResources, 'capability bundle config'), /capabilityBundles/)

  const missingPermissions = cloneConfig()
  missingPermissions.capabilityBundles = [{
    format: 'open-cowork-capability-bundle-v1',
    name: 'schema-pack',
    version: '1.0.0',
    owner: 'open-cowork',
    resources: [],
  }]
  assert.throws(() => validateResolvedConfig(missingPermissions, 'capability bundle config'), /capabilityBundles/)
})

test('downstream contract version is required and fixed for this schema', () => {
  const config = cloneConfig()
  assert.equal(config.contractVersion, 1)

  delete config.contractVersion
  assert.throws(() => validateResolvedConfig(config, 'downstream config'), /contractVersion/)

  const unsupported = cloneConfig()
  unsupported.contractVersion = 2
  assert.throws(() => validateResolvedConfig(unsupported, 'downstream config'), /contractVersion/)
})

test('agent starter template schema accepts primary and subagent modes', () => {
  const config = cloneConfig()
  config.agentStarterTemplates = [
    {
      id: 'primary-coworker',
      label: 'Primary coworker',
      description: 'Starts a primary coworker.',
      color: 'azure',
      mode: 'primary',
      instructions: 'Own the main conversation.',
      toolIds: ['clock'],
      skillNames: [],
    },
    {
      id: 'delegated-coworker',
      label: 'Delegated coworker',
      description: 'Starts a delegated specialist.',
      color: 'violet',
      mode: 'subagent',
      instructions: 'Handle delegated work.',
      temperature: null,
      steps: null,
    },
  ]

  assert.doesNotThrow(() => validateResolvedConfig(config, 'starter template config'))

  const invalid = cloneConfig()
  invalid.agentStarterTemplates = [
    {
      id: 'invalid-coworker',
      label: 'Invalid coworker',
      description: 'Invalid starter mode.',
      color: 'azure',
      mode: 'manager',
      instructions: 'This should not validate.',
    },
  ]

  assert.throws(() => validateResolvedConfig(invalid, 'starter template config'), /agentStarterTemplates\[0\]\.mode/)
})

test('branding sidebar and home overrides validate', () => {
  const config = cloneConfig()
  config.branding.sidebar = {
    top: {
      variant: 'icon-text',
      icon: 'AC',
      mediaSize: 36,
      mediaFit: 'bounded',
      mediaAlign: 'center',
      title: 'Acme AI',
      subtitle: 'Private workspace',
      ariaLabel: 'Acme AI workspace',
    },
    lower: {
      text: 'Acme internal build',
      secondaryText: 'Support is handled by the data platform team.',
      linkLabel: 'Get help',
      linkUrl: 'https://internal.acme.example/help',
    },
  }
  config.branding.home = {
    greeting: 'What should {{brand}} work on today?',
    subtitle: 'Ask a question or delegate to an approved agent.',
    composerPlaceholder: 'Ask {{brand}} anything',
    suggestionLabel: 'Start with',
    statusReadyLabel: 'Online',
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'branding config'))
})

test('branding logo asset paths validate', () => {
  const config = cloneConfig()
  config.branding.sidebar = {
    top: {
      variant: 'logo-text',
      logoAsset: 'branding/acme-logo.svg',
      title: 'Acme AI',
    },
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'branding config'))
})

test('branding rejects unknown sidebar keys', () => {
  const config = cloneConfig()
  config.branding.sidebar = {
    top: {
      title: 'Acme AI',
      html: '<strong>not allowed</strong>',
    },
  }

  assert.throws(() => validateResolvedConfig(config, 'branding config'), /branding\.sidebar\.top/)
})

test('branding rejects unsafe links and logo URLs', () => {
  const config = cloneConfig()
  config.branding.sidebar = {
    top: {
      variant: 'logo',
      logoAsset: 'https://cdn.example.test/logo.png',
    },
    lower: {
      linkLabel: 'Help',
      linkUrl: 'http://internal.example.test/help',
    },
  }

  assert.throws(() => validateResolvedConfig(config, 'branding config'), /branding\.sidebar/)
})

test('branding rejects unsafe logo asset paths', () => {
  for (const logoAsset of [
    '/tmp/acme-logo.svg',
    '../acme-logo.svg',
    'branding/../acme-logo.svg',
    'https://cdn.example.test/logo.svg',
    'branding/acme-logo.html',
  ]) {
    const config = cloneConfig()
    config.branding.sidebar = {
      top: {
        variant: 'logo',
        logoAsset,
      },
    }

    assert.throws(() => validateResolvedConfig(config, 'branding config'), /branding\.sidebar\.top\.logoAsset/)
  }
})

test('branding rejects invalid sidebar top media controls', () => {
  for (const top of [
    { variant: 'logo', mediaSize: 15 },
    { variant: 'logo', mediaSize: 97 },
    { variant: 'logo', mediaSize: 28.5 },
    { variant: 'logo', mediaFit: 'stretch' },
    { variant: 'logo', mediaAlign: 'left' },
  ]) {
    const config = cloneConfig()
    config.branding.sidebar = {
      top,
    }

    assert.throws(() => validateResolvedConfig(config, 'branding config'), /branding\.sidebar\.top/)
  }
})

test('downstream i18n and telemetry overlays validate', () => {
  const config = cloneConfig()
  config.i18n = {
    locale: 'de-DE',
    strings: {
      'home.greeting': 'Woran soll {{brand}} heute arbeiten?',
    },
  }
  config.allowedEnvPlaceholders = ['ACME_TELEMETRY_TOKEN']
  config.telemetry = {
    enabled: true,
    endpoint: 'https://events.acme.example/ingest',
    headers: {
      Authorization: 'Bearer resolved-token',
    },
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'downstream config'))
})

test('cloud deployment config validates role, profile, storage, and runtime policy', () => {
  const config = cloneConfig()
  config.cloud = {
    role: 'worker',
    defaultProfile: 'data-analyst',
    auth: {
      mode: 'oidc',
      issuerUrl: 'https://auth.example.test',
      clientId: 'open-cowork-cloud',
      clientSecretRef: 'secret/oidc-client',
      cookieSecretRef: 'secret/cookie',
      signupMode: 'domain',
      allowedEmailDomains: ['example.test'],
    },
    storage: {
      controlPlane: {
        kind: 'postgres',
        urlRef: 'secret/database-url',
      },
      objectStore: {
        kind: 's3',
        bucket: 'open-cowork-cloud',
        region: 'us-east-1',
        prefix: 'prod',
        credentialsRef: 'secret/object-store',
      },
    },
    runtime: {
      configSource: 'app',
      launcher: 'node',
      allowMachineRuntimeConfig: false,
      allowLocalStdioMcps: false,
      allowHostProjectDirectories: false,
      allowRemoteApprovalResponses: false,
      allowedLocalMcpNames: [],
      allowedHostProjectDirectories: [],
    },
    features: {
      chat: true,
      agents: true,
      artifacts: true,
      threadIndex: true,
      workflows: false,
      webhooks: false,
      settings: false,
      customSkills: false,
      customAgents: false,
      customMcps: false,
    },
    profiles: {
      'data-analyst': {
        label: 'Data analyst',
        description: 'Only expose the data analyst agent and warehouse MCP.',
        agents: ['data-analyst'],
        tools: ['warehouse'],
        mcps: ['warehouse'],
      },
    },
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'cloud config'))
})

test('cloud public branding validates and rejects unsafe URLs or unknown keys', () => {
  const config = cloneConfig()
  config.cloud = {
    publicBranding: {
      productName: 'Acme Cowork',
      shortName: 'AC',
      logoUrl: 'https://assets.acme.example/cowork/logo.png',
      supportUrl: 'mailto:support@acme.example',
      privacyUrl: 'https://legal.acme.example/privacy',
      securityUrl: 'https://security.acme.example/cowork',
      legalUrl: 'https://legal.acme.example/terms',
      theme: {
        background: '#f7f8f5',
        surface: '#ffffff',
        accent: '#0f6b4b',
        accentSoft: 'color-mix(in srgb,var(--accent) 15%,transparent)',
        surfaceActive: 'color-mix(in srgb, #0f6b4b 16%, #ffffff)',
      },
      dashboard: {
        title: 'Acme workspace',
        subtitle: 'Manage Acme cloud clients.',
      },
      managedOrgConnectionLabels: {
        desktopToken: 'Acme Desktop token',
        gatewayToken: 'Acme Gateway token',
        apiToken: 'Acme API token',
        cloudUrl: 'Acme Cloud URL',
      },
    },
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'cloud public branding config'))

  config.cloud.publicBranding.logoUrl = 'http://assets.acme.example/logo.png'
  assert.throws(() => validateResolvedConfig(config, 'cloud public branding config'), /cloud\.publicBranding\.logoUrl/)

  config.cloud.publicBranding.logoUrl = 'https://assets.acme.example/cowork/logo.png'
  config.cloud.publicBranding.theme.accent = 'color-mix(in srgb, #fff 20%, #000)'
  assert.throws(() => validateResolvedConfig(config, 'cloud public branding config'), /cloud\.publicBranding\.theme\.accent/)

  config.cloud.publicBranding.theme.accent = '#0f6b4b'
  config.cloud.publicBranding.html = '<strong>not allowed</strong>'
  assert.throws(() => validateResolvedConfig(config, 'cloud public branding config'), /cloud\.publicBranding/)
})

test('downstream example validates against the public schema', () => {
  const config = JSON.parse(readFileSync('examples/downstream/example-org/open-cowork.config.json', 'utf-8'))
  assert.doesNotThrow(() => validateResolvedConfig(config, 'examples/downstream/example-org/open-cowork.config.json'))
  assert.doesNotThrow(() => validateConfigSemantics(config, 'examples/downstream/example-org/open-cowork.config.json'))
})

test('private beta deployment examples validate against the public schema', () => {
  for (const path of [
    'deploy/private-beta/hosted-byok.config.example.json',
    'deploy/private-beta/self-host-oss.config.example.json',
  ]) {
    const config = JSON.parse(readFileSync(path, 'utf-8'))
    assert.doesNotThrow(() => validateResolvedConfig(config, path))
    assert.doesNotThrow(() => validateConfigSemantics(config, path))
  }
})

test('gateway deployer config validates shared branding providers and safety semantics', () => {
  const config = cloneConfig()
  config.allowedEnvPlaceholders = [
    'ACME_GATEWAY_ADMIN_TOKEN',
    'ACME_WEBHOOK_SECRET',
  ]
  config.gateway = {
    branding: {
      productName: 'Acme Cowork',
      shortName: 'AC',
      supportUrl: 'https://support.acme.example/cowork',
    },
    productMode: 'cloud_channel',
    server: {
      host: '0.0.0.0',
      port: 8790,
      publicBaseUrl: 'https://cowork-gateway.acme.example',
      adminToken: '{env:ACME_GATEWAY_ADMIN_TOKEN}',
    },
    mode: 'self-host',
    metrics: {
      enabled: true,
    },
    diagnostics: {
      enabled: false,
    },
    providers: [{
      id: 'acme-webhook',
      kind: 'webhook',
      channelBindingId: 'acme-webhook',
      credentials: {
        sharedSecret: '{env:ACME_WEBHOOK_SECRET}',
      },
      settings: {
        deliveryUrl: 'https://bridge.acme.example/out',
      },
    }],
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'gateway deployer config'))
  assert.doesNotThrow(() => validateConfigSemantics(config, 'gateway deployer config'))

  config.gateway.productMode = 'cloud'
  assert.throws(() => validateResolvedConfig(config, 'gateway deployer config'), /gateway\.productMode/)
})

test('gateway deployer config fails closed when a bridge provider omits its relay', () => {
  const config = cloneConfig()
  config.allowedEnvPlaceholders = ['ACME_GATEWAY_ADMIN_TOKEN', 'ACME_BRIDGE_SECRET']
  const gateway = {
    productMode: 'cloud_channel',
    server: {
      host: '0.0.0.0',
      port: 8790,
      publicBaseUrl: 'https://cowork-gateway.acme.example',
      adminToken: '{env:ACME_GATEWAY_ADMIN_TOKEN}',
    },
    mode: 'self-host',
  }

  // A bridge-only provider (discord/whatsapp/signal) WITH its relay validates.
  config.gateway = { ...gateway, providers: [{
    id: 'acme-discord',
    kind: 'discord',
    channelBindingId: 'acme-discord',
    credentials: { sharedSecret: '{env:ACME_BRIDGE_SECRET}' },
    settings: { deliveryUrl: 'https://bridge.acme.example/discord' },
  }] }
  assert.doesNotThrow(() => validateResolvedConfig(config, 'gateway deployer config'))

  // The same provider WITHOUT a relay fails closed at schema time (no longer
  // presented as turnkey) — matching the gateway runtime's own requirement.
  config.gateway = { ...gateway, providers: [{
    id: 'acme-discord',
    kind: 'discord',
    channelBindingId: 'acme-discord',
  }] }
  assert.throws(
    () => validateResolvedConfig(config, 'gateway deployer config'),
    /sharedSecret|deliveryUrl|credentials|settings/,
  )
})

test('gateway deployer config allows gateway-only secrets to be injected outside desktop validation', () => {
  const config = cloneConfig()
  config.gateway = {
    server: {
      host: '127.0.0.1',
      adminToken: '',
    },
    metrics: {
      enabled: false,
    },
    diagnostics: {
      enabled: false,
    },
    providers: [{
      kind: 'telegram',
      channelBindingId: 'acme-telegram',
      credentials: {
        botToken: '',
      },
    }],
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'gateway deployer config'))
  assert.doesNotThrow(() => validateConfigSemantics(config, 'gateway deployer config'))
})

test('gateway deployer config rejects unsafe public URLs and fail-open provider settings', () => {
  const config = cloneConfig()
  config.gateway = {
    providers: [{
      kind: 'webhook',
      channelBindingId: 'acme-webhook',
      settings: {
        deliveryUrl: 'https://bridge.acme.example/out',
      },
    }],
  }
  assert.doesNotThrow(() => validateResolvedConfig(config, 'gateway deployer config'))
  assert.throws(() => validateConfigSemantics(config, 'gateway deployer config'), /credentials\.sharedSecret/)

  config.gateway.providers = [{
    kind: 'fake',
    channelBindingId: 'fake-binding',
  }]
  config.gateway.server = { host: '0.0.0.0' }
  config.gateway.metrics = { enabled: false }
  config.gateway.diagnostics = { enabled: false }
  assert.throws(() => validateConfigSemantics(config, 'gateway deployer config'), /fake provider/)

  config.gateway.providers = [{
    kind: 'telegram',
    channelBindingId: 'telegram',
    credentials: {
      botToken: 'telegram-token',
    },
  }]
  delete config.gateway.metrics
  delete config.gateway.diagnostics
  assert.throws(() => validateConfigSemantics(config, 'gateway deployer config'), /adminToken/)
})

test('cloud deployment config rejects machine runtime config and unknown cloud keys', () => {
  const config = cloneConfig()
  config.cloud = {
    role: 'worker',
    runtime: {
      configSource: 'machine',
      launcher: 'node',
      html: '<script></script>',
    },
  }

  assert.throws(() => validateResolvedConfig(config, 'cloud config'), /cloud\.runtime/)
})

test('cloud desktop managed org config validates and rejects unsafe values', () => {
  const config = cloneConfig()
  config.cloudDesktop = {
    enabled: true,
    allowUserAddedConnections: false,
    requireManagedOrg: true,
    cacheMode: 'metadata-only',
    cacheEncryptionFallback: 'disabled',
    preconfiguredConnections: [{
      baseUrl: 'https://cloud.example.test',
      label: 'Acme Cloud',
    }],
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'cloud desktop config'))

  config.cloudDesktop.preconfiguredConnections[0].baseUrl = 'http://cloud.example.test'
  assert.throws(() => validateResolvedConfig(config, 'cloud desktop config'), /cloudDesktop/)
})

test('downstream tool trace rules validate', () => {
  const config = cloneConfig()
  config.toolTrace = {
    additionalRules: [
      {
        id: 'ticket',
        label: 'ticket action',
        pluralLabel: 'ticket actions',
        match: [
          { prefixes: ['mcp__jira__', 'jira_'] },
        ],
      },
    ],
  }

  assert.doesNotThrow(() => validateResolvedConfig(config, 'tool trace config'))

  config.toolTrace.additionalRules[0].html = '<script></script>'
  assert.throws(() => validateResolvedConfig(config, 'tool trace config'), /toolTrace/)
})

test('telemetry schema rejects unknown keys and non-https endpoints', () => {
  const config = cloneConfig()
  config.telemetry = {
    enabled: true,
    endpoint: 'http://events.acme.example/ingest',
    html: '<script></script>',
  }

  assert.throws(() => validateResolvedConfig(config, 'telemetry config'), /telemetry/)
})

test('update release sources validate for GitHub, generic HTTP, and GCS', () => {
  const config = cloneConfig()
  config.updates = {
    enabled: true,
    manualFallbackUrl: 'https://releases.acme.example/open-cowork',
    releaseSource: {
      kind: 'gcs',
      label: 'Acme private releases',
      bucket: 'acme-cowork-releases',
      prefix: 'desktop',
      channel: 'latest',
      auth: {
        kind: 'google-oauth',
        requiredScopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
      },
    },
  }
  assert.doesNotThrow(() => validateResolvedConfig(config, 'update source config'))

  config.updates.releaseSource = {
    kind: 'generic-http',
    label: 'Acme generic feed',
    url: 'https://updates.acme.example/cowork',
    channel: 'beta',
    auth: {
      kind: 'static-headers',
      headers: {
        Authorization: 'Bearer resolved-token',
      },
    },
  }
  assert.doesNotThrow(() => validateResolvedConfig(config, 'update source config'))

  config.updates.releaseSource = {
    kind: 'github-releases',
    owner: 'joe-broadhead',
    repo: 'open-cowork',
  }
  assert.doesNotThrow(() => validateResolvedConfig(config, 'update source config'))
})

test('update release source schema rejects non-https public endpoints', () => {
  const config = cloneConfig()
  config.updates = {
    enabled: true,
    releaseSource: {
      kind: 'generic-http',
      url: 'http://updates.acme.example/cowork',
    },
  }

  assert.throws(() => validateResolvedConfig(config, 'update source config'), /updates/)
})

test('update release source schema rejects unsafe release identifiers', () => {
  const config = cloneConfig()
  config.updates = {
    enabled: true,
    releaseSource: {
      kind: 'github-releases',
      owner: 'joe-broadhead/other',
      repo: 'open-cowork',
    },
  }
  assert.throws(() => validateResolvedConfig(config, 'update source config'), /updates/)

  config.updates.releaseSource = {
    kind: 'gcs',
    bucket: 'acme/releases',
  }
  assert.throws(() => validateResolvedConfig(config, 'update source config'), /updates/)

  config.updates.releaseSource = {
    kind: 'generic-http',
    url: 'https://updates.acme.example/cowork',
    channel: '../latest',
  }
  assert.throws(() => validateResolvedConfig(config, 'update source config'), /updates/)
})

test('provider dynamic catalogs require https URLs and valid SHA-256 pins', () => {
  const config = cloneConfig()
  config.providers.descriptors.openrouter.dynamicCatalog = {
    url: 'http://models.example.test/catalog.json',
    sha256: 'not-a-sha',
  }

  assert.throws(() => validateResolvedConfig(config, 'provider catalog config'), /providers/)

  config.providers.descriptors.openrouter.dynamicCatalog = {
    url: 'https://models.example.test/catalog.json',
    sha256: 'a'.repeat(64),
  }
  assert.doesNotThrow(() => validateResolvedConfig(config, 'provider catalog config'))
})

test('provider descriptors validate runtime activation modes', () => {
  const config = cloneConfig()
  config.providers.descriptors['github-copilot'].runtimeActivation = 'config'
  assert.doesNotThrow(() => validateResolvedConfig(config, 'provider runtime activation config'))

  config.providers.descriptors['github-copilot'].runtimeActivation = 'always'
  assert.throws(() => validateResolvedConfig(config, 'provider runtime activation config'), /providers/)
})
