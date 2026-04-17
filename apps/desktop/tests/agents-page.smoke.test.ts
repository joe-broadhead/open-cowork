import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke: the Agents page depends on `agents:list`, `agents:catalog`,
// `app:builtin-agents`, and `agents:runtime` all returning usable data
// and the selection-card components composing correctly. A broken
// IPC path would render an empty grid; a broken card component would
// throw into the ViewErrorBoundary. This test catches both.

test('agents page renders built-in + custom sections with the import / new buttons', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    // Nav to Agents via the sidebar. The sidebar buttons render a plain
    // label (not a title attr), so we match by accessible name. The
    // sidebar is the only surface with an "Agents" button at app boot.
    await page.waitForSelector('h1:has-text("Workspace state")', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Agents', exact: true }).first().click()

    // Header copy anchors the page after the view swap. We wait before
    // asserting anything else so the lazy-loaded AgentsPage has had a
    // chance to mount.
    await page.waitForSelector('h1:has-text("Agents")', { timeout: 10_000 })

    // "Built-in agents" section always has content (the OpenCode
    // primaries + Cowork-shipped charts/research/skill-builder agents
    // that come from open-cowork.config.json).
    await page.getByText('Built-in agents', { exact: true }).waitFor({ timeout: 5_000 })

    // At least one built-in card should be present — we check for
    // "Built-in" type pills. >= 3 is conservative (primaries + charts).
    const builtInCount = await page.locator('text=Built-in').count()
    assert.ok(builtInCount >= 3, `expected multiple Built-in cards, saw ${builtInCount}`)

    // The Import + New agent buttons are the two actions that prove the
    // page wired its header correctly.
    await page.getByRole('button', { name: /^Import/ }).waitFor({ timeout: 5_000 })
    await page.getByRole('button', { name: /New agent/ }).waitFor({ timeout: 5_000 })

    // Search box is the first focusable input on the page.
    const search = page.locator('input[placeholder*="Search agents"]')
    await search.waitFor({ timeout: 5_000 })
    await search.fill('nonexistent-xyz-filter')
    // After an impossible search, the built-in list should render the
    // empty-state hint rather than throw.
    await page.getByText('No built-ins matched your search.', { exact: true }).waitFor({ timeout: 5_000 })
  } finally {
    await cleanup()
  }
})
