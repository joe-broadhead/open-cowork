import { hasArg } from '../shared.js'

export async function performanceCommand() {
  const sub = process.argv[3] || 'budgets'
  if (sub !== 'budgets') {
    console.log('Usage: opencode-gateway performance budgets [--json] [--fail-blocked]')
    return
  }
  const performance = await import('../../performance-budgets.js')
  const report = performance.buildPerformanceBudgetReport()
  if (hasArg('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(performance.formatPerformanceBudgetReport(report))
  if (hasArg('--fail-blocked') && report.status !== 'pass') process.exit(1)
}
