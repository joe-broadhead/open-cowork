import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'fs'
import { validateResolvedConfig } from '../apps/desktop/src/main/config-schema.ts'

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

test('branding sidebar and home overrides validate', () => {
  const config = cloneConfig()
  config.branding.sidebar = {
    top: {
      variant: 'icon-text',
      icon: 'AC',
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
      logoDataUrl: 'https://cdn.example.test/logo.png',
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

test('telemetry schema rejects unknown keys and non-https endpoints', () => {
  const config = cloneConfig()
  config.telemetry = {
    enabled: true,
    endpoint: 'http://events.acme.example/ingest',
    html: '<script></script>',
  }

  assert.throws(() => validateResolvedConfig(config, 'telemetry config'), /telemetry/)
})
