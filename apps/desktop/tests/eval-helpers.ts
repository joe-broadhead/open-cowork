import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from 'playwright-core'
import { repoRoot, waitForAppShell } from './smoke-helpers.ts'

// Shared utilities for the monthly "eval flow" suite. These are higher-level,
// user-journey checks that build on the same real-Electron harness as the
// *.smoke.test.ts specs (see smoke-helpers.ts), but they also capture
// screenshot/video evidence per flow and run a lightweight, dependency-free
// visual-regression diff against committed baselines.
//
// Everything here is designed to PARSE / typecheck and run through the
// existing smoke runner. A full run still needs a real display (xvfb on
// Linux) because it drives the packaged/dev Electron app — that is what the
// monthly workflow provides.

export const EVAL_ARTIFACT_DIR = resolve(
  repoRoot,
  process.env.OPEN_COWORK_EVAL_ARTIFACT_DIR?.trim() || 'apps/desktop/test-artifacts/evals',
)

// Baselines live in-tree so a large visual change shows up as a reviewable
// diff. On first run (or when explicitly updating) missing baselines are
// seeded here and must be accepted/committed by a maintainer.
export const VISUAL_BASELINE_DIR = resolve(repoRoot, 'apps/desktop/tests/visual-baselines')

// Fraction of sampled pixels allowed to differ before a surface is flagged.
// Deliberately generous: this guards against large/structural regressions
// (a broken layout, a blank surface, a theme flip), not sub-pixel churn.
const DEFAULT_DIFF_THRESHOLD = 0.04
const DEFAULT_PER_PIXEL_TOLERANCE = 24 // 0-255 per channel
const COMPARE_WIDTH = 320 // downscale both images to this width before diffing

