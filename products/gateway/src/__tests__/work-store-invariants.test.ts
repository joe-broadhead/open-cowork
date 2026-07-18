import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { createStorageBackup, verifyStorageBackup } from '../storage.js'
import {
  acquireDueRoadmapSupervisorWakeups,
  applyWorkTaskAction,
  completeRoadmapSupervisorWakeup,
  createDelegatedWork,
  createRoadmap,
  createWorkTask,
  getChannelBinding,
  getDelegationReceipt,
  listProjectBindings,
  listSupervisorWakeupReceipts,
  listWorkEvents,
  listWorkStoreRepositoryDomains,
  loadWorkState,
  startWorkTaskRun,
  validateWorkStoreMutationContracts,
  withWorkDb,
} from '../work-store.js'
import { inspectWorkStoreSqliteSchema } from '../work-store/schema.js'

describe('work store invariants', () => {
  let testDir = ''
  let store = ''

  beforeEach(() => {
    // Fresh mkdtemp directory per test: never delete the directory of a store
    // that was just initialized, and never share a fixed path across parallel
    // vitest workers.
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-work-store-invariants-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('locks the effective SQLite schema signature against the CREATE TABLE statements', () => {
    const schema = withWorkDb(store, db => inspectWorkStoreSqliteSchema(db))

    expect(schema.tables).toEqual([
      'agent_presences',
      'alerts',
      'audit_ledger',
      'channel_bindings',
      'channel_claim_codes',
      'delegation_progress_receipts',
      'delegation_progress_route_receipts',
      'delegation_receipts',
      'events',
      'human_gates',
      'meta',
      'project_bindings',
      'promotion_decisions',
      'promotion_scorecards',
      'roadmap_completion_proposals',
      'roadmap_supervisors',
      'roadmaps',
      'runs',
      'session_admissions',
      'supervisor_wakeup_receipts',
      'task_dispatch_receipts',
      'task_run_counters',
      'tasks',
      'work_dependencies',
    ])
    expect(schema.columns['audit_ledger']).toEqual(expect.arrayContaining([
      'id:INTEGER:0::1',
      'schema_version:INTEGER:1::0',
      'event_id:TEXT:1::0',
      'source_event_id:INTEGER:0::0',
      'class:TEXT:1::0',
      'actor_kind:TEXT:1::0',
      'resource_kind:TEXT:1::0',
      'trace_id:TEXT:1::0',
      'retention_class:TEXT:1::0',
      'entry_hash:TEXT:1::0',
    ]))
    expect(schema.columns['tasks']).toEqual(expect.arrayContaining([
      'id:TEXT:0::1',
      'roadmap_id:TEXT:1::0',
      'status:TEXT:1::0',
      'current_run_id:TEXT:0::0',
      'quality_spec_json:TEXT:0::0',
    ]))
    expect(schema.columns['runs']).toEqual(expect.arrayContaining([
      'id:TEXT:0::1',
      'task_id:TEXT:1::0',
      'status:TEXT:1::0',
      'lease_owner:TEXT:0::0',
      'lease_expires_at:TEXT:0::0',
      'scheduler_generation:TEXT:0::0',
      'runtime_profile_json:TEXT:0::0',
    ]))
    expect(schema.columns['delegation_receipts']).toEqual(expect.arrayContaining([
      'idempotency_key:TEXT:0::1',
      'task_ids_json:TEXT:1::0',
      'next_scheduler_action:TEXT:1::0',
    ]))
    expect(schema.columns['delegation_progress_receipts']).toEqual(expect.arrayContaining([
      'progress_key:TEXT:0::1',
      'idempotency_key:TEXT:1::0',
      'progress:TEXT:1::0',
      'event_id:INTEGER:0::0',
    ]))
    expect(schema.columns['delegation_progress_route_receipts']).toEqual(expect.arrayContaining([
      'dedupe_key:TEXT:0::1',
      'progress_key:TEXT:0::0',
      'idempotency_key:TEXT:0::0',
      'state:TEXT:1::0',
      'attempt_count:INTEGER:1:1:0',
      'last_event_id:INTEGER:0::0',
    ]))
    expect(schema.columns['task_dispatch_receipts']).toEqual(expect.arrayContaining([
      'id:TEXT:0::1',
      'task_id:TEXT:1::0',
      'stage:TEXT:1::0',
      'profile:TEXT:0::0',
      'status:TEXT:1::0',
      'lease_owner:TEXT:1::0',
      'lease_expires_at:TEXT:1::0',
      'run_id:TEXT:0::0',
      'session_id:TEXT:0::0',
      "acquisition_journal_json:TEXT:1:'[]':0",
      'prompt_submitted_at:TEXT:0::0',
    ]))
    expect(schema.columns['task_run_counters']).toEqual(expect.arrayContaining([
      'task_id:TEXT:0::1',
      'pruned_runs:INTEGER:1:0:0',
      'updated_at:TEXT:1::0',
    ]))
    expect(schema.columns['session_admissions']).toEqual(expect.arrayContaining([
      'admission_id:TEXT:0::1',
      'session_id:TEXT:1::0',
      "status:TEXT:1:'active':0",
      'idempotency_key:TEXT:0::0',
      'last_error:TEXT:0::0',
    ]))
    expect(schema.columns['channel_bindings']).toEqual(expect.arrayContaining([
      'provider:TEXT:1::1',
      'chat_id:TEXT:1::2',
      "thread_id:TEXT:1:'':3",
      'session_id:TEXT:1::0',
      'roadmap_id:TEXT:0::0',
      'task_id:TEXT:0::0',
    ]))
    expect(schema.columns['channel_claim_codes']).toEqual(expect.arrayContaining([
      'id:TEXT:0::1',
      'provider:TEXT:1::0',
      'action:TEXT:1::0',
      'code_hash:TEXT:1::0',
      'status:TEXT:1::0',
      'expires_at:TEXT:1::0',
      'accepted_target_hash:TEXT:0::0',
    ]))
    expect(schema.signature).toBe('f2b4b509fac0e0520236c26e5252f41ea205113c1e89c375f9867378ccd387de')
  })

  it('exports repository domains that own every schema table without drift', () => {
    const schema = withWorkDb(store, db => inspectWorkStoreSqliteSchema(db))
    const domains = listWorkStoreRepositoryDomains()
    const coveredTables = new Set(domains.flatMap(domain => domain.tables))
    const mutationContracts = validateWorkStoreMutationContracts(schema.tables)

    expect(mutationContracts).toMatchObject({
      ok: true,
      errors: [],
      domainCount: domains.length,
      tableCount: schema.tables.length,
      mutationEntryPoints: expect.objectContaining({
        schema_manifest: 1,
        domain_port: 2,
        single_table_append: 2,
      }),
    })
    expect([...coveredTables].sort()).toEqual(schema.tables)
    expect(domains).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'work_graph', transactionOwner: 'mutateWorkState', tables: expect.arrayContaining(['roadmaps', 'tasks', 'work_dependencies']), operationGroups: expect.arrayContaining(['mutate_dependencies']) }),
      expect.objectContaining({ id: 'runs_leases', transactionOwner: 'domain_transaction', tables: expect.arrayContaining(['runs', 'task_dispatch_receipts', 'task_run_counters']), operationGroups: expect.arrayContaining(['start_run', 'recover_expired_or_orphaned_runs']), mutationContract: expect.objectContaining({ entryPoint: 'domain_port', oldRecordFixture: 'work-store-run-lease-port:duplicate-active-run' }) }),
      expect.objectContaining({ id: 'receipts', tables: expect.arrayContaining(['delegation_receipts', 'delegation_progress_receipts', 'delegation_progress_route_receipts', 'supervisor_wakeup_receipts']), operationGroups: expect.arrayContaining(['replay_idempotency_key', 'append_progress_route_receipt']) }),
      expect.objectContaining({ id: 'bindings', tables: expect.arrayContaining(['project_bindings', 'channel_bindings']), mutationContract: expect.objectContaining({ entryPoint: 'domain_port', oldRecordFixture: 'work-store-bindings-port:mirrored-channel-binding' }) }),
      expect.objectContaining({ id: 'audit_ledger', tables: ['audit_ledger'], operationGroups: expect.arrayContaining(['append_audit_ledger_row', 'query_audit_ledger']) }),
    ]))
    expect(domains.map(domain => domain.id)).not.toContain('worker_fleet')
  })

  it('prevents duplicate active runs for a task through the public start API', () => {
    const roadmap = createRoadmap({ title: 'Active run roadmap' }, store)
    const task = createWorkTask({ title: 'One running stage only', roadmapId: roadmap.id, pipeline: ['implement'] }, store)
    const taskId = task.id

    const first = startWorkTaskRun(taskId, 'implement', 'ses_run_one', 'implementer', store, { owner: 'owner-one', generation: 'gen-one' })
    const duplicate = startWorkTaskRun(taskId, 'implement', 'ses_run_two', 'implementer', store, { owner: 'owner-two', generation: 'gen-two' })
    const state = loadWorkState(store)
    const activeRuns = state.runs.filter(run => run.taskId === taskId && run.status === 'running')

    expect(first).toBeDefined()
    expect(duplicate).toBeUndefined()
    expect(activeRuns).toHaveLength(1)
    expect(state.tasks.find(task => task.id === taskId)).toMatchObject({ status: 'running', currentRunId: activeRuns[0]!.id })
  })

  it('preserves receipts, mirrored channel bindings, and backup compatibility together', () => {
    const receipt = createDelegatedWork({
      idempotencyKey: 'split-harness-delegation',
      targetType: 'project',
      objective: 'Exercise work-store split invariants',
      parentSessionId: 'ses_parent',
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-split', threadId: 'topic-1' },
      project: {
        title: 'Split harness roadmap',
        tasks: [{ title: 'Implement split harness', pipeline: ['implement'] }],
        supervisor: {
          roadmapId: 'filled-by-createDelegatedWork',
          sessionId: 'ses_supervisor',
          nextReviewAt: '2000-01-01T00:00:00.000Z',
        },
        binding: {
          alias: 'split-harness',
          roadmapId: 'filled-by-createDelegatedWork',
          sessionId: 'ses_supervisor',
          scope: 'telegram',
          provider: 'telegram',
          chatId: 'chat-split',
          threadId: 'topic-1',
          title: 'Split Harness',
        },
      },
    }, store)
    const taskId = receipt.taskIds[0]

    applyWorkTaskAction(taskId!, 'done', {}, store)
    const [wakeup] = acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'split-harness', leaseMs: 60000 }, store)
    completeRoadmapSupervisorWakeup(receipt.supervisorId!, { leaseOwner: 'split-harness', cursorEventId: wakeup!.cursorEventId, note: 'reviewed split invariants' }, store)

    expect(getDelegationReceipt('split-harness-delegation', store)).toMatchObject({ idempotencyKey: receipt.idempotencyKey, taskIds: [taskId], roadmapId: receipt.roadmapId })
    expect(listSupervisorWakeupReceipts({ supervisorId: receipt.supervisorId }, store)).toEqual([
      expect.objectContaining({ status: 'completed', wakeReason: expect.any(String), idempotencyKey: expect.any(String) }),
    ])
    expect(listProjectBindings({ alias: 'split-harness' }, store)).toEqual([
      expect.objectContaining({ provider: 'telegram', chatId: 'chat-split', threadId: 'topic-1', roadmapId: receipt.roadmapId }),
    ])
    expect(getChannelBinding('telegram', 'chat-split', 'topic-1', store)).toMatchObject({ mode: 'roadmap', roadmapId: receipt.roadmapId, sessionId: 'ses_supervisor' })
    expect(listWorkEvents(100, store).map(event => event.type)).toEqual(expect.arrayContaining([
      'delegation.accepted',
      'delegation.mapped',
      'project.binding.upserted',
      'channel.binding.upserted',
      'roadmap.supervisor.wakeup_completed',
    ]))

    const backup = createStorageBackup({ label: 'split-harness', now: new Date('2026-06-16T12:00:00.000Z') })
    const verification = verifyStorageBackup(backup.path)

    expect(verification).toMatchObject({ ok: true, errors: [] })
    expect(backup.counts).toMatchObject({ tasks: 1, runs: 0, supervisors: 1, projectBindings: 1, channelBindings: 1 })

    const restoredStore = path.join(testDir, 'restored.db')
    fs.copyFileSync(path.join(backup.path, 'gateway.db'), restoredStore)
    expect(getDelegationReceipt('split-harness-delegation', restoredStore)).toMatchObject({ taskIds: [taskId], roadmapId: receipt.roadmapId })
    expect(getChannelBinding('telegram', 'chat-split', 'topic-1', restoredStore)).toMatchObject({ roadmapId: receipt.roadmapId })
    expect(listSupervisorWakeupReceipts({ supervisorId: receipt.supervisorId }, restoredStore)).toHaveLength(1)
  })
})
