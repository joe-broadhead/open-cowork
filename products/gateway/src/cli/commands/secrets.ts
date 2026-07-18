import { getConfig } from '../../config.js'
import { argValue, assertConfigured, hasArg } from '../shared.js'

export async function secretsCommand() {
  assertConfigured('secrets')
  const sub = process.argv[3] || 'status'
  const secrets = await import('../../secrets-lifecycle.js')
  const config = getConfig()
  if (sub === 'status' || sub === 'inventory') {
    const report = secrets.buildSecretsLifecycleReport(config)
    if (hasArg('--json')) console.log(JSON.stringify(report, null, 2))
    else console.log(secrets.formatSecretsLifecycleReport(report))
    return
  }
  if (sub === 'injection-check') {
    const referenceId = argValue('--reference') || argValue('--ref')
    const envName = argValue('--env')
    const contextKind = argValue('--context') || 'subprocess'
    if (!referenceId || !envName) throw new Error('Usage: opencode-gateway secrets injection-check --reference <secretref> --env <ENV_NAME> [--context channel|connector|worker|http|mcp|opencode|subprocess] [--provider telegram|whatsapp|discord] [--project id] [--worker id] [--lease id] [--json]')
    const vault = secrets.createLocalSecretVaultAdapter(config)
    const result = vault.injectScopedSecrets({
      context: {
        kind: contextKind as any,
        provider: argValue('--provider') as any,
        projectId: argValue('--project') || argValue('--project-id'),
        workerId: argValue('--worker') || argValue('--worker-id'),
        leaseId: argValue('--lease') || argValue('--lease-id'),
      },
      referenceIds: [referenceId as any],
      allowEnv: [envName],
      baseEnv: {},
    })
    const redacted = {
      allowed: result.allowed,
      injected: result.injected.map(item => ({ referenceId: item.referenceId, inputId: item.inputId, envName: item.envName, source: item.source, scope: item.scope })),
      denied: result.denied,
    }
    if (hasArg('--json')) console.log(JSON.stringify(redacted, null, 2))
    else {
      console.log(`Secret injection check: ${result.allowed ? 'allowed' : 'denied'}`)
      if (result.injected.length) for (const item of result.injected) console.log(`- ${item.referenceId} -> ${item.envName} (${item.inputId}, ${item.scope.path})`)
      if (result.denied.length) for (const denial of result.denied) console.log(`- denied ${denial.code}${denial.referenceId ? ` ${denial.referenceId}` : ''}: ${denial.reason}`)
      console.log('Values are not printed; this command is a redacted dry run.')
    }
    return
  }
  console.log('Usage: opencode-gateway secrets <status|inventory|injection-check> [--json]')
}
