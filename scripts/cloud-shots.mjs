// Reusable visual-QA harness for the running cloud app (the unified renderer).
// Drives the system Chrome via playwright-core (no browser download) against a
// live cloud server, navigates each workbench surface via the sidebar nav, and
// writes a full-page screenshot per surface plus a per-surface console/CSP error
// count. Since the cloud now serves the same `apps/desktop` renderer as the
// Electron app, this doubles as a desktop↔cloud visual-parity check.
//
// Usage:
//   node scripts/cloud-shots.mjs [baseUrl] [outDir]
//   node scripts/cloud-shots.mjs http://localhost:8787 /tmp/cloud-shots
//
// Resolve playwright-core from the desktop workspace (it's a devDependency there,
// used by the packaged smoke tests).
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromDesktop = createRequire(resolve(here, '../apps/desktop/package.json'))
const { chromium } = requireFromDesktop('playwright-core')

const BASE = process.argv[2] || 'http://localhost:8787'
const OUT = process.argv[3] || '/tmp/cloud-shots'
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Workbench surfaces, addressed by the visible sidebar nav label (the renderer's
// actual nav items; Settings/Diagnostics live behind a separate control).
const SURFACES = [
  { label: 'Home', file: '01-home' },
  { label: 'Projects', file: '02-projects' },
  { label: 'Knowledge', file: '03-knowledge' },
  { label: 'Approvals', file: '04-approvals' },
  { label: 'Team', file: '05-coworkers' },
  { label: 'Playbooks', file: '06-playbooks' },
  { label: 'Channels', file: '07-channels' },
  { label: 'Tools & Skills', file: '08-capabilities' },
  { label: 'Artifacts', file: '09-artifacts' },
]

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })

let cspCount = 0
const otherErrors = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  if (/Content Security Policy/i.test(m.text())) cspCount += 1
  else otherErrors.push(m.text().slice(0, 140))
})
page.on('pageerror', (e) => otherErrors.push('PAGEERR: ' + e.message.slice(0, 140)))

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch((e) => {
  otherErrors.push('goto: ' + e.message)
})
// Let the SPA hydrate + the renderer inject the studio surface styles (mercury).
await page.waitForTimeout(3000)

const results = []
for (const surface of SURFACES) {
  cspCount = 0
  // The renderer's sidebar nav renders each surface as a labelled button/link.
  const link = page.locator('aside button, aside a, nav button, nav a', { hasText: surface.label }).first()
  let navigated = false
  if (await link.count()) {
    await link.click().catch(() => {})
    await page.waitForTimeout(1200)
    navigated = true
  }
  const path = resolve(OUT, surface.file + '.png')
  await page.screenshot({ path, fullPage: true }).catch((e) => otherErrors.push(surface.file + ' shot: ' + e.message))
  results.push({ surface: surface.label, file: path, navigated, csp: cspCount })
}

process.stdout.write(JSON.stringify({ base: BASE, out: OUT, results, otherErrors: otherErrors.slice(0, 12) }, null, 2) + '\n')
await browser.close()