export function shouldUpdateBaselines(): boolean {
  const raw = process.env.OPEN_COWORK_EVAL_UPDATE_BASELINES?.trim()
  return raw === '1' || raw === 'true'
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function evalFlowDir(flow: string): string {
  return ensureDir(join(EVAL_ARTIFACT_DIR, flow))
}

// Capture a PNG into the per-flow evidence directory and return its path.
export async function captureEvidence(page: Page, flow: string, name: string): Promise<string> {
  const dir = evalFlowDir(flow)
  const path = join(dir, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  process.stdout.write(`[eval] evidence ${flow}/${name}.png\n`)
  return path
}

export async function setColorScheme(page: Page, scheme: 'light' | 'dark') {
  await page.evaluate((value) => {
    localStorage.setItem('open-cowork-color-scheme', value)
  }, scheme)
  await page.reload()
  await waitForAppShell(page, 30_000)
  await page
    .waitForFunction(
      (value) => document.documentElement.getAttribute('data-color-scheme') === value,
      scheme,
      { timeout: 5_000 },
    )
    .catch(() => undefined)
}

export interface VisualComparison {
  name: string
  seeded: boolean
  diffRatio: number
  threshold: number
  passed: boolean
}

// Compare the current page against a committed baseline PNG.
//
// The pixel diff runs *inside the renderer* via canvas: Chromium decodes both
// PNGs (baseline + freshly captured) natively, so we need no Node-side PNG
// decoder and therefore no new dependency. Images loaded from data: URLs do
// not taint the canvas, so getImageData works. If no baseline exists (or when
// OPEN_COWORK_EVAL_UPDATE_BASELINES=1) the current capture is written as the
// new baseline and the comparison passes with `seeded: true` — a maintainer
// then reviews and commits it.
export async function compareToBaseline(
  page: Page,
  name: string,
  options?: { threshold?: number; perPixelTolerance?: number },
): Promise<VisualComparison> {
  const threshold = options?.threshold ?? DEFAULT_DIFF_THRESHOLD
  const perPixelTolerance = options?.perPixelTolerance ?? DEFAULT_PER_PIXEL_TOLERANCE
  ensureDir(VISUAL_BASELINE_DIR)
  const baselinePath = join(VISUAL_BASELINE_DIR, `${name}.png`)

  const currentBuffer = await page.screenshot({ fullPage: false })

  const seedBaseline = (): VisualComparison => {
    writeFileSync(baselinePath, currentBuffer)
    process.stdout.write(`[eval] seeded visual baseline ${name}.png (maintainer must review + commit)\n`)
    return { name, seeded: true, diffRatio: 0, threshold, passed: true }
  }

  if (shouldUpdateBaselines()) return seedBaseline()

  // Read the baseline directly rather than existsSync-then-read (a check-then-use
  // race); a missing baseline is the seed path.
  let baselineBuffer: Buffer
  try {
    baselineBuffer = readFileSync(baselinePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return seedBaseline()
    throw error
  }

  const baselineBase64 = baselineBuffer.toString('base64')
  const currentBase64 = currentBuffer.toString('base64')

  const diffRatio = await page.evaluate(
    async ({ baseline, current, width, tolerance }) => {
      function load(src: string): Promise<HTMLImageElement> {
        return new Promise((resolveImage, rejectImage) => {
          const image = new Image()
          image.onload = () => resolveImage(image)
          image.onerror = () => rejectImage(new Error('failed to decode image'))
          image.src = src
        })
      }
      const [a, b] = await Promise.all([
        load(`data:image/png;base64,${baseline}`),
        load(`data:image/png;base64,${current}`),
      ])
      const ratio = a.width > 0 ? a.height / a.width : 1
      const w = width
      const h = Math.max(1, Math.round(w * ratio))

      function pixels(image: HTMLImageElement): Uint8ClampedArray {
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        ctx.drawImage(image, 0, 0, w, h)
        return ctx.getImageData(0, 0, w, h).data
      }

      const pa = pixels(a)
      const pb = pixels(b)
      const total = w * h
      let differing = 0
      for (let i = 0; i < pa.length; i += 4) {
        const dr = Math.abs(pa[i]! - pb[i]!)
        const dg = Math.abs(pa[i + 1]! - pb[i + 1]!)
        const db = Math.abs(pa[i + 2]! - pb[i + 2]!)
        if (dr > tolerance || dg > tolerance || db > tolerance) differing += 1
      }
      return total > 0 ? differing / total : 0
    },
    { baseline: baselineBase64, current: currentBase64, width: COMPARE_WIDTH, tolerance: perPixelTolerance },
  )

  // Persist the current capture as evidence alongside the diff outcome.
  const evidencePath = join(evalFlowDir('visual-regression'), `${name}.png`)
  writeFileSync(evidencePath, currentBuffer)

  const passed = diffRatio <= threshold
  process.stdout.write(
    `[eval] visual ${name}: diff=${(diffRatio * 100).toFixed(2)}% threshold=${(threshold * 100).toFixed(2)}% ${passed ? 'OK' : 'FLAGGED'}\n`,
  )
  return { name, seeded: false, diffRatio, threshold, passed }
}

type OpenCoworkEvalBridge = {
  enabled: true
  setAdminAccess: (access: {
    role: 'admin'
    customRoleKey: null
    permissions: string[]
    email: null
    ssoVerified: false
  } | null) => void
  setEntitlements: (entitlements: {
    provider: string
    gatingEnabled: boolean
    billingEnabled: boolean
    planKey: null
    planLabel: null
    subscriptionStatus: null
    seats: null
    features: Record<string, never>
    limits: Record<string, never>
  } | null) => void
  getPermissionResponses: () => Array<{ id: string; allowed: boolean }>
  clearPermissionResponses: () => void
  emitPermissionRequest: (request: {
    id: string
    sessionId: string
    tool: string
    input: Record<string, unknown>
    description: string
    workspaceId?: string | null
  }) => Promise<number>
}

// Install a deterministic, offline "eval bridge" over the renderer *before* the
// app mounts. Electron's contextBridge freezes `window.coworkApi`, so the old
// approach of reassigning `on.permissionRequest` / `admin.access` after expose
// silently failed (non-strict assignment) while still marking the bridge
// "installed" — which is what made admin nav + synthetic approval evals red.
//
// Smoke runs set OPEN_COWORK_E2E=1, which makes preload expose
// `window.__openCoworkEval` with real seams:
//   - admin.access / entitlements overrides built into the API before freeze
//   - permission.respond records offline resolutions
//   - emitPermissionRequest broadcasts via main → permission:request IPC so
//     the app's real subscriber receives the event
//
// Contract selector: `[data-nav-view="admin"]` (Sidebar ADMIN_NAV_ITEM).
export async function installEvalBridge(
  page: Page,
  options?: { adminPermissions?: string[] },
) {
  await page.addInitScript((config: { adminPermissions?: string[] }) => {
    const globalRef = window as unknown as {
      __openCoworkEval?: OpenCoworkEvalBridge
      __coworkEval?: {
        installed: boolean
        permissionResponses: Array<{ id: string; allowed: boolean }>
      }
    }

    function apply() {
      const evalApi = globalRef.__openCoworkEval
      if (!evalApi?.enabled) {
        globalRef.__coworkEval = { installed: false, permissionResponses: [] }
        return false
      }

      if (config.adminPermissions && config.adminPermissions.length > 0) {
        evalApi.setAdminAccess({
          role: 'admin',
          customRoleKey: null,
          permissions: config.adminPermissions,
          email: null,
          ssoVerified: false,
        })
        evalApi.setEntitlements({
          provider: 'eval',
          gatingEnabled: false,
          billingEnabled: false,
          planKey: null,
          planLabel: null,
          subscriptionStatus: null,
          seats: null,
          features: {},
          limits: {},
        })
      }

      evalApi.clearPermissionResponses()
      globalRef.__coworkEval = { installed: true, permissionResponses: [] }
      return true
    }

    // Preload exposes __openCoworkEval before page scripts; init scripts run
    // after the document is created. Prefer immediate apply, fall back to a
    // short poll for slower preload wiring.
    if (apply()) return
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      if (apply() || attempts > 50) window.clearInterval(timer)
    }, 20)
  }, { adminPermissions: options?.adminPermissions })
}

export async function getEvalBridgeState(page: Page): Promise<{
  installed: boolean
  permissionResponses: Array<{ id: string; allowed: boolean }>
}> {
  return page.evaluate(() => {
    const globalRef = window as unknown as {
      __openCoworkEval?: OpenCoworkEvalBridge
      __coworkEval?: { installed: boolean }
    }
    const evalApi = globalRef.__openCoworkEval
    return {
      installed: Boolean(globalRef.__coworkEval?.installed && evalApi?.enabled),
      permissionResponses: evalApi?.getPermissionResponses() ?? [],
    }
  })
}

export async function emitSyntheticApproval(
  page: Page,
  request: {
    id: string
    sessionId: string
    tool: string
    input: Record<string, unknown>
    description: string
    workspaceId?: string | null
  },
): Promise<number> {
  return page.evaluate(async (payload) => {
    const evalApi = (window as unknown as { __openCoworkEval?: OpenCoworkEvalBridge }).__openCoworkEval
    if (!evalApi?.enabled) return 0
    // Bind to the active workspace so useOpenCodeEvents.isActiveWorkspaceEvent accepts it.
    const workspaceId = payload.workspaceId
      ?? (window as unknown as { __openCoworkActiveWorkspaceId?: string | null }).__openCoworkActiveWorkspaceId
      ?? null
    return evalApi.emitPermissionRequest({ ...payload, workspaceId })
  }, request)
}

// Seed a provider selection + placeholder credential so the app boots past
// the first-run SetupScreen into the main shell. Mirrors bootstrapSmokeSettings
// but is exposed here so onboarding-focused eval flows can assert the
// before/after transition explicitly. The placeholder key never reaches a
// real provider — eval flows are deterministic and offline.
export async function completeProviderSetup(page: Page) {
  await page.evaluate(async () => {
    await window.coworkApi.settings.set({
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      providerCredentials: {
        openrouter: { apiKey: 'placeholder-key' },
      },
    })
  })
  await page.reload()
  await waitForAppShell(page, 30_000)
}
