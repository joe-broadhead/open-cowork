import { clearSettingsCache, loadSettings, saveSettings } from '@open-cowork/runtime-host/settings'
import { saveCustomMcp, saveCustomSkill } from '@open-cowork/runtime-host/native-customizations'
import { EMPTY_MANAGED_POLICY, resetActiveManagedPolicyCache, setActiveManagedPolicy } from '@open-cowork/runtime-host/managed-policy'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import { getRuntimeInputDiagnostics } from '../apps/desktop/src/main/runtime-input-diagnostics.ts'
test('getRuntimeInputDiagnostics reports effective provider inputs and override sources', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-inputs-'))
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
      && capability.id === 'time-keep'
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
    // OpenRouter is composed as openai-compatible with a public baseURL (not the
    // models.dev OpenRouter package). Diagnostics surface that option so the UI
    // matches what runtime will hand to OpenCode — still without secrets.
    assert.deepEqual(diagnostics.providerOptions, {
      baseURL: 'https://openrouter.ai/api/v1',
    })
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
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-provenance-conflicts-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousConfigPath = process.env.OPEN_COWORK_CONFIG_PATH

  process.env.OPEN_COWORK_USER_DATA_DIR = tempRoot
  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  writeFileSync(configPath, `{
  "skills": [
    {
      "name": "Time Keep",
      "description": "Time keep skill",
      "badge": "Skill",
      "sourceName": "time-keep",
      "toolIds": ["time-keep"]
    }
  ],
  "mcps": [
    {
      "name": "time-keep",
      "type": "local",
      "description": "Time keep MCP",
      "authMode": "none",
      "command": ["time-keep", "server", "start", "--transport", "stdio"]
    },
    {
      "name": "oauth-example",
      "type": "local",
      "description": "OAuth MCP",
      "authMode": "oauth",
      "command": ["true"]
    }
  ]
}`)
  clearConfigCaches()
  clearSettingsCache()

  try {
    saveCustomSkill({
      scope: 'machine',
      directory: null,
      name: 'time-keep',
      content: `---
description: Custom time-keep override
---
Custom override.
`,
    })
    saveCustomMcp({
      scope: 'machine',
      name: 'time-keep',
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
      && conflict.id === 'time-keep'
      && conflict.winnerSource === 'custom:machine'
      && conflict.loserSources.includes('builtin:open-cowork')
    )), true)
    assert.equal(diagnostics.conflicts?.some((conflict) => (
      conflict.kind === 'mcp'
      && conflict.id === 'time-keep'
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
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-provenance-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempRoot
  clearConfigCaches()
  clearSettingsCache()

  try {
    saveSettings({
      integrationEnabled: {
        'time-keep': false,
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
    const timeKeep = diagnostics.capabilities?.find((capability) => capability.kind === 'mcp' && capability.id === 'time-keep')
    const unsafe = diagnostics.capabilities?.find((capability) => capability.kind === 'mcp' && capability.id === 'unsafe-local')

    assert.equal(timeKeep?.status, 'disabled')
    assert.equal(timeKeep?.reasonCode, 'mcp.disabled-by-user')
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

test('getRuntimeInputDiagnostics explains custom skills disabled by managed policy', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-custom-skill-policy-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempRoot
  clearConfigCaches()
  clearSettingsCache()
  resetActiveManagedPolicyCache()

  try {
    saveCustomSkill({
      scope: 'machine',
      directory: null,
      name: 'policy-disabled-skill',
      content: `---\ndescription: Disabled by policy\n---\n# Disabled by policy\n`,
    })
    setActiveManagedPolicy({
      ...EMPTY_MANAGED_POLICY,
      extensions: { ...EMPTY_MANAGED_POLICY.extensions, customSkills: false },
    })

    const diagnostics = getRuntimeInputDiagnostics()
    const disabledSkill = diagnostics.capabilities?.find((capability) => (
      capability.kind === 'skill'
      && capability.id === 'policy-disabled-skill'
    ))

    assert.equal(disabledSkill?.status, 'disabled')
    assert.equal(disabledSkill?.reasonCode, 'skill.custom-disabled-by-policy')
    assert.equal(disabledSkill?.source, 'custom')
    assert.equal(diagnostics.capabilities?.some((capability) => (
      capability.kind === 'skill'
      && capability.id === 'policy-disabled-skill'
      && capability.status === 'active'
    )), false)
  } finally {
    setActiveManagedPolicy(null)
    resetActiveManagedPolicyCache()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    clearSettingsCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
