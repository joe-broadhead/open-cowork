import * as fs from 'node:fs'
import { argValue, cliUsageError, hasArg } from '../shared.js'

const BACKUP_USAGE = 'Usage: opencode-gateway backup <create|list|verify|doctor|export|drill|rollback-drill>'
const RESTORE_USAGE = 'Usage: opencode-gateway restore --from <backup-path> [--maintenance] [--skip-safety-backup]'

export async function backupCommand() {
  const sub = process.argv[3] || 'list'
  if (!validBackupInvocation(sub, process.argv.slice(4))) {
    cliUsageError(BACKUP_USAGE)
    return
  }
  const storage = await import('../../storage.js')
  if (sub === 'create') {
    const backup = storage.createStorageBackup({ label: argValue('--label'), retention: integerArg('--retention') })
    console.log(`Backup created: ${backup.id}`)
    console.log(`Path: ${backup.path}`)
    console.log(`Checksum: ${backup.checksum}`)
    console.log(`Counts: ${backup.counts.roadmaps} initiatives/roadmaps, ${backup.counts.tasks} issues/tasks, ${backup.counts.runs} runs, ${backup.counts.channelBindings} channel bindings`)
  } else if (sub === 'list') {
    const backups = storage.listStorageBackups()
    if (!backups.length) return console.log('No backups found.')
    for (const backup of backups) console.log(`${backup.createdAt || 'unknown'} ${backup.ok ? 'ok' : 'bad'} ${backup.id} ${backup.path}`)
  } else if (sub === 'verify') {
    const target = process.argv[4]
    if (!target) {
      cliUsageError('Usage: opencode-gateway backup verify <backup-path>')
      return
    }
    const verification = storage.verifyStorageBackup(target)
    console.log(verification.ok ? 'Backup verified.' : 'Backup verification failed.')
    if (verification.errors.length) verification.errors.forEach(error => console.log(`- ${error}`))
    if (!verification.ok) process.exit(1)
  } else if (sub === 'doctor') {
    const report = storage.runStorageDoctor({ backupPath: argValue('--backup') || argValue('--from') })
    if (hasArg('--json')) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(`Storage doctor: ${report.status}`)
      console.log(report.summary)
      console.log(`State: ${report.stateDir}`)
      if (report.backupPath) console.log(`Backup: ${report.backupPath}`)
      console.log('Sources:')
      for (const source of report.sources) console.log(`- ${source.exists ? 'present' : 'missing'} ${source.id} (${source.kind}) ${source.path}`)
      if (report.issues.length) {
        console.log('Issues:')
        for (const issue of report.issues) console.log(`- ${issue.severity}: ${issue.code} — ${issue.summary}`)
      }
    }
    if (report.status !== 'ok') process.exit(1)
  } else if (sub === 'export') {
    const output = process.argv[4]
    const data = JSON.stringify(storage.exportGatewayState(), null, 2) + '\n'
    if (output) {
      fs.writeFileSync(output, data, { mode: 0o600 })
      console.log(`Export written: ${output}`)
    } else {
      console.log(data.trimEnd())
    }
  } else if (sub === 'drill') {
    const evidence = await storage.runStorageRecoveryDrill({
      backupPath: argValue('--from'),
      label: argValue('--label'),
      outputDir: argValue('--output-dir'),
      retryLimit: integerArg('--retry-limit'),
    })
    if (hasArg('--json')) {
      console.log(JSON.stringify(evidence, null, 2))
      return
    }
    console.log(`Recovery drill: ${evidence.status}`)
    console.log(`Evidence: ${evidence.evidencePath}`)
    console.log(`Report: ${evidence.reportPath}`)
    console.log(`Restored state: ${evidence.restore?.stateDir}`)
    for (const row of evidence.checks) console.log(`- ${row.status}: ${row.name} — ${row.summary}`)
    if (evidence.status !== 'pass') process.exit(1)

  } else if (sub === 'rollback-drill') {
    const target = argValue('--from') || argValue('--backup')
    if (!target) {
      cliUsageError('Usage: opencode-gateway backup rollback-drill --from <backup-path> [--label name] [--output-dir dir]')
      return
    }
    const receipt = await storage.runBackendRollbackDrill({
      backupPath: target,
      label: argValue('--label'),
      outputDir: argValue('--output-dir'),
    })
    if (hasArg('--json')) {
      console.log(JSON.stringify(receipt, null, 2))
      return
    }
    console.log(`Backend rollback drill: ${receipt.status}`)
    console.log(`Evidence: ${receipt.evidencePath}`)
    console.log(`Report: ${receipt.reportPath}`)
    if (receipt.restore) console.log(`Restored state: ${receipt.restore.stateDir}`)
    if (receipt.recoveryDrill) console.log(`Recovery drill: ${receipt.recoveryDrill.status} ${receipt.recoveryDrill.evidencePath}`)
    for (const row of receipt.checks) console.log(`- ${row.status}: ${row.name} — ${row.summary}`)
    if (receipt.status !== 'pass') process.exit(1)
  } else {
    cliUsageError(BACKUP_USAGE)
  }
}

