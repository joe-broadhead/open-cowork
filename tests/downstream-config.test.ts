import { buildPublicAppConfig, validateConfigSemantics, validateResolvedConfig } from '@open-cowork/runtime-host'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OpenCoworkConfig } from '@open-cowork/shared'
import { resolveCloudPublicBranding } from '@open-cowork/cloud-server/app'

const root = process.cwd()
const exampleRoot = 'examples/downstream/example-org'

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function readExampleConfig(): OpenCoworkConfig {
  return JSON.parse(read(`${exampleRoot}/open-cowork.config.json`)) as OpenCoworkConfig
}

test('downstream example validates and keeps Desktop Cloud Gateway branding aligned', () => {
  const config = readExampleConfig()
  const cloudValues = read(`${exampleRoot}/cloud-values.yaml`)
  const gatewayValues = read(`${exampleRoot}/gateway-values.yaml`)

  assert.doesNotThrow(() => validateResolvedConfig(config, `${exampleRoot}/open-cowork.config.json`))
  assert.doesNotThrow(() => validateConfigSemantics(config, `${exampleRoot}/open-cowork.config.json`))

  assert.equal(config.contractVersion, 1)
  assert.equal(config.branding.name, 'Example Cowork')
  assert.equal(config.branding.shortName, 'EX')
  assert.equal(config.branding.supportUrl, config.cloud.publicBranding.supportUrl)
  assert.equal(config.branding.privacyUrl, config.cloud.publicBranding.privacyUrl)
  assert.equal(config.branding.securityUrl, config.cloud.publicBranding.securityUrl)
  assert.equal(config.branding.legalUrl, config.cloud.publicBranding.legalUrl)
  assert.equal(config.cloud.publicBranding.productName, config.gateway.branding?.productName)
  assert.equal(config.cloud.publicBranding.logoUrl, config.gateway.branding?.logoUrl)
  assert.equal(config.cloud.publicBranding.supportUrl, config.gateway.branding?.supportUrl)
  assert.match(gatewayValues, /cloudBaseUrl: https:\/\/cowork\.example\.com/)

  const publicConfig = buildPublicAppConfig(config, [])
  assert.equal(publicConfig.branding.name, 'Example Cowork')
  assert.equal(publicConfig.branding.shortName, 'EX')
  assert.equal(publicConfig.branding.supportUrl, 'https://support.example.com/cowork')

  assert.match(cloudValues, /productName: Example Cowork/)
  assert.match(cloudValues, /publicUrl: https:\/\/cowork\.example\.com/)
  assert.match(cloudValues, /oidcIssuerUrl: https:\/\/idp\.example\.com/)
  assert.match(cloudValues, /objectStore:/)
  assert.match(cloudValues, /credentialsRef: env:OPEN_COWORK_CLOUD_OBJECT_STORE_CREDENTIALS/)
  assert.match(gatewayValues, /productName: Example Cowork/)
  assert.match(gatewayValues, /cloudBaseUrl: https:\/\/cowork\.example\.com/)
  assert.match(gatewayValues, /channelBindingId: example-telegram/)
})

test('downstream examples use placeholders rather than customer or private deployment values', () => {
  const files = [
    `${exampleRoot}/README.md`,
    `${exampleRoot}/open-cowork.config.json`,
    `${exampleRoot}/cloud-values.yaml`,
    `${exampleRoot}/gateway-values.yaml`,
  ]
  const forbiddenPatterns = [
    /\bacme\b/i,
    /\bacme\./i,
    /\bT0123ACME\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\bxoxb-[A-Za-z0-9-]{20,}\b/,
    /\b(?:price|prod|acct|cus|sub)_[0-9A-Za-z]{8,}\b/,
    /\b\d{12}\b/,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
    /\btag:\s*(?:latest|stable)\b/,
  ]

  for (const file of files) {
    const contents = read(file)
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern, `${file} must stay placeholder-only`)
    }
    for (const match of contents.matchAll(/https?:\/\/([^/\s"'<>]+)/g)) {
      const host = match[1].toLowerCase()
      assert.ok(host === 'example.com' || host.endsWith('.example.com'), `${file} URL host ${host} must use example.com`)
    }
  }
})

test('public bootstrap branding exposes only whitelisted safe metadata', () => {
  const config = readExampleConfig()
  const branding = resolveCloudPublicBranding(config, {
    OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: JSON.stringify({
      productName: 'Bootstrap Cowork',
      logoUrl: 'http://assets.example.com/cowork/logo.png',
      supportUrl: 'mailto:support@example.com',
      privacyUrl: 'javascript:alert(1)',
      secretToken: 'not-public',
      theme: {
        accent: '#123456',
        backgroundImage: 'url(secret)',
      },
      dashboard: {
        title: 'Bootstrap workspace',
        adminToken: 'not-public',
      },
      managedOrgConnectionLabels: {
        desktopToken: 'Bootstrap Desktop token',
        adminSecret: 'not-public',
      },
    }),
  })

  assert.equal(branding.productName, 'Bootstrap Cowork')
  assert.equal(branding.logoUrl, config.cloud.publicBranding.logoUrl)
  assert.equal(branding.supportUrl, 'mailto:support@example.com')
  assert.equal(branding.privacyUrl, config.cloud.publicBranding.privacyUrl)
  assert.equal((branding as Record<string, unknown>).secretToken, undefined)
  assert.equal((branding.theme as Record<string, unknown>).backgroundImage, undefined)
  assert.equal((branding.dashboard as Record<string, unknown>).adminToken, undefined)
  assert.equal((branding.managedOrgConnectionLabels as Record<string, unknown>).adminSecret, undefined)
})

test('downstream docs cover supported adapters historical identifiers and SaaS split', () => {
  const contract = read('docs/downstream-contract.md')
  const downstream = read('docs/downstream.md')
  const productContract = read('docs/product-contract.md')

  for (const phrase of [
    'Object-store adapters',
    'Secret/KMS adapters',
    'OIDC/header auth',
    'Billing adapters',
    'Observability adapters',
    'managed BYOK SaaS',
    'self-host',
    'com.opencowork.desktop',
    '.opencowork/',
  ]) {
    assert.match(contract, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  assert.match(downstream, /cloud\.billing\.provider=none/)
  assert.match(downstream, /separate managed\/private repo/)
  assert.match(productContract, /prices, customer data, support rosters, and secrets belong in downstream\/private/)
})
