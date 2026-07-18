import { getConfig } from '../../config.js'
import { ensureLocalHttpAdminTokenFile } from '../../security.js'
import { argValue, assertConfigured, gatewayFetch, hasArg, openUrl, postGatewayJson } from '../shared.js'
import { start } from './lifecycle.js'

/**
 * Guided first-run. Thin wrapper: builds an HTTP daemon gateway + a console
 * narrator, then delegates the entire flow to the transport-agnostic
 * `runQuickstart` core (src/quickstart.ts) so the same logic is driven
 * deterministically by the end-to-end test.
 */
export async function quickstartCommand() {
  assertConfigured('quickstart')
  const quickstart = await import('../../quickstart.js')
  const config = getConfig()
  const json = hasArg('--json')

  const gateway: import('../../quickstart.js').QuickstartGateway = {
    getHealth: async () => {
      try {
        const res = await gatewayFetch('/health')
        if (!res.ok) return { ok: false }
        const body = await res.json().catch(() => ({})) as { uptime?: number }
        return { ok: true, uptimeSeconds: body.uptime }
      } catch { return null }
    },
    dispatchNow: async input => postGatewayJson('/workflows/dispatch-now', input),
    getTask: async taskId => {
      try {
        const res = await gatewayFetch(`/tasks/${encodeURIComponent(taskId)}`)
        if (!res.ok) return null
        const body = await res.json().catch(() => ({})) as { task?: import('../../quickstart.js').QuickstartTaskView }
        return body.task ?? null
      } catch { return null }
    },
    // Confirm the CLI's bearer token is accepted for WRITE calls BEFORE any work
    // is created. Under `capabilityScopedLoopback`, local reads are allowed
    // token-free but writes are not, so a running daemon that lacks the admin
    // token would 403 the dispatch and orphan the work. A dispatch-now with a
    // bogus task id is auth-checked first (403) and otherwise short-circuits with
    // 404 before any scheduler cycle, so it is a safe, side-effect-free probe.
    checkWriteAccess: async () => {
      try {
        const res = await gatewayFetch('/workflows/dispatch-now', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taskId: '__quickstart_write_probe__' }),
        })
        if (res.status === 403) return { ok: false, status: 403 }
        return { ok: true, status: res.status }
      } catch { return { ok: true } }
    },
  }

  const narrator: import('../../quickstart.js').QuickstartNarrator = json
    ? { step() {}, detail() {}, success() {}, warn() {} }
    : { step: message => console.log(`\n${message}`), detail: message => console.log(message), success: message => console.log(message), warn: message => console.error(message) }

  // Provision the local admin token up front so the CLI can authenticate WRITE
  // calls (dispatch, task creation) to a hardened daemon. Benign + idempotent;
  // the value is never printed.
  try { ensureLocalHttpAdminTokenFile() } catch {}

  const timeoutArg = argValue('--timeout')
  let timeoutMs: number | undefined
  if (timeoutArg !== undefined) {
    const seconds = Number(timeoutArg)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      console.error(`Invalid --timeout: "${timeoutArg}". Provide a positive number of seconds (e.g. --timeout 180).`)
      process.exit(1)
    }
    timeoutMs = seconds * 1000
  }
  const result = await quickstart.runQuickstart({
    gateway,
    narrator,
    config,
    title: argValue('--title'),
    taskDescription: argValue('--task'),
    timeoutMs,
    ensureDaemon: hasArg('--no-start') ? undefined : async () => { await start({ progressToStderr: json }); return (await gateway.getHealth())?.ok === true },
  })

  if (json) console.log(JSON.stringify(result, null, 2))
  if (result.ok && hasArg('--open') && result.runUrl) await openUrl(result.runUrl)
  if (!result.ok) process.exit(1)
}

export async function onboardCommand() {
  const config = getConfig()
  const { installGatewayOpenCodeAssets } = await import('../../opencode-defaults.js')
  const product = await import('../../product-onboarding.js')
  const installed = installGatewayOpenCodeAssets(config.opencodeConfigDir)
  console.log('OpenCode Gateway onboarding')
  console.log(`OpenCode assets: installed ${installed.mcp} MCP, ${installed.agents.length} agents, ${installed.skills.length} skills`)
  console.log(`Daemon URL: http://127.0.0.1:${config.httpPort}`)
  console.log(`Dashboard: ${product.dashboardUrl(config)}`)

  const template = argValue('--template')
  if (template) {
    const written = product.writeEnvironmentTemplate(template as any, argValue('--dir') || process.cwd(), { force: hasArg('--force') })
    console.log(`${written.created ? 'Created' : 'Kept existing'} environment template: ${written.path}`)
  }

  if (hasArg('--demo')) {
    const demo = product.createDemoProject({ dashboardUrl: product.dashboardUrl(config) })
    console.log(`Demo project: ${demo.roadmap.title} (${demo.roadmap.id})`)
    console.log(`Demo artifact: ${demo.artifactPath}`)
  }

  if (hasArg('--start')) await start()
  if (hasArg('--open')) await openUrl(product.dashboardUrl(config))

  console.log('Next: run `opencode-gateway quickstart` for a guided first real task, or create work directly with `opencode-gateway project new <alias> --title "..." --task "..."`.')
}

export async function demoCommand() {
  const product = await import('../../product-onboarding.js')
  const config = getConfig()
  const demo = product.createDemoProject({ dashboardUrl: product.dashboardUrl(config) })
  console.log('Gateway demo created without starting OpenCode or spending model tokens.')
  console.log(`Project: ${demo.roadmap.title} (${demo.roadmap.id})`)
  console.log(`Issues: ${demo.tasks.length}`)
  console.log(`Artifact: ${demo.artifactPath}`)
  console.log(`Dashboard: ${demo.dashboardUrl}`)
  console.log('Next: run `opencode-gateway quickstart` for a guided first REAL task (dispatches an agent and shows the result).')
  if (hasArg('--open')) await openUrl(demo.dashboardUrl)
}
