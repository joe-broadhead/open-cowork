import { clearSettingsCache, loadSettings, saveSettings } from '@open-cowork/runtime-host/settings'
import { saveCustomMcp, saveCustomSkill } from '@open-cowork/runtime-host/native-customizations'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { getRuntimeInputDiagnostics } from '../apps/desktop/src/main/runtime-input-diagnostics.ts'
test('getRuntimeInputDiagnostics reports effective provider inputs and override sources', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-runtime-inputs-'))
  const configDir = join(tempRoot, 'config')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const originalSettings = loadSettings()

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), `{
  "providers": {
    "available": ["vertex"],
    "defaultProvider": "vertex",
    "defaultModel": "gemini-3-flash-preview",
    "descriptors": {
      "vertex": {
        "runtime": "builtin",
        "name": "Google Vertex AI",
        "description": "Vertex runtime",
        "options": {
          "project": "config-project",
          "location": "us-central1",
          "apiKey": "should-be-hidden"
        },
        "credentials": [
          {
            "key": "projectId",
            "runtimeKey": "project",
            "label": "Project",
            "description": "Project"
          },
          {
            "key": "location",
            "label": "Location",
            "description": "Location"
          }
        ],
        "models": [
          { "id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro" },
          { "id": "gemini-3-flash-preview", "name": "Gemini 3 Flash" }
        ]
      }
    }
  }
}`)

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  clearConfigCaches()
  saveSettings({
    selectedProviderId: 'vertex',
    selectedModelId: 'gemini-3-flash-preview',
    providerCredentials: {
      vertex: {
        projectId: 'settings-project',
        location: 'global',
      },
    },
  })

  try {
    const diagnostics = getRuntimeInputDiagnostics()

    assert.equal(diagnostics.providerId, 'vertex')
    assert.equal(diagnostics.modelId, 'gemini-3-flash-preview')
    assert.equal(diagnostics.runtimeModel, 'vertex/gemini-3-flash-preview')
    assert.equal(diagnostics.providerSource, 'settings')
    assert.equal(diagnostics.modelSource, 'settings')
    assert.equal(diagnostics.providerPackage, null)
    assert.deepEqual(diagnostics.credentialOverrideKeys, ['location', 'projectId'])
    assert.deepEqual(diagnostics.providerOptions, {
      project: 'settings-project',
      location: 'global',
    })
    const capabilityKinds = new Set(diagnostics.capabilities?.map((capability) => capability.kind))
    assert.equal(capabilityKinds.has('provider'), true)
    assert.equal(capabilityKinds.has('model'), true)
    assert.equal(capabilityKinds.has('mcp'), true)
    assert.equal(capabilityKinds.has('skill'), true)
    assert.equal(diagnostics.capabilities?.every((capability) => capability.redacted), true)
    assert.equal(diagnostics.capabilities?.find((capability) => capability.kind === 'provider')?.reasonCode, 'provider.settings')
    assert.equal(diagnostics.capabilities?.some((capability) => (
      capability.kind === 'mcp'
      && capability.id === 'semantic-ui'
      && capability.status === 'active'
      && capability.reasonCode === 'mcp.configured'
    )), true)
    assert.equal(diagnostics.capabilities?.some((capability) => (
      capability.kind === 'skill'
      && capability.id === 'clock'
      && capability.status === 'active'
    )), true)
    assert.equal(
      diagnostics.compatibility?.assumptions.some((entry) => entry.id === 'opencode-plugin-remote-fail-closed' && entry.status === 'blocked'),
      true,
    )
    assert.equal(diagnostics.capabilities?.some((capability) => (
      capability.kind === 'opencode-plugin'
      && capability.status === 'unsupported'
      && capability.reasonCode === 'plugin.product-mode-unsupported'
    )), true)
    assert.equal(diagnostics.capabilities?.some((capability) => (
      capability.kind === 'agent'
      && capability.id === 'subagent-delegation'
      && capability.status === 'ask-gated'
    )), true)
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('getRuntimeInputDiagnostics reports built-in provider credential overrides without exposing secrets', () => {
  const originalSettings = loadSettings()

  saveSettings({
    selectedProviderId: 'openrouter',
    selectedModelId: 'anthropic/claude-sonnet-4',
    providerCredentials: {
      openrouter: {
        apiKey: 'sk-or-test',
      },
    },
  })

  try {
    const diagnostics = getRuntimeInputDiagnostics()

    assert.equal(diagnostics.providerId, 'openrouter')
    assert.equal(diagnostics.modelId, 'anthropic/claude-sonnet-4')
    assert.equal(diagnostics.runtimeModel, 'openrouter/anthropic/claude-sonnet-4')
    assert.equal(diagnostics.providerName, 'OpenRouter')
    assert.equal(diagnostics.providerPackage, null)
    assert.deepEqual(diagnostics.credentialOverrideKeys, ['apiKey'])
    assert.deepEqual(diagnostics.providerOptions, {})
    assert.deepEqual(diagnostics.capabilities?.find((capability) => capability.kind === 'provider')?.evidence?.credentialOverrideKeys, ['apiKey'])
    assert.equal(diagnostics.conflicts?.some((conflict) => (
      conflict.kind === 'model'
      && conflict.id === 'anthropic/claude-sonnet-4'
      && conflict.reasonCode === 'model.source-conflict-winner'
    )), true)
    assert.doesNotMatch(JSON.stringify(diagnostics), /sk-or-test/)
  } finally {
    saveSettings(originalSettings)
  }
})

test('getRuntimeInputDiagnostics reports auth-pending and override conflicts with stable reason codes', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-runtime-provenance-conflicts-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousConfigPath = process.env.OPEN_COWORK_CONFIG_PATH

  process.env.OPEN_COWORK_USER_DATA_DIR = tempRoot
  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  writeFileSync(configPath, `{
  "skills": [
    {
      "name": "Clock",
      "description": "Clock skill",
      "badge": "Skill",
      "sourceName": "clock",
      "toolIds": ["clock"]
    }
  ],
  "mcps": [
    {
      "name": "clock",
      "type": "local",
      "description": "Clock MCP",
      "authMode": "none",
      "packageName": "clock"
    },
    {
      "name": "oauth-example",
      "type": "local",
      "description": "OAuth MCP",
      "authMode": "oauth",
      "packageName": "clock"
    }
  ]
}`)
  clearConfigCaches()
  clearSettingsCache()

  try {
    saveCustomSkill({
      scope: 'machine',
      directory: null,
      name: 'clock',
      content: `---
description: Custom clock override
---
Custom override.
`,
    })
    saveCustomMcp({
      scope: 'machine',
      name: 'clock',
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
    })

    const diagnostics = getRuntimeInputDiagnostics()
    const googleMcp = diagnostics.capabilities?.find((capability) => (
      capability.kind === 'mcp'
      && capability.reasonCode === 'mcp.awaiting-oauth-opt-in'
    ))

    assert.equal(googleMcp?.status, 'auth-pending')
    assert.equal(diagnostics.conflicts?.some((conflict) => (
      conflict.kind === 'skill'
      && conflict.id === 'clock'
      && conflict.winnerSource === 'custom:machine'
      && conflict.loserSources.includes('builtin:open-cowork')
    )), true)
    assert.equal(diagnostics.conflicts?.some((conflict) => (
      conflict.kind === 'mcp'
      && conflict.id === 'clock'
      && conflict.reasonCode === 'mcp.custom-overrides-builtin'
    )), true)
    assert.equal(diagnostics.conflicts?.every((conflict) => conflict.redacted), true)
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    if (previousConfigPath === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousConfigPath
    clearConfigCaches()
    clearSettingsCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('getRuntimeInputDiagnostics reports MCP policy provenance without leaking command details', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-runtime-provenance-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempRoot
  clearConfigCaches()
  clearSettingsCache()

  try {
    saveSettings({
      integrationEnabled: {
        clock: false,
      },
    })
    saveCustomMcp({
      scope: 'machine',
      name: 'unsafe-local',
      type: 'stdio',
      command: 'sh',
      args: ['-c', 'echo secret-token-value'],
    })

    const diagnostics = getRuntimeInputDiagnostics()
    const clock = diagnostics.capabilities?.find((capability) => capability.kind === 'mcp' && capability.id === 'clock')
    const unsafe = diagnostics.capabilities?.find((capability) => capability.kind === 'mcp' && capability.id === 'unsafe-local')

    assert.equal(clock?.status, 'disabled')
    assert.equal(clock?.reasonCode, 'mcp.disabled-by-user')
    assert.equal(unsafe?.status, 'blocked')
    assert.equal(unsafe?.reasonCode, 'mcp.stdio-policy-blocked')
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret-token-value/)
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    clearSettingsCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
