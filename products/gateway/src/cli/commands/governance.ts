import { assertConfigured, gatewayFetch, hasArg } from '../shared.js'

export async function governance() {
  assertConfigured('governance')
  const { formatGovernanceReport, buildGovernanceReport } = await import('../../governance.js')
  try {
    const res = await gatewayFetch('/governance')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as any
    if (hasArg('--json')) {
      console.log(JSON.stringify(data.governance, null, 2))
      return
    }
    console.log(formatGovernanceReport(data.governance))
  } catch {
    const report = buildGovernanceReport()
    if (hasArg('--json')) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(formatGovernanceReport(report))
  }
}
