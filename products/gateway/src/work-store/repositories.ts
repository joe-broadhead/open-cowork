export type WorkStoreBackendMode = 'local_sqlite'
export type WorkStoreReleaseStatus = 'supported_public_local_beta'

export type WorkStoreRepositoryDomainId =
  | 'schema_manifest'
  | 'work_graph'
  | 'runs_leases'
  | 'supervisors'
  | 'receipts'
  | 'bindings'
  | 'gates'
  | 'promotions'
  | 'alerts_events'
  | 'audit_ledger'

export type WorkStoreTransactionOwner =
  | 'schema_initialization'
  | 'mutateWorkState'
  | 'domain_transaction'
  | 'single_table_append'

export type WorkStoreMutationEntryPoint =
  | 'schema_manifest'
  | 'work_state_transaction'
  | 'domain_port'
  | 'domain_transaction'
  | 'single_table_append'

export interface WorkStoreMutationCompatibilityContract {
  entryPoint: WorkStoreMutationEntryPoint
  oldRecordFixture: string
  backupCompatibility: 'gateway_db_required'
  rollbackGate: 'verified_gateway_db_backup'
  requiredProof: string[]
  unsupportedClaims: string[]
}

export interface WorkStoreRepositoryDomain {
  id: WorkStoreRepositoryDomainId
  label: string
  owner: string
  backendMode: WorkStoreBackendMode
  releaseStatus: WorkStoreReleaseStatus
  transactionOwner: WorkStoreTransactionOwner
  tables: string[]
  operationGroups: string[]
  invariants: string[]
  futureBackendNotes: string[]
  mutationContract: WorkStoreMutationCompatibilityContract
}

export interface WorkStoreMutationContractValidation {
  ok: boolean
  errors: string[]
  domainCount: number
  tableCount: number
  mutationEntryPoints: Record<WorkStoreMutationEntryPoint, number>
}

const DEFAULT_UNSUPPORTED_STORAGE_CLAIMS = [
  'hosted/team durable-state readiness',
  'multi-tenant storage isolation',
  'managed backup/restore service',
  'production backend cutover',
] as const

function mutationContract(entryPoint: WorkStoreMutationEntryPoint, oldRecordFixture: string, requiredProof: string[]): WorkStoreMutationCompatibilityContract {
  return {
    entryPoint,
    oldRecordFixture,
    backupCompatibility: 'gateway_db_required',
    rollbackGate: 'verified_gateway_db_backup',
    requiredProof: [...requiredProof],
    unsupportedClaims: [...DEFAULT_UNSUPPORTED_STORAGE_CLAIMS],
  }
}

