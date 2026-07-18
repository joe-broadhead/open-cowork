import { hasArg } from '../shared.js'

export async function releaseCommand() {
  const sub = process.argv[3] || 'claims'
  if (sub !== 'claims') {
    console.log('Usage: opencode-gateway release claims [--json]')
    return
  }
  const registry = await import('../../claim-registry.js')
  const report = registry.buildClaimRegistryReport()
  if (hasArg('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(registry.formatClaimRegistryReport(report))
  if (report.status === 'fail') process.exit(1)
}
