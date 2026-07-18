import {
  argValue,
  assertConfigured,
  cliUsageError,
  fetchGatewayJson,
  formatActiveRunControlCliText,
  hasArg,
  isGatewayTransportError,
  postGatewayJson,
} from '../shared.js'

const OPERATOR_USAGE = 'Usage: opencode-gateway operator <status|hygiene|pause|resume|recover|reset-stale|run> [--json] [--fail-blocked] [--local]'
const RUN_USAGE = 'Usage: opencode-gateway operator run <runId> <cancel|stop|retry|restart> [--lease-owner owner] [--scheduler-generation generation] [--note text] [--json] [--local]'

export async function operatorCommand() {
  const sub = process.argv[3] || 'status'
  if (!['status', 'hygiene', 'pause', 'resume', 'recover', 'reset-stale', 'run'].includes(sub)) {
    cliUsageError(OPERATOR_USAGE, RUN_USAGE)
    return
  }
  if (!validOperatorArgs(sub)) {
    cliUsageError(sub === 'run' ? RUN_USAGE : OPERATOR_USAGE)
    return
  }
  assertConfigured('operator')
  const operator = await import('../../operator-safety.js')
  const hygiene = await import('../../live-state-hygiene.js')
  try {
    if (sub === 'run') {
      const runId = process.argv[4]
      const action = process.argv[5]
      if (!runId || !action || !['cancel', 'stop', 'retry', 'restart'].includes(action)) {
        cliUsageError(RUN_USAGE)
        return
      }
      const data = await postGatewayJson(`/operator/runs/${encodeURIComponent(runId)}/actions`, {
        action,
        note: argValue('--note'),
        expectedLeaseOwner: argValue('--lease-owner'),
        expectedSchedulerGeneration: argValue('--scheduler-generation'),
      })
      if (hasArg('--json')) console.log(JSON.stringify(data.activeRunControl, null, 2))
      else console.log(formatActiveRunControlCliText(data.activeRunControl.control))
      return
    }
    if (sub === 'status') {
      const data = await fetchGatewayJson('/operator/status')
      if (hasArg('--json')) console.log(JSON.stringify(data.operator, null, 2))
      else console.log(operator.formatOperatorSafetyText(data.operator))
      return
    }
    if (sub === 'hygiene') {
      const data = await fetchGatewayJson('/operator/hygiene')
      if (hasArg('--json')) console.log(JSON.stringify(data.hygiene, null, 2))
      else console.log(hygiene.formatLiveStateHygieneText(data.hygiene))
      return
    }
    const data = await postGatewayJson('/operator/actions', { action: sub })
    if (hasArg('--json')) console.log(JSON.stringify(data.operatorAction, null, 2))
    else {
      const result = data.operatorAction
      console.log(`${result.action}: ${result.applied ? 'applied' : 'no changes needed'}`)
      console.log()
      if (result.result?.hygiene) {
        console.log(hygiene.formatLiveStateHygieneText(result.result.hygiene))
        console.log()
      }
      console.log(operator.formatOperatorSafetyText(result.report))
    }
  } catch (err: any) {
    // A daemon response is authoritative even when it is an error. In
    // particular, auth, validation, conflict, and leadership responses must
    // never become permission to mutate the same state out of process.
    if (!isGatewayTransportError(err)) throw err
    if (sub === 'hygiene') {
      const report = await hygiene.buildLiveStateHygieneReport(undefined, { readOnly: true })
      if (hasArg('--json')) console.log(JSON.stringify(report, null, 2))
      else {
        console.log(`Daemon unavailable (${err?.message || err}); showing local live-state hygiene only.`)
        console.log()
        console.log(hygiene.formatLiveStateHygieneText(report))
      }
      return
    }
    if (sub === 'run') {
      const runId = process.argv[4]
      const action = process.argv[5]
      if (!runId || !action || !['cancel', 'stop', 'retry', 'restart'].includes(action)) {
        cliUsageError(RUN_USAGE)
        return
      }
      if (!hasArg('--local')) throw offlineMutationRequiresLocal(err)
      const result = await operator.applyOperatorActiveRunControl({
        runId,
        action: action as any,
        note: argValue('--note'),
        expectedLeaseOwner: argValue('--lease-owner'),
        expectedSchedulerGeneration: argValue('--scheduler-generation'),
        actor: 'operator-cli',
        source: 'operator-cli',
      })
      if (hasArg('--json')) console.log(JSON.stringify(result, null, 2))
      else {
        console.log(`Daemon unavailable (${err?.message || err}); evaluated local active-run control without OpenCode session abort.`)
        console.log()
        console.log(formatActiveRunControlCliText(result.control))
      }
      return
    }
    if (sub !== 'status') {
      if (!hasArg('--local')) throw offlineMutationRequiresLocal(err)
      const result = await operator.applyOperatorSafetyAction(sub as any)
      if (hasArg('--json')) console.log(JSON.stringify(result, null, 2))
      else {
        console.log(`Daemon unavailable (${err?.message || err}); applied local operator action without OpenCode session recovery.`)
        console.log()
        if ((result.result as any)?.hygiene) {
          console.log(hygiene.formatLiveStateHygieneText((result.result as any).hygiene))
          console.log()
        }
        console.log(operator.formatOperatorSafetyText(result.report))
      }
      return
    }
    const report = await operator.buildOperatorSafetyReport(undefined, { readOnly: true })
    if (hasArg('--json')) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`Daemon unavailable (${err?.message || err}); showing local state only.`)
      console.log()
      console.log(operator.formatOperatorSafetyText(report))
    }
  }
}

function offlineMutationRequiresLocal(error: Error): Error {
  return new Error(`${error.message}. No local mutation was attempted. For intentional offline mutation after a transport failure, rerun with --local.`)
}

function validOperatorArgs(sub: string): boolean {
  if (sub === 'run') {
    const runId = process.argv[4]
    const action = process.argv[5]
    if (!runId || runId.startsWith('--') || !action || !['cancel', 'stop', 'retry', 'restart'].includes(action)) return false
    return validFlags(process.argv.slice(6), new Set(['--json', '--fail-blocked', '--local']), new Set(['--lease-owner', '--scheduler-generation', '--note']))
  }
  return validFlags(process.argv.slice(4), new Set(['--json', '--fail-blocked', '--local']), new Set())
}

function validFlags(args: string[], booleanFlags: Set<string>, valueFlags: Set<string>): boolean {
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
