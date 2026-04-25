import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CDPSession, Page } from 'playwright-core'
import {
  cleanupSmokePaths,
  createSmokePaths,
  launchSmokeSession,
  repoRoot,
  type SmokeSession,
  waitForAppShell,
} from './smoke-helpers.ts'

// Drives the same Electron harness the smoke tests use, but instead of
// asserting layout it walks the entire app surface and writes PNGs into
// docs/assets/auto/. Every shot is dark-mode at 1600x1000 (DSF=1) to
// match the manual-capture guidelines in docs/assets/README.md and to
// stay deterministic across machines.

const VIEWPORT = { width: 1600, height: 1000 }
const SETTLE_MS = 450

let cdp: CDPSession | null = null

async function ensureCdp(page: Page) {
  if (!cdp) {
    cdp = await page.context().newCDPSession(page)
  }
  return cdp
}

async function pinViewport(page: Page) {
  const session = await ensureCdp(page)
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  })
}

async function applyDarkMode(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem('open-cowork-color-scheme', 'dark')
  })
  await page.reload()
  await waitForAppShell(page, 30_000)
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-color-scheme') === 'dark',
    null,
    { timeout: 5_000 },
  )
  cdp = null // CDP session is invalidated on reload
  await pinViewport(page)
}

function resolveScreenshotExecutable() {
  const executable = process.env.OPEN_COWORK_SCREENSHOT_EXECUTABLE?.trim()
  if (!executable) return undefined
  const resolved = resolve(repoRoot, executable)
  if (resolved.endsWith('.app')) {
    return join(resolved, 'Contents/MacOS/Open Cowork')
  }
  return resolved
}

