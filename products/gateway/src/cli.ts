#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { readPackageVersion } from './version.js'
import { runSetup, runUpdate } from './cli-setup.js'
import { runChannelCommand } from './channel-cli.js'
import { argValue, hasArg } from './cli/shared.js'
import { install, restart, start, status, stop } from './cli/commands/lifecycle.js'
import { operatorCommand } from './cli/commands/operator.js'
import { doctor, health, readiness } from './cli/commands/health.js'
import { secretsCommand } from './cli/commands/secrets.js'
import { governance } from './cli/commands/governance.js'
import { analyticsCommand } from './cli/commands/analytics.js'
import { backupCommand, restoreCommand } from './cli/commands/backup.js'
import { backendCommand } from './cli/commands/backend.js'
import { environmentCommand } from './cli/commands/environment.js'
import { projectCommand } from './cli/commands/project.js'
import { taskCommand } from './cli/commands/task.js'
import { serviceCommand } from './cli/commands/service.js'
import { evidenceCommand } from './cli/commands/evidence.js'
import { releaseCommand } from './cli/commands/release.js'
import { performanceCommand } from './cli/commands/performance.js'
import { personaCommand, presenceCommand } from './cli/commands/persona-presence.js'
import { demoCommand, onboardCommand, quickstartCommand } from './cli/commands/quickstart.js'
import { logs } from './cli/commands/logs.js'

export { buildGatewayAuthHeaders, resolveCliDaemonToken } from './cli/shared.js'

const VERSION = readPackageVersion()

/**
 * Top-level command catalog. `section` groups the help output into daily-driver
 * COMMON commands and deeper ADVANCED/diagnostics commands; `hidden` commands
 * (serve, mcp) work but are kept out of the help listing. This is the single
 * source of truth for both the help text and unknown-command detection.
 */
interface CliCommandSpec {
  name: string
  summary: string
  section: 'common' | 'advanced' | 'hidden'
  /** Optional per-subcommand help lines (usage + flags) for `<command> --help`. */
  help?: string[]
}

