import * as path from 'node:path'
import { allArgValues, argValue, cliUsageError, hasArg, isGatewayTransportError, postGatewayJson } from '../shared.js'

const USAGE = 'Usage: opencode-gateway project new <alias> --title <title> [--task issue-text] [--directory <repo-path>] [--session-id id] [--priority HIGH|MEDIUM|LOW] [--environment name] [--idempotency-key key] [--local]'

export async function projectCommand() {
  const sub = process.argv[3] || 'help'
  if (sub !== 'new') {
    cliUsageError(USAGE)
    return
  }
  const alias = process.argv[4]
  if (!alias || alias.startsWith('--') || !validProjectArgs(process.argv.slice(5))) {
    cliUsageError(USAGE)
    return
  }
  const title = argValue('--title')
  const priority = argValue('--priority')
  if (!title?.trim() || (priority && !['HIGH', 'MEDIUM', 'LOW'].includes(priority))) {
    cliUsageError(USAGE)
    return
  }
  if (hasArg('--local') && !argValue('--session-id')) {
    cliUsageError(USAGE, 'Offline project mutation with --local requires --session-id <sessionId>.')
    return
  }
  const product = await import('../../product-onboarding.js')
  // --directory binds the project to a real local working directory so agents do
  // (and reviewers verify) actual file work there, instead of falling back to the
  // daemon's ambient cwd. It builds an inline local-process environment; a named
  // --environment is the alternative for a preconfigured backend.
  const directory = argValue('--directory') || argValue('--workdir')
  const environment = directory
    ? { backend: 'local-process' as const, workdir: path.resolve(directory) }
    : argValue('--environment')
  const input = {
    alias,
    title,
    priority: priority as any,
    sessionId: argValue('--session-id'),
    idempotencyKey: argValue('--idempotency-key') || argValue('--key'),
    sourceType: 'cli.project',
    environment,
    agentTeam: argValue('--agent-team'),
    objective: argValue('--objective'),
    acceptanceCriteria: allArgValues('--acceptance'),
    definitionOfDone: allArgValues('--done'),
    evidenceRequirements: allArgValues('--evidence'),
    requiredArtifacts: allArgValues('--artifact'),
    tasks: allArgValues('--task'),
  }
  const body = product.buildProjectWizardBody(input)
  try {
    const response = await postGatewayJson('/projects', body)
    console.log(response.text || `Project created: ${response.roadmap?.id || body.alias}`)
  } catch (err: any) {
    if (!isGatewayTransportError(err)) throw err
    if (!hasArg('--local')) {
      throw new Error(`Daemon project creation failed: ${err.message}. No local mutation was attempted. For intentional offline state mutation, rerun with --local --session-id <sessionId>.`)
    }
    const local = product.createProjectFromWizard(input)
    console.log(local.text)
    console.log(`Daemon transport unavailable; created directly in local Gateway state with session ${body.sessionId}.`)
  }
}

function validProjectArgs(args: string[]): boolean {
  const booleanFlags = new Set(['--local'])
  const valueFlags = new Set([
    '--title', '--task', '--directory', '--workdir', '--session-id', '--priority',
    '--environment', '--idempotency-key', '--key', '--agent-team', '--objective',
    '--acceptance', '--done', '--evidence', '--artifact',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (booleanFlags.has(arg)) continue
    if (!valueFlags.has(arg)) return false
    const value = args[index + 1]
    if (!value || value.startsWith('--')) return false
    index += 1
  }
  return true
}
