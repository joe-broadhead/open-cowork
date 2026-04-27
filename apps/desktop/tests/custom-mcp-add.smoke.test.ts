import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

// Smoke: adding a custom MCP is the first extensibility path a
// downstream fork exercises. It touches the full stack: preload
// (custom:add-mcp, custom:list-mcps), MCP URL policy (SSRF guard),
// config-file writer, runtime reboot, and the subsequent list hydration.
// A regression here silently breaks integration points that forks rely on.

test('custom MCP add → list → remove round-trips through the IPC surface', async () => {
  const { page, cleanup } = await launchSmokeApp()
  const probeName = `e2e-probe-mcp-${randomUUID().slice(0, 8)}`
  const blockedProbeName = `${probeName}-blocked`
  try {
    await waitForAppShell(page)

    // Baseline: count MCPs before the add so a pre-existing MCP from the
    // shipped config cannot false-positive the assertion.
    const initial = await page.evaluate(async () => window.coworkApi.custom.listMcps())
    const initialCount = initial.length
    assert.ok(initialCount >= 0)
    assert.ok(!initial.some((mcp: { name: string }) => mcp.name === probeName))

    // Add an HTTP MCP. Loopback is normally blocked by the SSRF guard,
    // so `allowPrivateNetwork: true` is required — this also doubles as
    // verification that the policy opt-in path flows end-to-end. The
    // URL is never contacted because the smoke harness never sends a
    // prompt; the test only exercises config persistence.
    const saved = await page.evaluate(async (name) => window.coworkApi.custom.addMcp({
      scope: 'machine',
      name,
      label: 'E2E Probe',
      description: 'Added by the custom MCP smoke test',
      type: 'http',
      url: 'http://127.0.0.1:0/',
      allowPrivateNetwork: true,
    }), probeName)
    assert.equal(saved, true, 'addMcp must resolve to true on success')

    // List must now surface the new MCP.
    const afterAdd = await page.evaluate(async () => window.coworkApi.custom.listMcps())
    const probe = afterAdd.find((mcp: { name: string }) => mcp.name === probeName)
    assert.ok(probe, 'newly added MCP must appear in list')
    assert.equal((probe as { type: string }).type, 'http')
    assert.equal((probe as { allowPrivateNetwork?: boolean }).allowPrivateNetwork, true)

    // SSRF guard rejects loopback URLs unless allowPrivateNetwork is set.
    // Try to add a second MCP without the opt-in; it must be rejected.
    const rejected = await page.evaluate(async (name) => {
      try {
        await window.coworkApi.custom.addMcp({
          scope: 'machine',
          name,
          type: 'http',
          url: 'http://127.0.0.1:0/',
        })
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    }, blockedProbeName)
    assert.ok(rejected, 'SSRF guard must reject loopback without allowPrivateNetwork')
    assert.match(rejected as string, /loopback|private/i)

    const afterRejection = await page.evaluate(async () => window.coworkApi.custom.listMcps())
    assert.ok(
      !afterRejection.some((mcp: { name: string }) => mcp.name === blockedProbeName),
      'rejected MCP must not have been persisted',
    )

    // Clean up: the destructive confirmation is issued through IPC, so
    // we exercise the same path the UI would. Cowork returns a
    // confirmation token from a separate IPC; we go directly through
    // the remove handler since we already asserted the add path.
    const removed = await page.evaluate(async (name) => {
      try {
        const confirmation = await window.coworkApi.confirm.requestDestructive({
          action: 'mcp.remove',
          target: { scope: 'machine', name, directory: null },
        })
        return await window.coworkApi.custom.removeMcp(
          { scope: 'machine', name, directory: null },
          confirmation.token,
        )
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    }, probeName)
    assert.equal(removed, true, 'removeMcp must resolve to true on success')

    const afterRemove = await page.evaluate(async () => window.coworkApi.custom.listMcps())
    assert.ok(
      !afterRemove.some((mcp: { name: string }) => mcp.name === probeName),
      'removed MCP must no longer appear in list',
    )
  } finally {
    await cleanup()
  }
})