const CLI_COMMANDS: readonly CliCommandSpec[] = [
  { name: 'setup', summary: 'First-time setup wizard (--yes accepts defaults)', section: 'common', help: ['Usage: opencode-gateway setup [--yes]', '  --yes    Accept defaults without prompting'] },
  { name: 'quickstart', summary: 'Guided first run: preflight -> real initiative -> agent dispatch -> visible result', section: 'common', help: [
    'Usage: opencode-gateway quickstart [--title <text>] [--task <text>] [--timeout <seconds>] [--no-start] [--open] [--json]',
    '  --title <text>     Title for the starter initiative',
    '  --task <text>      Description/prompt for the starter task',
    '  --timeout <secs>   Max seconds to wait for the run to complete (default 180)',
    '  --no-start         Do not auto-start the daemon if it is stopped',
    '  --open             Open the run on the dashboard when it completes',
    '  --json             Emit the machine-readable quickstart result',
  ] },
  { name: 'onboard', summary: 'First-run onboarding checks and optional template/demo setup', section: 'common', help: ['Usage: opencode-gateway onboard [--template <kind>] [--dir <dir>] [--demo] [--start] [--open] [--force]'] },
  { name: 'demo', summary: 'Create a local no-model-spend demo project and artifact', section: 'common', help: ['Usage: opencode-gateway demo [--open]'] },
  { name: 'start', summary: 'Start daemon in background', section: 'common', help: ['Usage: opencode-gateway start'] },
  { name: 'stop', summary: 'Stop the daemon', section: 'common', help: ['Usage: opencode-gateway stop'] },
  { name: 'restart', summary: 'Stop + start', section: 'common', help: ['Usage: opencode-gateway restart'] },
  { name: 'status', summary: 'Show daemon status, component health, Gateway sessions, and queue counts', section: 'common', help: ['Usage: opencode-gateway status'] },
  { name: 'task', summary: 'Add/list/complete durable Issues (tasks) (add|list|done <text>)', section: 'common', help: ['Usage: opencode-gateway task <add|list|done> [issue text] [--local]'] },
  { name: 'project', summary: 'Create/manage supervised Gateway projects', section: 'common', help: ['Usage: opencode-gateway project new <alias> --title <title> [--task issue-text] [--directory <repo-path>] [--session-id id] [--priority HIGH|MEDIUM|LOW] [--environment name] [--idempotency-key key] [--local]', '  --directory  bind a local working directory so agents do real file work there'] },
  { name: 'persona', summary: 'Create/list OpenCode primary agent personas', section: 'common', help: [
    'Usage: opencode-gateway persona create <name> [--description text] [--prompt text] [--model id]',
    '       opencode-gateway persona list',
  ] },
  { name: 'presence', summary: 'Manage always-on AgentPresence bindings (not channel typing presence)', section: 'common', help: [
    'Usage: opencode-gateway presence list',
    '       opencode-gateway presence create --name <label> --agent <opencode-agent> [--session id] [--provider x --chat-id y]',
    '       opencode-gateway presence get|pause|resume|archive <presenceId>',
    '       opencode-gateway presence bind-channel <presenceId> --provider telegram --chat-id <id>',
  ] },
  { name: 'channel', summary: 'Guided channel connector setup, status, verification, trust, and proof', section: 'common' },
  { name: 'logs', summary: 'Show recent daemon activity or service log lines', section: 'common', help: ['Usage: opencode-gateway logs [--lines <n>]', '  --lines <n>   Number of log lines (default 20, max 1000)'] },
  { name: 'health', summary: 'Component health check with remediation hints (exit 0 if healthy, 1 if not)', section: 'common', help: ['Usage: opencode-gateway health [--json]', '  --json   Emit the machine-readable health report'] },
  { name: 'doctor', summary: 'Full diagnostic report', section: 'common', help: ['Usage: opencode-gateway doctor'] },
  { name: 'readiness', summary: 'Show local operating readiness state and checks', section: 'common', help: ['Usage: opencode-gateway readiness [--json] [--strict]', '  --json     Emit the machine-readable readiness report', '  --strict   Exit 1 unless state is ready'] },
  { name: 'install', summary: 'Write the LaunchAgent/systemd user service file', section: 'common', help: ['Usage: opencode-gateway install'] },
  { name: 'update', summary: 'Refresh config/assets/state after pulling new code (--wizard to review)', section: 'common', help: ['Usage: opencode-gateway update [--wizard] [--yes]'] },
  { name: 'env', summary: 'Generate .gateway/env.yaml templates', section: 'common', help: ['Usage: opencode-gateway env template <kind> [directory] [--stdout] [--force]'] },

  { name: 'operator', summary: 'Redacted operator status, live-state hygiene, and safety controls', section: 'advanced', help: ['Usage: opencode-gateway operator <status|hygiene|pause|resume|recover|reset-stale|run> [--json] [--fail-blocked]', 'Run control: opencode-gateway operator run <runId> <cancel|stop|retry|restart> [--lease-owner owner] [--scheduler-generation generation] [--note text]'] },
  { name: 'governance', summary: 'Show budget, token, cost, and runtime governance status', section: 'advanced', help: ['Usage: opencode-gateway governance [--json]'] },
  { name: 'analytics', summary: 'Run-history spend, completion scorecards, and retry hotspots over a window', section: 'advanced', help: [
    'Usage: opencode-gateway analytics [--scorecard] [--by profile|agent|roadmap] [--window <days>] [--roadmap id] [--profile name] [--agent name] [--json]',
    '  --scorecard        Show the completion + cost scorecard and underperformers instead of the usage summary',
    '  --by <dimension>   Group by profile (default), agent, or roadmap',
    '  --window <days>    Lookback window in days (default 30)',
    '  --roadmap <id>     Scope to one roadmap',
    '  --profile <name>   Scope to one effective profile',
    '  --agent <name>     Scope to one resolved agent',
    '  --json             Emit the machine-readable analytics report',
  ] },
  { name: 'secrets', summary: 'Inspect value-free secret lifecycle posture (status|injection-check)', section: 'advanced', help: ['Usage: opencode-gateway secrets <status|inventory|injection-check> [--json]'] },
  { name: 'evidence', summary: 'Export redacted operator evidence bundles (export|incident|replay-consistency)', section: 'advanced', help: ['Usage: opencode-gateway evidence <export|incident|replay-consistency> [output] [--task id] [--run id] [--session id] [--roadmap id] [--project id] [--alert id] [--active-session id] [--json]'] },
  { name: 'release', summary: 'Release operations (claims)', section: 'advanced', help: ['Usage: opencode-gateway release claims [--json]'] },
  { name: 'performance', summary: 'Local performance and responsiveness budgets (budgets)', section: 'advanced', help: ['Usage: opencode-gateway performance budgets [--json] [--fail-blocked]'] },
  { name: 'service', summary: 'Service lifecycle plan and cleanup/uninstall bounds (lifecycle)', section: 'advanced', help: ['Usage: opencode-gateway service lifecycle [--json]'] },
  { name: 'backend', summary: 'Backend activation, consistency/state proofs, and rollback dry-runs', section: 'advanced', help: ['Usage: opencode-gateway backend <status|doctor|consistency-scan|consistency-proof|durable-state-proof|durable-state-integrity|durable-state-adapter|durable-state-repair|durable-state-round-trip|observability-plane|rollback-dry-run> [--json]'] },
  { name: 'backup', summary: 'Backup operations (create|list|verify|doctor|export|drill|rollback-drill)', section: 'advanced', help: ['Usage: opencode-gateway backup <create|list|verify|doctor|export|drill|rollback-drill> [--json]'] },
  { name: 'restore', summary: 'Restore Gateway state from a verified backup', section: 'advanced', help: ['Usage: opencode-gateway restore --from <backup-path> [--maintenance] [--skip-safety-backup]'] },

  { name: 'serve', summary: 'Run daemon in foreground (debugging)', section: 'hidden' },
  { name: 'mcp', summary: 'Serve the gateway_* MCP tools over stdio', section: 'hidden' },
]