export const WORK_STORE_REPOSITORY_DOMAINS: readonly WorkStoreRepositoryDomain[] = [
  {
    id: 'schema_manifest',
    label: 'Schema manifest and metadata',
    owner: 'work-store/schema',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'schema_initialization',
    tables: ['meta'],
    operationGroups: ['inspect_schema', 'record_meta'],
    invariants: [
      'schema signature changes only with intentional table/index/column drift',
    ],
    futureBackendNotes: [
      'The complete schema is created whole on first open; a schema change means recreating the local database.',
    ],
    mutationContract: mutationContract('schema_manifest', 'work-store-invariants:schema-signature', [
      'schema signature lock against CREATE TABLE statements',
    ]),
  },
  {
    id: 'work_graph',
    label: 'Roadmaps, issues, dependencies, and completion proposals',
    owner: 'work-store/work-items',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'mutateWorkState',
    tables: ['roadmaps', 'tasks', 'work_dependencies', 'roadmap_completion_proposals'],
    operationGroups: ['load_work_state', 'create_or_update_roadmap', 'create_or_update_task', 'mutate_dependencies', 'propose_or_decide_completion'],
    invariants: [
      'task mutations recompute roadmap status in the same transaction',
      'dependency closure and task readiness are evaluated against one consistent state snapshot',
    ],
    futureBackendNotes: [
      'A shared backend must preserve uniqueness for task source keys and transactional dependency updates.',
    ],
    mutationContract: mutationContract('work_state_transaction', 'work-store-invariants:hot-task-mutation', [
      'task mutation characterization',
      'roadmap recomputation in the same transaction',
      'backup/restore work graph counts',
    ]),
  },
  {
    id: 'runs_leases',
    label: 'Runs, leases, dispatch receipts, and runtime state',
    owner: 'work-store/run-lease-port',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'domain_transaction',
    tables: ['runs', 'task_dispatch_receipts', 'task_run_counters'],
    operationGroups: ['reserve_dispatch_start', 'start_run', 'renew_run_lease', 'complete_or_fail_run', 'recover_expired_dispatch_starts', 'recover_expired_or_orphaned_runs'],
    invariants: [
      'only one active run is created for a task through public start APIs',
      'lease owner, lease expiry, and scheduler generation update atomically with task state',
      'run retention preserves lifetime per-task run counts before deleting old terminal rows',
    ],
    futureBackendNotes: [
      'A Postgres-compatible adapter must use compare-and-set lease updates and duplicate-dispatch fencing.',
    ],
    mutationContract: mutationContract('domain_port', 'work-store-run-lease-port:duplicate-active-run', [
      'run/lease port contract',
      'duplicate dispatch fencing',
      'expired dispatch-start recovery',
      'preview transaction plan coverage',
    ]),
  },
  {
    id: 'supervisors',
    label: 'Roadmap supervisors and wake cursors',
    owner: 'work-store/supervisors',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'mutateWorkState',
    tables: ['roadmap_supervisors'],
    operationGroups: ['create_or_update_supervisor', 'acquire_wakeup', 'complete_wakeup', 'apply_supervisor_result'],
    invariants: [
      'default supervisor reconciliation and wake cursor movement happen with the related event receipt',
    ],
    futureBackendNotes: [
      'Team-scale supervisor workers need lease fencing before this domain can leave single-host local mode.',
    ],
    mutationContract: mutationContract('work_state_transaction', 'work-store-invariants:supervisor-wakeup-receipts', [
      'supervisor wake acquisition and completion proof',
      'cursor/event receipt alignment',
      'backup/restore supervisor count proof',
    ]),
  },
  {
    id: 'receipts',
    label: 'Delegation, progress, and supervisor wakeup receipts',
    owner: 'work-store/receipts',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'domain_transaction',
    tables: ['delegation_receipts', 'delegation_progress_receipts', 'delegation_progress_route_receipts', 'supervisor_wakeup_receipts'],
    operationGroups: ['create_delegation_receipt', 'replay_idempotency_key', 'append_progress_receipt', 'append_progress_route_receipt', 'complete_wakeup_receipt'],
    invariants: [
      'idempotency keys replay without creating duplicate durable work',
      'receipt tables remain the replay source even when retention prunes workflow events',
      'progress route receipts store redacted delivery state for channel and parent-session recovery',
    ],
    futureBackendNotes: [
      'Future retention and backend migrations must preserve receipt rows before event compaction.',
    ],
    mutationContract: mutationContract('domain_transaction', 'work-store-invariants:native-delegation-receipt', [
      'delegation receipt replay proof',
      'progress receipt durability beyond event retention',
      'route receipt recovery proof',
    ]),
  },
  {
    id: 'bindings',
    label: 'Project bindings, channel bindings, and channel claims',
    owner: 'work-store/bindings',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'mutateWorkState',
    tables: ['project_bindings', 'channel_bindings', 'channel_claim_codes', 'agent_presences', 'session_admissions'],
    operationGroups: ['upsert_project_binding', 'mirror_channel_binding', 'resolve_project_context', 'create_or_accept_channel_claim', 'agent_presence_mutate', 'session_admission_record'],
    invariants: [
      'project binding upserts mirror channel binding rows in the same mutation',
      'provider/chat/thread uniqueness prevents ambiguous channel routing',
    ],
    futureBackendNotes: [
      'Team identity work must scope channel bindings before shared backend routing is enabled.',
    ],
    mutationContract: mutationContract('domain_port', 'work-store-bindings-port:mirrored-channel-binding', [
      'bindings port contract',
      'project/channel binding mirror proof',
      'preview transaction plan coverage',
    ]),
  },
  {
    id: 'gates',
    label: 'Human approval gates and destructive-operation scopes',
    owner: 'work-store/gates',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'mutateWorkState',
    tables: ['human_gates'],
    operationGroups: ['create_gate', 'decide_gate', 'consume_gate', 'timeout_gate'],
    invariants: [
      'gate decisions mutate task state and audit events in the same transaction',
      'always-scoped approvals remain tied to exact scope keys',
    ],
    futureBackendNotes: [
      'RBAC work must attach gate actors and tenant/workspace scope before team use.',
    ],
    mutationContract: mutationContract('work_state_transaction', 'work-store:human-gate-decision', [
      'gate decision task-state mutation proof',
      'audit event emission proof',
      'scope key preservation proof',
    ]),
  },
  {
    id: 'promotions',
    label: 'Agent profile/team scorecards, decisions, and rollback state',
    owner: 'work-store/promotions',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'domain_transaction',
    tables: ['promotion_scorecards', 'promotion_decisions'],
    operationGroups: ['upsert_scorecard', 'request_promotion_decision', 'apply_promotion_decision', 'compute_rollback_eligibility'],
    invariants: [
      'promotion decisions require human gates for promote, deprecate, and rollback',
      'rollback eligibility uses durable scorecard and decision history',
    ],
    futureBackendNotes: [
      'Extension governance must add provenance and manifest trust before marketplace claims.',
    ],
    mutationContract: mutationContract('domain_transaction', 'work-store:promotion-decision-human-gate', [
      'scorecard idempotency proof',
      'human-gated promotion/deprecation/rollback proof',
      'config revision alignment proof',
    ]),
  },
  {
    id: 'alerts_events',
    label: 'Alerts and workflow events',
    owner: 'work-store/events',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'single_table_append',
    tables: ['alerts', 'events'],
    operationGroups: ['append_event', 'list_events', 'upsert_alert', 'resolve_alerts', 'prune_retention_window'],
    invariants: [
      'security audit and delegation progress events survive noisy retention pruning',
      'alert dedupe state remains local and redacted',
    ],
    futureBackendNotes: [
      'Audit ledger rows are normalized into the dedicated audit_ledger domain.',
    ],
    mutationContract: mutationContract('single_table_append', 'work-store:security-audit-retention', [
      'event append and retention proof',
      'alert dedupe proof',
      'security audit retention proof',
    ]),
  },
  {
    id: 'audit_ledger',
    label: 'Append-only local audit ledger foundation',
    owner: 'work-store/audit-ledger',
    backendMode: 'local_sqlite',
    releaseStatus: 'supported_public_local_beta',
    transactionOwner: 'single_table_append',
    tables: ['audit_ledger'],
    operationGroups: ['append_audit_ledger_row', 'query_audit_ledger', 'include_incident_bundle_refs'],
    invariants: [
      'ledger rows are derived from redacted normalized work events',
      'entry hashes chain to the previous ledger row for local tamper evidence',
      'raw provider targets, private transcripts, and secret values never enter ledger payloads',
    ],
    futureBackendNotes: [
      'Future team backends must add tenant scope, access trails, legal hold, and certified immutability before compliance claims.',
    ],
    mutationContract: mutationContract('single_table_append', 'audit-ledger:hash-chain', [
      'redacted audit ledger mapping proof',
      'hash-chain continuity proof',
      'incident bundle reference proof',
    ]),
  },
] as const

