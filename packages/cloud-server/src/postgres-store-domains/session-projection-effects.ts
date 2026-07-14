import { nowIso } from '../postgres-store-id-helpers.ts'
import { sessionFromRow } from '../postgres-domains/sessions.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  AppendProjectedSessionEventInput,
  CompleteWorkflowRunInput,
  FailWorkflowRunInput,
} from '../control-plane-store.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type ProjectionEffects = {
  completeWorkflowRun(executor: PgExecutor, input: CompleteWorkflowRunInput): Promise<unknown>
  failWorkflowRun(executor: PgExecutor, input: FailWorkflowRunInput): Promise<unknown>
}

export async function applyPostgresProjectedEventEffects(
  executor: PgExecutor,
  session: ReturnType<typeof sessionFromRow>,
  input: AppendProjectedSessionEventInput,
  updatedAt: Date,
  effects: ProjectionEffects,
  sessionStatusAlreadyApplied = false,
) {
  let updatedSession = session
  if (input.sessionStatus && !sessionStatusAlreadyApplied) {
    const result = await executor.query(
      `UPDATE cloud_sessions
       SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND session_id = $2
       RETURNING *`,
      [input.tenantId, input.sessionId, input.sessionStatus, nowIso(updatedAt)],
    )
    if (!result.rows[0]) throw new Error(`Unknown session ${input.sessionId}.`)
    updatedSession = sessionFromRow(result.rows[0])
  } else if (input.sessionStatus) {
    updatedSession = { ...session, status: input.sessionStatus, updatedAt: nowIso(updatedAt) }
  }
  if (input.workflowTerminal?.kind === 'completed') {
    await effects.completeWorkflowRun(executor, input.workflowTerminal.input)
  } else if (input.workflowTerminal?.kind === 'failed') {
    await effects.failWorkflowRun(executor, input.workflowTerminal.input)
  }
  return updatedSession
}