const KNOWN_COMMANDS = new Set<string>([...CLI_COMMANDS.map(command => command.name), 'help'])

export type CliInvocation =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'subcommand-help'; command: string }
  | { kind: 'run'; command: string }
  | { kind: 'unknown'; command: string }

/**
 * Pure resolver for the top-level CLI invocation. Extracted so it can be unit
 * tested without importing side effects (main() is guarded from test runs).
 */
export function resolveCliInvocation(argv: readonly string[]): CliInvocation {
  const command = argv[2]
  if (command === '--version' || command === '-v') return { kind: 'version' }
  if (!command || command === 'help' || command === '--help' || command === '-h') return { kind: 'help' }
  if (!KNOWN_COMMANDS.has(command)) return { kind: 'unknown', command }
  if (argv.slice(3).some(arg => arg === '--help' || arg === '-h')) return { kind: 'subcommand-help', command }
  return { kind: 'run', command }
}

export function buildCliHelpText(): string {
  const lines: string[] = [
    `OpenCode Gateway v${VERSION} — OpenCode Work Coordinator`,
    '',
    'Usage: opencode-gateway <command> [options]',
    '       opencode-gateway --version',
    '       opencode-gateway <command> --help',
    '',
    'COMMON commands:',
  ]
  const pad = Math.max(...CLI_COMMANDS.map(command => command.name.length))
  const render = (section: 'common' | 'advanced') => {
    for (const command of CLI_COMMANDS.filter(candidate => candidate.section === section)) {
      lines.push(`  ${command.name.padEnd(pad)}  ${command.summary}`)
    }
  }
  render('common')
  lines.push('', 'ADVANCED / diagnostics:')
  render('advanced')
  lines.push('', 'Run `opencode-gateway <command> --help` for command-specific options.')
  return lines.join('\n')
}