export function listWorkStoreRepositoryDomains(): WorkStoreRepositoryDomain[] {
  return WORK_STORE_REPOSITORY_DOMAINS.map(domain => ({
    ...domain,
    tables: [...domain.tables],
    operationGroups: [...domain.operationGroups],
    invariants: [...domain.invariants],
    futureBackendNotes: [...domain.futureBackendNotes],
    mutationContract: {
      ...domain.mutationContract,
      requiredProof: [...domain.mutationContract.requiredProof],
      unsupportedClaims: [...domain.mutationContract.unsupportedClaims],
    },
  }))
}

export function validateWorkStoreMutationContracts(schemaTables: readonly string[] = []): WorkStoreMutationContractValidation {
  const errors: string[] = []
  const tableOwners = new Map<string, string[]>()
  const mutationEntryPoints: Record<WorkStoreMutationEntryPoint, number> = {
    schema_manifest: 0,
    work_state_transaction: 0,
    domain_port: 0,
    domain_transaction: 0,
    single_table_append: 0,
  }

  for (const domain of WORK_STORE_REPOSITORY_DOMAINS) {
    if (!domain.tables.length) errors.push(`${domain.id} has no tables`)
    if (!domain.operationGroups.length) errors.push(`${domain.id} has no operation groups`)
    if (!domain.invariants.length) errors.push(`${domain.id} has no invariants`)
    if (!domain.futureBackendNotes.length) errors.push(`${domain.id} has no future backend notes`)
    mutationEntryPoints[domain.mutationContract.entryPoint] += 1
    if (!domain.mutationContract.oldRecordFixture) errors.push(`${domain.id} has no old-record fixture`)
    if (!domain.mutationContract.requiredProof.length) errors.push(`${domain.id} has no required mutation proof`)
    if (domain.mutationContract.backupCompatibility !== 'gateway_db_required') errors.push(`${domain.id} must keep gateway.db backup compatibility`)
    if (domain.mutationContract.rollbackGate !== 'verified_gateway_db_backup') errors.push(`${domain.id} must require verified backup rollback`)
    if ((domain.id === 'runs_leases' || domain.id === 'bindings') && domain.mutationContract.entryPoint !== 'domain_port') errors.push(`${domain.id} must remain behind a domain port`)
    if (domain.transactionOwner === 'schema_initialization' && domain.mutationContract.entryPoint !== 'schema_manifest') errors.push(`${domain.id} schema initialization must use schema_manifest entry point`)
    if (domain.transactionOwner === 'single_table_append' && domain.mutationContract.entryPoint !== 'single_table_append') errors.push(`${domain.id} single-table append owner must use single_table_append entry point`)
    for (const table of domain.tables) {
      const owners = tableOwners.get(table) || []
      owners.push(domain.id)
      tableOwners.set(table, owners)
    }
  }

  for (const [table, owners] of tableOwners) {
    if (owners.length > 1) errors.push(`table ${table} has multiple mutation owners: ${owners.join(', ')}`)
  }

  if (schemaTables.length) {
    const owned = new Set(tableOwners.keys())
    for (const table of schemaTables) {
      if (!owned.has(table)) errors.push(`schema table ${table} has no mutation owner`)
    }
    for (const table of owned) {
      if (!schemaTables.includes(table)) errors.push(`mutation contract owns unknown table ${table}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    domainCount: WORK_STORE_REPOSITORY_DOMAINS.length,
    tableCount: tableOwners.size,
    mutationEntryPoints,
  }
}
