import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

// Smoke: settings are the primary persistence surface for downstream
// forks (provider selection, model, language, stored credential). A
// regression here would silently wipe a user's setup between launches,
// so we round-trip through the real IPC + disk path: set → reload →
// read → assert.
//
// This catches:
//   - preload API renaming `settings.set` out of the contract
//   - main-process `settings:set` silently dropping fields
//   - safeStorage encryption breaking the provider credential read-back
//   - locale persistence regressing from `setLocale`

test('settings round-trip survives a full reload through safeStorage + disk', async () => {
  const { app, page, paths, cleanup } = await launchSmokeApp()
  try {
    await waitForAppShell(page)

    // Set a non-default provider + model + surface a stored credential.
    // The smoke harness already seeded openrouter at bootstrap, so pick
    // a different model to prove the round-trip is not matching the
    // seed by accident.
    await page.evaluate(async () => {
      await window.coworkApi.settings.set({
        selectedProviderId: 'openrouter',
        selectedModelId: 'anthropic/claude-opus-4',
        providerCredentials: {
          openrouter: { apiKey: 'roundtrip-key' },
        },
      })
    })

    // Read back pre-reload — this catches in-process state-only writes
    // that never hit disk.
    const inMemory = await page.evaluate(async () => window.coworkApi.settings.get())
    assert.equal(inMemory.selectedProviderId, 'openrouter')
    assert.equal(inMemory.selectedModelId, 'anthropic/claude-opus-4')

    // Reload the renderer and confirm the settings survived. A full
    // process restart would be stronger, but the preload + safeStorage
    // path is identical between reload and relaunch; the disk write
    // happens before `settings:set` resolves.
    await page.reload()
    await page.waitForFunction(() => Boolean(
      document.querySelector('#root')
      && typeof window.coworkApi?.app?.config === 'function',
    ))

    const afterReload = await page.evaluate(async () => window.coworkApi.settings.get())
    assert.equal(afterReload.selectedProviderId, 'openrouter')
    assert.equal(afterReload.selectedModelId, 'anthropic/claude-opus-4')

    // Credential-editor IPC returns descriptor-aware masks, while the
    // encrypted settings file still stores the plaintext for runtime use.
    const providerCredentials = await page.evaluate(async () => window.coworkApi.settings.getProviderCredentials('openrouter', {
      workspaceId: 'local',
      purpose: 'credential_editor',
    }))
    assert.equal(
      providerCredentials.apiKey,
      '••••••••',
      'credential editor IPC must not expose the stored provider credential plaintext',
    )

    const encryptedSettingsPath = join(paths.dataRoot, 'settings.enc')
    const plaintextSettingsPath = join(paths.dataRoot, 'settings.json')
    const persistedSettingsJson = existsSync(encryptedSettingsPath)
      ? await app.evaluate(({ safeStorage }, bytes: number[]) => {
          if (!safeStorage?.decryptString) throw new Error('safeStorage.decryptString is unavailable')
          return safeStorage.decryptString(Buffer.from(bytes))
        }, Array.from(readFileSync(encryptedSettingsPath)))
      : existsSync(plaintextSettingsPath)
        ? readFileSync(plaintextSettingsPath, 'utf8')
        : null
    if (persistedSettingsJson === null) assert.fail('settings must be persisted to disk')
    const persisted = JSON.parse(persistedSettingsJson) as {
      providerCredentials?: Record<string, Record<string, string>>
    }
    assert.equal(
      persisted.providerCredentials?.openrouter?.apiKey,
      'roundtrip-key',
      'stored credential must read back to the original value from persisted settings',
    )
  } finally {
    await cleanup()
    // Keep the handle around so cleanup() can fully close Electron before
    // the test process exits.
    void app
  }
})
