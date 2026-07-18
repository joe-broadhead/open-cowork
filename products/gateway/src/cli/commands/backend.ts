import { allArgValues, argValue, hasArg } from '../shared.js'

export async function backendCommand() {
  const sub = process.argv[3] || 'status'
  const storage = await import('../../storage.js')
  if (sub === 'status') {
    const report = storage.runStorageDoctor({ backupPath: argValue('--backup') || argValue('--from') })
    const payload = {
      status: report.status,
      summary: report.summary,
      backend: report.backend,
      consistency: report.consistency,
      storageIssues: report.issues.filter(issue => issue.sourceId === 'storage_backend' || issue.severity === 'critical'),
    }
    if (hasArg('--json')) {
      console.log(JSON.stringify(payload, null, 2))
      return
    }
    console.log(`Backend activation: ${report.backend.activation.status}`)
    console.log(`Runtime backend: ${report.backend.mode}`)
    console.log(`Effective persistence: ${report.backend.effectivePersistence}`)
    console.log(`Cutover readiness: ${report.backend.activation.cutoverReadiness}`)
    console.log(`Rollback readiness: ${report.backend.activation.rollbackReadiness}`)
    console.log(`Consistency proof: ${report.consistency.status}`)
    if (report.backend.activation.blockers.length) {
      console.log('Blockers:')
      for (const blocker of report.backend.activation.blockers) console.log(`- ${blocker.severity}: ${blocker.code} — ${blocker.summary}`)
    }
    return
  }
  if (sub === 'doctor' || sub === 'consistency-scan') {
    const report = storage.runStorageDoctor({ backupPath: argValue('--backup') || argValue('--from') })
    if (hasArg('--json')) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(`Backend consistency scan: ${report.status}`)
    console.log(report.summary)
    console.log(`Activation: ${report.backend.activation.status}`)
    for (const issue of report.issues) console.log(`- ${issue.severity}: ${issue.code} — ${issue.summary}`)
    if (report.status !== 'ok') process.exit(1)
    return
  }
  if (sub === 'consistency-proof') {
    const proof = storage.buildBackendConsistencyProof({ backupPath: argValue('--backup') || argValue('--from') })
    if (hasArg('--json')) {
      console.log(JSON.stringify(proof, null, 2))
      return
    }
    console.log(`Backend consistency proof: ${proof.status}`)
    console.log(`Runtime: ${proof.runtimePosture} (${proof.runtimeBackend})`)
    console.log(`Scan: ${proof.consistencyScan.status} | critical=${proof.consistencyScan.criticalCount} | warnings=${proof.consistencyScan.warningCount}`)
    console.log(`Backup: ${proof.backup.status} (${proof.backup.freshness})`)
    console.log(`Rollback: ${proof.rollback.status}`)
    for (const blocker of proof.blockedStates) console.log(`- ${blocker.severity}: ${blocker.code} — ${blocker.summary}`)
    if (proof.status === 'fail') process.exit(1)
    return
  }
  if (sub === 'durable-state-proof' || sub === 'state-proof') {
    const proof = storage.buildDurableStateConsistencyProof({ backupPath: argValue('--backup') || argValue('--from') })
    if (hasArg('--json')) {
      console.log(JSON.stringify(proof, null, 2))
      return
    }
    console.log(`Durable state proof: ${proof.status}`)
    console.log(`Sources: ${proof.ownership.totalSources} (${proof.ownership.authoritativeSources} transactional/authoritative, ${proof.ownership.backedUpSources} backed up)`)
    console.log(`Scan: ${proof.scanner.status} | critical=${proof.scanner.criticalCount} | warnings=${proof.scanner.warningCount}`)
    console.log(`Backup: ${proof.backupRestore.backup.status} (${proof.backupRestore.backup.freshness})`)
    console.log(`Lifecycle: ${proof.backupRestore.lifecycle.status}`)
    for (const blocker of proof.blockedStates) console.log(`- ${blocker.severity}: ${blocker.code} — ${blocker.summary}`)
    if (proof.status === 'fail') process.exit(1)
    return
  }
  if (sub === 'durable-state-integrity' || sub === 'state-integrity' || sub === 'repair-boundaries') {
    const report = storage.buildDurableStateIntegrityReport({ backupPath: argValue('--backup') || argValue('--from') })
    if (hasArg('--json')) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(`Durable state integrity: ${report.status}`)
    console.log(`Sources: ${report.inventory.totalSources} (${report.inventory.requiredSourceCount} required, ${report.inventory.backedUpSourceCount} backed up)`)
    console.log(`Classes: ${report.inventory.totalClasses}`)
    console.log(`Scan: ${report.consistencyScan.status} | critical=${report.consistencyScan.criticalCount} | warnings=${report.consistencyScan.warningCount}`)
    console.log(`Backup: ${report.backupRestore.backup.status} (${report.backupRestore.backup.freshness})`)
    console.log(`Unsafe restore refused: ${report.backupRestore.refusesUnsafeRestore ? 'yes' : 'no'}`)
    for (const boundary of report.repairBoundaries) console.log(`- ${boundary.kind}: ${boundary.id} | mutates=${boundary.mutatesLiveState ? 'yes' : 'no'} | ${boundary.command}`)
    if (report.status === 'fail') process.exit(1)
    return
  }
  if (sub === 'durable-state-adapter' || sub === 'state-adapter') {
    const report = storage.buildLocalDurableStateAdapterReport({ backupPath: argValue('--backup') || argValue('--from') })
    if (hasArg('--json')) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(`Durable state adapter: ${report.status}`)
    console.log(`Backend: ${report.adapter.backendMode} (${report.adapter.effectivePersistence})`)
    console.log(`Inspect: ${report.inspect.doctorStatus} | critical=${report.inspect.criticalCount} | warnings=${report.inspect.warningCount}`)
    console.log(`Backup: ${report.backupRestore.latestBackup.status} (${report.backupRestore.latestBackup.freshness})`)
    console.log(`Repair: implicit=${report.repair.implicitRepairAllowed ? 'yes' : 'no'} evidence=${report.repair.evidenceDir}`)
    for (const capability of report.adapter.capabilities) console.log(`- ${capability.status}: ${capability.id} | mutates=${capability.mutatesLiveState ? 'yes' : 'no'} | ${capability.command}`)
    if (report.status === 'fail') process.exit(1)
    return
  }
  if (sub === 'durable-state-repair' || sub === 'state-repair') {
    const operation = argValue('--operation')
    const idempotencyKey = argValue('--idempotency-key') || argValue('--key')
    if (!operation || !idempotencyKey) {
      console.log('Usage: opencode-gateway backend durable-state-repair --operation <record_unsupported_repair_blocker|create_verified_backup|restore_verified_backup> --idempotency-key <key> [--from <backup-path>] [--maintenance] [--label name] [--reason text] [--issue-code code] [--json]')
      process.exit(1)
    }
    const receipt = await storage.runLocalDurableStateRepair({
      operation: operation as any,
      idempotencyKey,
      backupPath: argValue('--from') || argValue('--backup'),
      maintenanceMode: hasArg('--maintenance'),
      label: argValue('--label'),
      reason: argValue('--reason'),
      issueCodes: allArgValues('--issue-code'),
    })
    if (hasArg('--json')) {
      console.log(JSON.stringify(receipt, null, 2))
    } else {
      console.log(`Durable state repair: ${receipt.status}`)
      console.log(`Operation: ${receipt.operation}`)
      console.log(`Idempotency key: ${receipt.idempotencyKey}`)
      console.log(`Receipt: ${receipt.evidencePath}`)
      for (const row of receipt.checks) console.log(`- ${row.status}: ${row.id} — ${row.summary}`)
      for (const blocker of receipt.blockers) console.log(`- ${blocker.severity}: ${blocker.code} — ${blocker.summary}`)
    }
    if (receipt.status === 'fail') process.exit(1)
    return
  }
  if (sub === 'durable-state-round-trip' || sub === 'state-round-trip') {
    const evidence = await storage.validateLocalDurableStateBackupRoundTrip({
      backupPath: argValue('--backup') || argValue('--from'),
      label: argValue('--label'),
      outputDir: argValue('--output-dir'),
    })
    if (hasArg('--json')) {
      console.log(JSON.stringify(evidence, null, 2))
      return
    }
    console.log(`Durable state backup round-trip: ${evidence.status}`)
    console.log(`Backup: ${evidence.backup.id} ${evidence.backup.path}`)
    if (evidence.recoveryDrill) console.log(`Recovery drill: ${evidence.recoveryDrill.status} ${evidence.recoveryDrill.evidencePath}`)
    for (const row of evidence.checks) console.log(`- ${row.status}: ${row.id} — ${row.summary}`)
    if (evidence.status === 'fail') process.exit(1)
    return
  }
  if (sub === 'observability-plane' || sub === 'observability-support') {
    const observability = await import('../../observability-snapshot.js')
    const storePath = argValue('--store')
    const usage = 'Usage: opencode-gateway backend observability-plane [--fixture|--no-fixture] [--store <state-db-path>] [--json]'
    if (hasArg('--store') && (!storePath || storePath.startsWith('--'))) {
      console.error(usage)
      process.exit(1)
    }
    const report = observability.buildObservabilityEvidencePlaneReport({
      fixture: !hasArg('--no-fixture') || hasArg('--fixture'),
      filePath: storePath,
      readOnly: true,
    })
    if (hasArg('--json')) {
      console.log(JSON.stringify(report, null, 2))
      if (report.status === 'fail') process.exit(1)
      return
    }
    console.log(`observability evidence plane: ${report.status}`)
    console.log(report.summary)
    console.log(`Trace: ${report.trace.traceRootId}`)
    console.log(`Support: ${report.surfaceAgreement.httpObservability.supportStatus}`)
    console.log(`SLO: ${report.surfaceAgreement.cliStatus.status} (${report.surfaceAgreement.cliStatus.pass} pass, ${report.surfaceAgreement.cliStatus.warn} warn, ${report.surfaceAgreement.cliStatus.fail} fail)`)
    console.log(`Trace coverage: tasks=${report.trace.tasks}, runs=${report.trace.runs}, events=${report.trace.events}, channels=${report.trace.channels}, evidence=${report.trace.evidenceRefs}, audit=${report.trace.auditLedger}`)
    console.log(`Failed runs classified: ${report.failedRunClassifications.length}`)
    console.log(`Sources: ${report.sourceFreshness.map(row => `${row.source}:${row.status}`).join(', ')}`)
    console.log(`Release claim: ${report.releaseClaimEffect}`)
    if (report.errors.length) {
      console.log('Errors:')
      for (const error of report.errors) console.log(`- ${error}`)
    }
    if (report.status === 'fail') process.exit(1)
    return
  }
  if (sub === 'rollback-dry-run' || sub === 'rollback-drill') {
    const target = argValue('--from') || argValue('--backup')
    if (!target) {
      console.log('Usage: opencode-gateway backend rollback-dry-run --from <backup-path> [--label name] [--output-dir dir] [--json]')
      process.exit(1)
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
    console.log(`Backend rollback dry-run: ${receipt.status}`)
    console.log(`Evidence: ${receipt.evidencePath}`)
    console.log(`Report: ${receipt.reportPath}`)
    for (const row of receipt.checks) console.log(`- ${row.status}: ${row.name} — ${row.summary}`)
    if (receipt.status !== 'pass') process.exit(1)
    return
  }
  console.log('Usage: opencode-gateway backend <status|doctor|consistency-scan|consistency-proof|durable-state-proof|durable-state-integrity|durable-state-adapter|durable-state-repair|durable-state-round-trip|observability-plane|rollback-dry-run> [--json]')
  process.exit(1)
}
