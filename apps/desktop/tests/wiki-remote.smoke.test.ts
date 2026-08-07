import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchSmokeApp } from './smoke-helpers.ts'

// Smoke (Phase 3): the desktop wiki browse surface can read through a
// REMOTE source — a hosted OpenWiki server connected with a scoped
// service-account token (the same path the "Connect with token" dialog
// button uses). The token is validated with a read probe in main before
// it is persisted, and the UI chip / source dialog reflect the switch.
// The OAuth PKCE path needs a real browser consent session, so this
// smoke covers the token path end-to-end; PKCE is unit-exercised in main.

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(thisDir, '../../..')
const openwikiCli = join(repoRoot, 'products/wiki/packages/cli/dist/openwiki.js')

function runCli(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [openwikiCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitForHealth(origin: string, token: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (response.ok) return
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`hosted wiki did not become healthy at ${origin}`)
}

async function startHostedWiki(): Promise<{ origin: string; token: string; cleanup: () => void }> {
  const wikiRoot = mkdtempSync(join(tmpdir(), 'open-cowork-wiki-remote-'))
  const init = runCli(['init', wikiRoot, '--title', 'Remote Smoke Wiki', '--template', 'basic', '--json'])
  assert.ok(init.ok, `openwiki init failed: ${init.stderr || init.stdout}`)
  const inbox = runCli(['--root', wikiRoot, 'inbox', 'add', '--title', 'Remote Alpha'])
  assert.ok(inbox.ok, `openwiki inbox add failed: ${inbox.stderr || inbox.stdout}`)
  const rebuild = runCli(['--root', wikiRoot, 'db', 'rebuild', '--json'])
  assert.ok(rebuild.ok, `openwiki db rebuild failed: ${rebuild.stderr || rebuild.stdout}`)
  const tokenResult = runCli([
    '--root', wikiRoot,
    'auth', 'token', 'create',
    '--role', 'researcher',
    '--scope', 'wiki:read',
    '--scope', 'wiki:search',
    '--json',
  ])
  assert.ok(tokenResult.ok, `token create failed: ${tokenResult.stderr || tokenResult.stdout}`)
  const tokenPayload = JSON.parse(tokenResult.stdout) as { token?: { value?: string } }
  const token = tokenPayload.token?.value
  assert.ok(token && token.startsWith('owk_agent_'), 'expected an owk_agent_ service token')

  const port = await freePort()
  const serve = spawn(process.execPath, [openwikiCli, '--root', wikiRoot, 'serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    stdio: 'ignore',
  })
  const origin = `http://127.0.0.1:${port}`
  await waitForHealth(origin, token)

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    serve.kill('SIGTERM')
    rmSync(wikiRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 125 })
  }
  return { origin, token, cleanup }
}

test('wiki remote source: token connect + remote browse surface + source switch back to local', async () => {
  const hosted = await startHostedWiki()
  const { page, cleanup } = await launchSmokeApp()
  try {
    await page.waitForSelector('h1:has-text("Good")', { timeout: 60_000 })
    await page.locator('button[data-nav-view="wiki"]').waitFor({ timeout: 15_000 })
    await page.locator('button[data-nav-view="wiki"]').click()
    // Accept the linked surface (page list / chip) or the unlinked state.
    await page
      .locator('text=/pages|Local wiki|No wiki is linked yet|This wiki has no pages yet/')
      .first()
      .waitFor({ timeout: 30_000 })

    // 1. Open the source dialog and connect with a service token through
    //    the real UI (the "Connect with token" flow).
    await page.getByRole('button', { name: 'Sources' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Sources' }).click()
    const originInput = page.locator('input[placeholder*="wiki.example.com"]')
    await originInput.waitFor({ timeout: 10_000 })
    await originInput.fill(hosted.origin)
    await page.locator('textarea[placeholder*="owk_agent_"]').fill(hosted.token)
    await page.getByRole('button', { name: 'Connect with token' }).click()
    // The dialog closes on success.
    await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 15_000 })

    // 2. The header chip now shows the remote origin; all reads go to the
    //    hosted server (overview + pages + graph + search).
    await page.getByText(hosted.origin, { exact: true }).first().waitFor({ timeout: 15_000 })
    const overview = await page.evaluate(() => window.coworkApi?.wiki?.overview() ?? null)
    assert.ok(overview, 'overview returned null')
    assert.equal(overview.source, 'remote')
    assert.equal(overview.origin, hosted.origin)
    assert.equal(overview.status, 'linked', overview.error ?? 'remote overview not linked')

    const list = await page.evaluate(() => window.coworkApi?.wiki?.listPages() ?? [])
    assert.ok(Array.isArray(list) && list.length >= 1, 'remote page list should be non-empty')

    const graph = await page.evaluate(() => window.coworkApi?.wiki?.graph() ?? { nodes: [], edges: [] })
    assert.ok(Array.isArray(graph.nodes) && Array.isArray(graph.edges), 'remote graph should parse')

    const search = await page.evaluate(() => window.coworkApi?.wiki?.search('alpha') ?? [])
    assert.ok(Array.isArray(search), 'remote search should parse')
    await page.screenshot({ path: '/tmp/wiki-remote-connected.png' })

    // 3. Reopen the source dialog: the saved connection is listed with the
    //    origin and marked Active.
    await page.getByRole('button', { name: 'Sources' }).click()
    await page.getByRole('dialog').waitFor({ timeout: 10_000 })
    await page.getByText(hosted.origin, { exact: true }).first().waitFor({ timeout: 10_000 })
    await page.getByText('Use this wiki').first().waitFor({ timeout: 5_000 })
    await page.screenshot({ path: '/tmp/wiki-remote-source-dialog.png' })

    // 4. Switch back to the local wiki from the dialog; the overview flips
    //    to local and the header chip shows the local wiki again.
    const localRow = page.locator('div.rounded-lg', { hasText: 'Local wiki' }).first()
    await localRow.getByRole('button', { name: 'Use' }).click()
    await page.waitForTimeout(800)
    const localOverview = await page.evaluate(() => window.coworkApi?.wiki?.overview() ?? null)
    assert.equal(localOverview?.source, 'local')
    assert.ok(localOverview?.root, 'local root should be present after switching back')
    await page.getByText('Local wiki', { exact: true }).first().waitFor({ timeout: 10_000 })
    await page.screenshot({ path: '/tmp/wiki-remote-back-local.png' })
  } finally {
    await cleanup()
    hosted.cleanup()
  }
})