export function buildSubcommandHelpText(command: string): string {
  const spec = CLI_COMMANDS.find(candidate => candidate.name === command)
  if (!spec) return buildCliHelpText()
  const lines = spec.help ? [...spec.help] : [`Usage: opencode-gateway ${command}`, spec.summary]
  return lines.join('\n')
}

export function buildUnknownCommandText(command: string): string {
  return `Unknown command: ${command}\nRun \`opencode-gateway help\` for the list of commands, or \`opencode-gateway <command> --help\` for options.`
}

async function main() {
  const invocation = resolveCliInvocation(process.argv)
  if (invocation.kind === 'version') { console.log(VERSION); return }
  if (invocation.kind === 'help') { console.log(buildCliHelpText()); return }
  if (invocation.kind === 'subcommand-help') { console.log(buildSubcommandHelpText(invocation.command)); return }
  if (invocation.kind === 'unknown') { console.error(buildUnknownCommandText(invocation.command)); process.exit(2) }
  const COMMAND = invocation.command
  switch (COMMAND) {
    case 'start': return start()
    case 'stop': return stop()
    case 'restart': return restart()
    case 'status': return status()
    case 'operator': return operatorCommand()
    case 'readiness': return readiness()
    case 'secrets': return secretsCommand()
    case 'governance': return governance()
    case 'analytics': return analyticsCommand()
    case 'health': return health()
    case 'doctor': return doctor()
    case 'install': return install()
    case 'setup': return runSetup({ interactive: !hasArg('--yes') })
    case 'update': return runUpdate({ interactive: hasArg('--wizard') && !hasArg('--yes') })
    case 'quickstart': return quickstartCommand()
    case 'onboard': return onboardCommand()
    case 'demo': return demoCommand()
    case 'project': return projectCommand()
    case 'persona': return personaCommand()
    case 'presence': return presenceCommand()
    case 'channel': return runChannelCommand()
    case 'env': return environmentCommand()
    case 'task': return taskCommand()
    case 'evidence': return evidenceCommand()
    case 'release': return releaseCommand()
    case 'performance': return performanceCommand()
    case 'service': return serviceCommand()
    case 'backend': return backendCommand()
    case 'backup': return backupCommand()
    case 'restore': return restoreCommand()
    case 'logs': return logs()
    case 'serve': return (await import('./daemon.js')).serve()
    case 'mcp': {
      // Serve the gateway_* MCP tools over stdio (for OpenCode, Open Cowork,
      // and other MCP clients). Tool surface is bounded by GATEWAY_MCP_TOOLS
      // (read|operate|admin) — see src/mcp-tool-tiers.ts.
      const flagTools = argValue('--tools')
      if (flagTools) process.env['GATEWAY_MCP_TOOLS'] = flagTools
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
      const mcp = await import('./mcp.js')
      const transport = new StdioServerTransport()
      await mcp.server.connect(transport)
      console.error('[gateway-proxy] MCP stdio server connected')
      return new Promise(() => undefined)
    }
    default:
      // resolveCliInvocation already handles help/unknown before dispatch;
      // this only fires if a catalog command lacks a switch case.
      console.error(buildUnknownCommandText(COMMAND))
      process.exit(2)
  }
}


// Run main() for real CLI invocations (direct `node dist/cli.js`, the bin
// wrapper, and CLI subprocesses spawned by tests) but NOT when a test imports
// this module in-process to exercise the pure helpers. Keep this at the true
// end of the module so every top-level binding used by command handlers has
// been initialized before direct execution can call into them.
const isDirectEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
const importedByVitest = !!process.env['VITEST'] && !isDirectEntry
if (!importedByVitest) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1) })
}