export async function restoreCommand() {
  if (!validRestoreInvocation(process.argv.slice(3))) {
    cliUsageError(RESTORE_USAGE)
    return
  }
  const target = argValue('--from') || process.argv[3]
  if (!target || target.startsWith('--')) {
    cliUsageError(RESTORE_USAGE)
    return
  }
  const { restoreStorageBackup } = await import('../../storage.js')
  const result = await restoreStorageBackup(target, { maintenanceMode: hasArg('--maintenance'), skipSafetyBackup: hasArg('--skip-safety-backup') })
  console.log(`Restored ${result.restored.length} file(s) from ${result.verification.path}`)
  if (result.safetyBackup) console.log(`Pre-restore safety backup: ${result.safetyBackup}`)
}

function integerArg(name: string): number | undefined {
  const value = argValue(name)
  return value === undefined ? undefined : Number(value)
}

function validBackupInvocation(sub: string, args: string[]): boolean {
  if (!['create', 'list', 'verify', 'doctor', 'export', 'drill', 'rollback-drill'].includes(sub)) return false
  if (sub === 'list') return args.length === 0
  if (sub === 'verify') return args.length === 1 && !args[0]!.startsWith('--')
  if (sub === 'export') return args.length <= 1 && (!args[0] || !args[0].startsWith('--'))

  const booleanFlags = new Set(sub === 'doctor' || sub === 'drill' || sub === 'rollback-drill' ? ['--json'] : [])
  const valueFlags = new Set<string>()
  if (sub === 'create') for (const flag of ['--label', '--retention']) valueFlags.add(flag)
  if (sub === 'doctor') for (const flag of ['--backup', '--from']) valueFlags.add(flag)
  if (sub === 'drill') for (const flag of ['--from', '--label', '--output-dir', '--retry-limit']) valueFlags.add(flag)
  if (sub === 'rollback-drill') for (const flag of ['--from', '--backup', '--label', '--output-dir']) valueFlags.add(flag)
  if (!validFlagSequence(args, booleanFlags, valueFlags)) return false

  const retention = argValue('--retention')
  if (retention !== undefined && !validInteger(retention, 1, 10_000)) return false
  const retryLimit = argValue('--retry-limit')
  if (retryLimit !== undefined && !validInteger(retryLimit, 1, 10)) return false
  return sub !== 'rollback-drill' || Boolean(argValue('--from') || argValue('--backup'))
}

function validRestoreInvocation(args: string[]): boolean {
  let positional = 0
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--maintenance' || arg === '--skip-safety-backup') continue
    if (arg === '--from') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) return false
      index += 1
      continue
    }
    if (arg.startsWith('--') || ++positional > 1) return false
  }
  return positional === 1 || Boolean(argValue('--from'))
}

function validFlagSequence(args: string[], booleanFlags: Set<string>, valueFlags: Set<string>): boolean {
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

function validInteger(value: string, min: number, max: number): boolean {
  return /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max
}