async function shoot(page: Page, outputDir: string, name: string) {
  await page.waitForTimeout(SETTLE_MS)
  const path = join(outputDir, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  process.stdout.write(`[screenshots]   ${name}\n`)
}

async function gotoHome(page: Page) {
  await page.getByRole('button', { name: 'Home', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("What shall we cowork on today?")', { timeout: 30_000 })
}

async function gotoPulse(page: Page) {
  await page.getByRole('button', { name: 'Pulse', exact: true }).first().click()
  await page.waitForSelector(
    'h1:has-text("Workspace state, capabilities, and runtime health in one view.")',
    { timeout: 30_000 },
  )
}

async function gotoAgents(page: Page) {
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("Agents")', { timeout: 30_000 })
  await page.getByText('Built-in agents', { exact: true }).waitFor({ timeout: 10_000 })
}

async function gotoCapabilities(page: Page) {
  await page.getByRole('button', { name: 'Capabilities', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("Capabilities")', { timeout: 30_000 })
}

async function gotoAutomations(page: Page) {
  await page.getByRole('button', { name: 'Automations', exact: true }).first().click()
  await page.getByRole('heading', {
    name: 'Turn repeatable work into a standing agent program',
    exact: true,
  }).waitFor({ timeout: 30_000 })
}

async function captureSettingsTabs(page: Page, outputDir: string) {
  // Open the Settings panel from the sidebar — this expands the sidebar
  // to ~640px and replaces ThreadList with the SettingsPanel component.
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await page.waitForSelector('text=Appearance', { timeout: 10_000 })

  // Each settings tab button renders the label + a description on the
  // next line, so the accessible name is "Appearance Theme, color
  // scheme, and fonts". Match the leading label rather than exact-name.
  const tabs: Array<{ pattern: RegExp; id: string }> = [
    { pattern: /^Appearance\b/, id: 'settings-appearance' },
    { pattern: /^Models\b/, id: 'settings-models' },
    { pattern: /^Permissions\b/, id: 'settings-permissions' },
    { pattern: /^Automations\b/, id: 'settings-automations' },
    { pattern: /^Storage\b/, id: 'settings-storage' },
  ]

  for (const tab of tabs) {
    await page.locator('aside').getByRole('button', { name: tab.pattern }).first().click()
    await page.waitForTimeout(200)
    await shoot(page, outputDir, tab.id)
  }

  // SettingsPanel exposes a "Done" button that calls onClose — clicking
  // it collapses the sidebar back to the normal nav width.
  await page.locator('aside').getByRole('button', { name: /^Done$/ }).first().click().catch(() => undefined)
  await page.waitForTimeout(200)
}

async function captureCapabilitiesViews(page: Page, outputDir: string) {
  await gotoCapabilities(page)
  await shoot(page, outputDir, 'capabilities-tools')

  // Switch to Skills tab. The tab strip is a row of buttons inside the
  // page header, exact-name match avoids sidebar collisions.
  const mainArea = page.locator('main')
  await mainArea.getByRole('button', { name: 'Skills', exact: true }).first().click()
  await page.waitForTimeout(200)
  await shoot(page, outputDir, 'capabilities-skills')

  // Open the Add skill form
  await mainArea.getByRole('button', { name: 'Add skill', exact: true }).click()
  await page.waitForTimeout(400)
  await shoot(page, outputDir, 'capabilities-add-skill')

  // Cancel back to Skills tab
  await mainArea.getByRole('button', { name: /Cancel/i }).first().click()
  await page.waitForTimeout(200)

  // Switch back to Tools and open Add tool
  await mainArea.getByRole('button', { name: 'Tools', exact: true }).first().click()
  await page.waitForTimeout(150)
  await mainArea.getByRole('button', { name: 'Add tool', exact: true }).click()
  await page.waitForTimeout(400)
  await shoot(page, outputDir, 'capabilities-add-tool')

  await mainArea.getByRole('button', { name: /Cancel/i }).first().click()
  await page.waitForTimeout(200)

  // Open the first tool detail card. CapabilitySelectionCard renders
  // each card as `<button class="w-full text-start p-4 ...">`, so the
  // class combo is a stable selector that won't match the action row.
  const cards = await mainArea.locator('button.text-start.p-4').all()
  if (cards.length > 0) {
    await cards[0]!.click()
    await page.waitForTimeout(400)
    await shoot(page, outputDir, 'capabilities-tool-detail')
    // The detail page has a back button labeled "Capabilities" with a
    // chevron icon — clicking it returns to the grid.
    await mainArea.getByRole('button', { name: /^Capabilities$/ }).first().click().catch(() => undefined)
    await page.waitForTimeout(200)
  } else {
    console.warn('[screenshots]   (no capability cards found, skipping detail view)')
  }
}

async function captureAgentsViews(page: Page, outputDir: string) {
  await gotoAgents(page)
  await shoot(page, outputDir, 'agents')

  // Open the template picker via "New agent"
  await page.getByRole('button', { name: /New agent/ }).click()
  // The picker header is unique copy that won't appear elsewhere on the page.
  await page.getByRole('heading', { name: 'Start a new agent', exact: true }).waitFor({ timeout: 10_000 })
  await shoot(page, outputDir, 'agents-template-picker')

  // Pick "Start from blank" — that's the last template in the picker
  // and unconditionally routes into the AgentBuilderPage with a blank
  // seed. No heuristics, no card-text matching.
  await page.getByRole('button', { name: /Start from blank/i }).click()
  // AgentBuilderPage has a unique "Create agent" save button at the
  // top-right that doesn't appear on the agents list or anywhere else.
  await page.getByRole('button', { name: 'Create agent', exact: true }).waitFor({ timeout: 10_000 })
  await shoot(page, outputDir, 'agents-builder')

  // Exit the builder. Cancel button rejoins the agents grid.
  await page.locator('main').getByRole('button', { name: 'Cancel', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("Agents")', { timeout: 10_000 })

  // Click a real built-in agent card to capture the builder in
  // read/edit mode (with skills, tools, and instructions populated).
  // Card click target = `<button class="w-full text-start p-4 ...">`.
  const cards = page.locator('main button.text-start.p-4')
  if (await cards.count()) {
    await cards.first().click()
    // Built-in agents render the picker in read-only mode; the back
    // affordance is the chevron-left "Agents" link, but the page also
    // shows the Skills/Tools/Instructions/Inference tab strip — wait
    // on a tab that won't collide with the agents grid.
    await page.locator('main').getByRole('button', { name: 'Inference', exact: true }).waitFor({ timeout: 10_000 })
    await shoot(page, outputDir, 'agents-builder-detail')
    // Exit via the chevron back link
    await page.locator('main').getByRole('button', { name: /^Agents$/ }).first().click().catch(() => undefined)
    await page.waitForSelector('h1:has-text("Agents")', { timeout: 10_000 })
  }
}

async function captureAutomationsViews(page: Page, outputDir: string) {
  await gotoAutomations(page)
  await shoot(page, outputDir, 'automations-overview')

  // Try a template prefill for a richer overview shot.
  const template = page.locator('main').getByRole('button', { name: 'Managed project', exact: true })
  if (await template.count()) {
    await template.first().click()
    await page.waitForTimeout(300)
    await shoot(page, outputDir, 'automations-template')
  }

  // Create the automation, capture the resulting detail view.
  const titleInput = page.getByPlaceholder('Weekly market report')
  await titleInput.fill('Weekly market report')
  const briefInput = page.getByPlaceholder('Build a weekly analysis and market research report and keep it ready for review every Monday morning.')
  await briefInput.fill('Build a weekly market and performance report for leadership.')
  await page.getByRole('button', { name: 'Create automation', exact: true }).click()
  await page.getByRole('heading', { name: 'Weekly market report', exact: true }).waitFor({ timeout: 10_000 })
  await shoot(page, outputDir, 'automations-detail')
}

async function captureChatViews(page: Page, outputDir: string) {
  await gotoHome(page)
  // Use the sidebar new-thread path so the Chat surface is real, but
  // avoid firing a provider request. Screenshot runs should not depend
  // on API keys or capture a missing-credential error banner.
  await page.getByRole('button', { name: 'New Thread', exact: true }).click()
  await page.getByRole('button', { name: /^Blank thread\b/ }).click()
  await page.waitForSelector('h1:has-text("What shall we cowork on today?")', {
    state: 'detached',
    timeout: 15_000,
  })
  // Wait for the chat composer to mount — that's our signal the chat
  // view has fully painted.
  const chatComposer = page.locator('textarea').first()
  await chatComposer.waitFor({ timeout: 15_000 })
  await page.waitForTimeout(500)
  await shoot(page, outputDir, 'chat-thread')

  // Mention picker
  await chatComposer.fill('')
  await chatComposer.type('@')
  await page.waitForSelector('text=/research|explore|build|plan|charts/i', { timeout: 5_000 })
  await page.waitForTimeout(200)
  await shoot(page, outputDir, 'chat-mention-picker')

  // Clear so future captures don't carry residue
  await chatComposer.fill('')
}

async function captureSidebarSearch(page: Page, outputDir: string) {
  await gotoHome(page)
  // The sidebar search toggle lives next to the New thread button —
  // it's the second button in the top sidebar row.
  const searchToggle = page.locator('aside button[title*="Search"]').first()
  if (await searchToggle.count()) {
    await searchToggle.click()
    await page.waitForTimeout(250)
    await shoot(page, outputDir, 'sidebar-search')
    // Close it back
    await page.keyboard.press('Escape').catch(() => undefined)
    await page.waitForTimeout(150)
  } else {
    console.warn('[screenshots]   (sidebar search toggle not found)')
  }
}

async function main() {
  const outputDir = resolve(repoRoot, 'docs/assets/auto')
  const captureDir = mkdtempSync(join(tmpdir(), 'open-cowork-screenshots-'))
  process.stdout.write(`[screenshots] output dir: ${outputDir}\n`)

  const paths = createSmokePaths()
  let session: SmokeSession | null = null
  try {
    session = await launchSmokeSession(paths, { executablePath: resolveScreenshotExecutable() })
    const page = session.page

    await pinViewport(page)
    await applyDarkMode(page)

    // Section: top-level pages (clean state)
    await gotoHome(page); await shoot(page, captureDir, 'home')
    await gotoPulse(page); await shoot(page, captureDir, 'pulse')

    // Section: capabilities (multi-view)
    await captureCapabilitiesViews(page, captureDir)

    // Section: agents (list + template picker + builder)
    await captureAgentsViews(page, captureDir)

    // Section: automations (overview, template, detail)
    await captureAutomationsViews(page, captureDir)

    // Section: settings panel tabs
    await gotoHome(page)
    await captureSettingsTabs(page, captureDir)

    // Section: sidebar search
    await captureSidebarSearch(page, captureDir)

    // Section: chat thread + mention picker (mutates state, run last)
    await captureChatViews(page, captureDir)

    rmSync(outputDir, { recursive: true, force: true })
    mkdirSync(resolve(outputDir, '..'), { recursive: true })
    renameSync(captureDir, outputDir)
  } finally {
    await session?.close()
    cleanupSmokePaths(paths)
    rmSync(captureDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[screenshots] failed:', error)
  process.exit(1)
})
