import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { getRuntimeInputDiagnostics } from '../apps/desktop/src/main/runtime-input-diagnostics.ts'
import { loadSettings, saveSettings } from '../apps/desktop/src/main/settings.ts'

test('getRuntimeInputDiagnostics reports effective provider inputs and override sources', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-runtime-inputs-'))
  const configDir = join(tempRoot, 'config')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const originalSettings = loadSettings()

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), `{
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
  } finally {
    saveSettings(originalSettings)
  }
})
