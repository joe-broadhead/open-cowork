import { SYSTEMD_SERVICE_NAME } from '../../service-manager.js'
import { readGatewayLogLines, serviceLogPath } from '../../service-logs.js'
import { argValue, assertConfigured, fetchGatewayJson } from '../shared.js'

export async function logs() {
  assertConfigured('logs')
  const lines = Math.max(1, Math.min(Number(argValue('--lines') || process.argv[3] || 20), 1000))
  const daemonLogs = await fetchGatewayJson(`/logs?lines=${lines}`).catch(() => null) as { logs?: string[] } | null
  const rows = daemonLogs?.logs?.length ? daemonLogs.logs : readGatewayLogLines(lines)
  if (rows.length === 0) {
    console.log(process.platform === 'linux'
      ? `No log lines found. Expected sources: journalctl --user -u ${SYSTEMD_SERVICE_NAME} (service-managed) or ${serviceLogPath()} (direct start).`
      : `No log lines found. Expected service log: ${serviceLogPath()}`)
    return
  }
  rows.forEach(line => console.log(line))
}
