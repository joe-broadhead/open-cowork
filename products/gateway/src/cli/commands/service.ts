import { hasArg } from '../shared.js'

export async function serviceCommand() {
  const sub = process.argv[3] || 'lifecycle'
  if (sub !== 'lifecycle' && sub !== 'plan') {
    console.log('Usage: opencode-gateway service lifecycle [--json]')
    return
  }
  const lifecycle = await import('../../service-lifecycle.js')
  const plan = lifecycle.buildServiceLifecyclePlan()
  if (hasArg('--json')) console.log(JSON.stringify(plan, null, 2))
  else console.log(lifecycle.formatServiceLifecyclePlan(plan))
}
