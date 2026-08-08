const LEGACY_ARTIFACT_UPLOAD_INDEX_PROOF = `
      AND artifact.object_key = reservation.object_key
      AND artifact.size_bytes = reservation.reserved_bytes
      AND artifact.filename = reservation.filename
      AND (artifact.content_type IS NULL OR (
        artifact.content_type = lower(btrim(artifact.content_type))
        AND octet_length(artifact.content_type) <= 512
      ))
      AND (
        reservation.content_type IS NULL
        OR artifact.content_type IS NOT DISTINCT FROM reservation.content_type
      )
      AND artifact.kind IN ('document', 'chart', 'deck', 'spreadsheet', 'draft')
      AND artifact.status IN ('draft', 'in-review', 'final')
      AND (artifact.author_agent_id IS NULL OR (
        artifact.author_agent_id <> ''
        AND artifact.author_agent_id = btrim(artifact.author_agent_id)
        AND octet_length(artifact.author_agent_id) <= 512
      ))
      AND (artifact.project_id IS NULL OR (
        artifact.project_id <> ''
        AND artifact.project_id = btrim(artifact.project_id)
        AND octet_length(artifact.project_id) <= 512
      ))
      AND (artifact.task_id IS NULL OR (
        artifact.task_id <> ''
        AND artifact.task_id = btrim(artifact.task_id)
        AND octet_length(artifact.task_id) <= 512
      ))
      AND (artifact.status_updated_by IS NULL OR (
        artifact.status_updated_by <> ''
        AND artifact.status_updated_by = btrim(artifact.status_updated_by)
        AND octet_length(artifact.status_updated_by) <= 512
      ))`

// The pre-006 direct-upload path wrote usage with the authenticated cloud
// account plus this exact identity metadata. Migration 006 writes an org-scoped
// NULL/{} record.
// Both are valid proof when the byte/account coordinates remain bound to the
// same reservation; any other deterministic-id collision stays fenced.
const ARTIFACT_UPLOAD_USAGE_PROOF = `
      AND usage.org_id = reservation.org_id
      AND usage.event_type = 'artifact.uploaded'
      AND usage.quantity = reservation.reserved_bytes
      AND usage.unit = 'byte'
      AND (
        (
          usage.account_id IS NULL
          AND usage.metadata = '{}'::jsonb
        )
        OR (
          usage.account_id IS NOT NULL
          AND usage.metadata = jsonb_build_object(
            'tenantId', reservation.tenant_id,
            'sessionId', reservation.session_id,
            'artifactId', reservation.artifact_id
          )
          AND EXISTS (
            SELECT 1
            FROM cloud_memberships AS membership
            WHERE membership.org_id = reservation.org_id
              AND membership.account_id = usage.account_id
          )
        )
      )`

export const CLOUD_CONTROL_PLANE_ARTIFACT_UPLOAD_LIFECYCLE_STATEMENTS = [
  // Re-add the legacy column on a manual rerun; it is dropped again after all
  // legacy rows have been classified. Normal migration execution remains once-only.
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS settled_bytes bigint`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS staging_object_key text`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS final_object_key text`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS checksum_sha256 text`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS publication_metadata jsonb NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS staging_cleaned_at timestamptz`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS cleanup_reason text`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS cleanup_requested_at timestamptz`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS claim_owner text`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS claim_token text`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS cleanup_passes integer NOT NULL DEFAULT 0`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS finalization_attempts integer NOT NULL DEFAULT 0`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS next_cleanup_attempt_at timestamptz`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ADD COLUMN IF NOT EXISTS last_error_code text`,
  // Legacy settlement adjusted the quota counter to settled_bytes before publishing.
  // Carry that exact charge forward because cleanup refunds reserved_bytes.
  `UPDATE cloud_artifact_upload_reservations
    SET reserved_bytes = COALESCE(settled_bytes, reserved_bytes)
    WHERE status = 'settled'
      AND (
        settled_bytes IS NULL
        OR settled_bytes BETWEEN 0 AND 9007199254740991
      )`,
  // The legacy publication sequence was event -> index -> usage. Rebuild only an
  // index whose complete product metadata already exists in the canonical event.
  `WITH event_candidates AS MATERIALIZED (
      SELECT
        reservation.tenant_id,
        reservation.user_id,
        reservation.session_id,
        reservation.artifact_id,
        reservation.filename,
        reservation.content_type,
        reservation.object_key,
        reservation.reserved_bytes,
        event.payload,
        (
          jsonb_typeof(event.payload) = 'object'
          AND jsonb_typeof(event.payload -> 'artifactId') = 'string'
          AND event.payload ->> 'artifactId' = reservation.artifact_id
          AND jsonb_typeof(event.payload -> 'sessionId') = 'string'
          AND event.payload ->> 'sessionId' = reservation.session_id
          AND jsonb_typeof(event.payload -> 'filename') = 'string'
          AND event.payload ->> 'filename' = reservation.filename
          AND jsonb_typeof(event.payload -> 'size') = 'number'
          AND event.payload ->> 'size' ~ '^(0|[1-9][0-9]{0,15})$'
          AND (
            length(event.payload ->> 'size') < 16
            OR event.payload ->> 'size' <= '9007199254740991'
          )
          AND jsonb_typeof(event.payload -> 'key') = 'string'
          AND event.payload ->> 'key' = reservation.object_key
          AND event.payload ->> 'kind' IN ('document', 'chart', 'deck', 'spreadsheet', 'draft')
          AND event.payload ->> 'status' IN ('draft', 'in-review', 'final')
          AND jsonb_typeof(event.payload -> 'createdAt') = 'string'
          AND btrim(event.payload ->> 'createdAt')
            ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$'
          AND pg_input_is_valid(btrim(event.payload ->> 'createdAt'), 'timestamp with time zone')
          AND jsonb_typeof(event.payload -> 'updatedAt') = 'string'
          AND btrim(event.payload ->> 'updatedAt')
            ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$'
          AND pg_input_is_valid(btrim(event.payload ->> 'updatedAt'), 'timestamp with time zone')
          AND (
            (
              reservation.content_type IS NULL
              AND (
                event.payload -> 'contentType' IS NULL
                OR jsonb_typeof(event.payload -> 'contentType') = 'null'
                OR (
                  jsonb_typeof(event.payload -> 'contentType') = 'string'
                  AND octet_length(btrim(event.payload ->> 'contentType')) <= 512
                )
              )
            )
            OR (
              reservation.content_type IS NOT NULL
              AND jsonb_typeof(event.payload -> 'contentType') = 'string'
              AND lower(btrim(event.payload ->> 'contentType')) = reservation.content_type
            )
          )
          AND (
            event.payload -> 'authorAgentId' IS NULL
            OR jsonb_typeof(event.payload -> 'authorAgentId') = 'null'
            OR (
              jsonb_typeof(event.payload -> 'authorAgentId') = 'string'
              AND octet_length(btrim(event.payload ->> 'authorAgentId')) <= 512
            )
          )
          AND (
            event.payload -> 'projectId' IS NULL
            OR jsonb_typeof(event.payload -> 'projectId') = 'null'
            OR (
              jsonb_typeof(event.payload -> 'projectId') = 'string'
              AND octet_length(btrim(event.payload ->> 'projectId')) <= 512
            )
          )
          AND (
            event.payload -> 'taskId' IS NULL
            OR jsonb_typeof(event.payload -> 'taskId') = 'null'
            OR (
              jsonb_typeof(event.payload -> 'taskId') = 'string'
              AND octet_length(btrim(event.payload ->> 'taskId')) <= 512
            )
          )
          AND (
            event.payload -> 'statusUpdatedBy' IS NULL
            OR jsonb_typeof(event.payload -> 'statusUpdatedBy') = 'null'
            OR (
              jsonb_typeof(event.payload -> 'statusUpdatedBy') = 'string'
              AND octet_length(btrim(event.payload ->> 'statusUpdatedBy')) <= 512
            )
          )
          AND (
            event.payload -> 'statusUpdatedAt' IS NULL
            OR jsonb_typeof(event.payload -> 'statusUpdatedAt') = 'null'
            OR (
              jsonb_typeof(event.payload -> 'statusUpdatedAt') = 'string'
              AND (
                btrim(event.payload ->> 'statusUpdatedAt') = ''
                OR (
                  octet_length(btrim(event.payload ->> 'statusUpdatedAt')) <= 512
                  AND btrim(event.payload ->> 'statusUpdatedAt')
                    ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$'
                  AND pg_input_is_valid(
                    btrim(event.payload ->> 'statusUpdatedAt'),
                    'timestamp with time zone'
                  )
                )
              )
            )
          )
        ) AS valid
      FROM cloud_artifact_upload_reservations AS reservation
      JOIN cloud_session_events AS event
        ON event.tenant_id = reservation.tenant_id
       AND event.session_id = reservation.session_id
       AND event.event_id = reservation.session_id || ':artifact.created:' || reservation.artifact_id
       AND event.type = 'artifact.created'
      WHERE reservation.status = 'settled'
    ), validated_events AS MATERIALIZED (
      SELECT
        event_candidates.*,
        CASE WHEN valid THEN (payload ->> 'size')::bigint END AS event_size,
        CASE WHEN valid THEN btrim(payload ->> 'createdAt')::timestamptz END AS event_created_at,
        CASE WHEN valid THEN btrim(payload ->> 'updatedAt')::timestamptz END AS event_updated_at,
        CASE
          WHEN valid AND NULLIF(btrim(payload ->> 'statusUpdatedAt'), '') IS NOT NULL
            THEN btrim(payload ->> 'statusUpdatedAt')::timestamptz
          ELSE NULL
        END AS event_status_updated_at
      FROM event_candidates
    )
    INSERT INTO cloud_artifact_index (
      tenant_id, user_id, session_id, artifact_id, filename, content_type,
      size_bytes, object_key, kind, status, author_agent_id, project_id, task_id,
      status_updated_by, status_updated_at, created_at, updated_at
    )
    SELECT
      tenant_id,
      user_id,
      session_id,
      artifact_id,
      payload ->> 'filename',
      NULLIF(lower(btrim(payload ->> 'contentType')), ''),
      event_size,
      payload ->> 'key',
      payload ->> 'kind',
      payload ->> 'status',
      NULLIF(btrim(payload ->> 'authorAgentId'), ''),
      NULLIF(btrim(payload ->> 'projectId'), ''),
      NULLIF(btrim(payload ->> 'taskId'), ''),
      NULLIF(btrim(payload ->> 'statusUpdatedBy'), ''),
      event_status_updated_at,
      event_created_at,
      event_updated_at
    FROM validated_events
    WHERE valid
      AND event_size = reserved_bytes
    ON CONFLICT (tenant_id, session_id, artifact_id) DO NOTHING`,
  // Copy only metadata already present in the durable product index. This avoids
  // assigning guessed kind/status values to legacy reservations.
  `UPDATE cloud_artifact_upload_reservations AS reservation
    SET content_type = artifact.content_type,
        publication_metadata = jsonb_build_object(
      'kind', artifact.kind,
      'artifactStatus', artifact.status,
      'authorAgentId', artifact.author_agent_id,
      'projectId', artifact.project_id,
      'taskId', artifact.task_id,
      'statusUpdatedBy', artifact.status_updated_by,
      'statusUpdatedAt', CASE
        WHEN artifact.status_updated_at IS NULL THEN NULL
        ELSE to_char(
          artifact.status_updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      END
    )
    FROM cloud_artifact_index AS artifact
    WHERE reservation.status = 'settled'
      AND artifact.tenant_id = reservation.tenant_id
      AND artifact.user_id = reservation.user_id
      AND artifact.session_id = reservation.session_id
      AND artifact.artifact_id = reservation.artifact_id
      ${LEGACY_ARTIFACT_UPLOAD_INDEX_PROOF}`,
  // Replaying the canonical usage id closes event/index/usage crash gaps without
  // double attribution when the legacy write already completed.
  `INSERT INTO cloud_usage_events (
      event_id, org_id, account_id, event_type, quantity, unit, metadata, created_at
    )
    SELECT
      'artifact.uploaded:' || reservation.tenant_id || ':' || reservation.session_id || ':' || reservation.artifact_id,
      reservation.org_id,
      NULL,
      'artifact.uploaded',
      reservation.reserved_bytes,
      'byte',
      '{}'::jsonb,
      reservation.updated_at
    FROM cloud_artifact_upload_reservations AS reservation
    JOIN cloud_artifact_index AS artifact
      ON artifact.tenant_id = reservation.tenant_id
     AND artifact.user_id = reservation.user_id
     AND artifact.session_id = reservation.session_id
     AND artifact.artifact_id = reservation.artifact_id
     ${LEGACY_ARTIFACT_UPLOAD_INDEX_PROOF}
    WHERE reservation.status = 'settled'
    ON CONFLICT (event_id) DO NOTHING`,
  `UPDATE cloud_artifact_upload_reservations AS reservation
    SET status = 'finalized',
        staging_cleaned_at = COALESCE(reservation.staging_cleaned_at, reservation.updated_at)
    FROM cloud_artifact_index AS artifact, cloud_usage_events AS usage
    WHERE reservation.status = 'settled'
      AND artifact.tenant_id = reservation.tenant_id
      AND artifact.user_id = reservation.user_id
      AND artifact.session_id = reservation.session_id
      AND artifact.artifact_id = reservation.artifact_id
      AND usage.event_id = 'artifact.uploaded:' || reservation.tenant_id || ':'
        || reservation.session_id || ':' || reservation.artifact_id
      ${ARTIFACT_UPLOAD_USAGE_PROOF}
      ${LEGACY_ARTIFACT_UPLOAD_INDEX_PROOF}`,
  // A canonical usage-id collision is neither a proven publication nor safe
  // cleanup work: the exact artifact index is already user-visible, so deleting
  // its object would leave a durable pointer to missing bytes. Fence the row with
  // a non-expiring claim for explicit operator repair instead of ever handing it
  // to destructive reconciliation.
  `UPDATE cloud_artifact_upload_reservations AS reservation
    SET status = 'finalizing',
        claim_owner = 'migration-006-publication-fence',
        claim_token = 'canonical-usage-collision',
        claim_expires_at = '9999-12-31T23:59:59.999Z'::timestamptz,
        next_cleanup_attempt_at = NULL,
        last_error_code = 'publication_usage_collision'
    FROM cloud_artifact_index AS artifact, cloud_usage_events AS usage
    WHERE reservation.status = 'settled'
      AND artifact.tenant_id = reservation.tenant_id
      AND artifact.user_id = reservation.user_id
      AND artifact.session_id = reservation.session_id
      AND artifact.artifact_id = reservation.artifact_id
      AND usage.event_id = 'artifact.uploaded:' || reservation.tenant_id || ':'
        || reservation.session_id || ':' || reservation.artifact_id
      AND NOT (
        TRUE
        ${ARTIFACT_UPLOAD_USAGE_PROOF}
      )
      ${LEGACY_ARTIFACT_UPLOAD_INDEX_PROOF}`,
  // A visible legacy index that points at the promoted object is a destructive
  // cleanup fence even when its metadata cannot prove a valid publication. The
  // index/object disagreement needs explicit repair; deleting the shared bytes
  // would turn an inconsistent artifact into a guaranteed broken one.
  `UPDATE cloud_artifact_upload_reservations AS reservation
    SET status = 'finalizing',
        claim_owner = 'migration-006-publication-fence',
        claim_token = 'artifact-index-conflict',
        claim_expires_at = '9999-12-31T23:59:59.999Z'::timestamptz,
        next_cleanup_attempt_at = NULL,
        last_error_code = 'publication_index_conflict'
    FROM cloud_artifact_index AS artifact
    WHERE reservation.status = 'settled'
      AND artifact.tenant_id = reservation.tenant_id
      AND artifact.user_id = reservation.user_id
      AND artifact.session_id = reservation.session_id
      AND artifact.artifact_id = reservation.artifact_id
      AND artifact.object_key = reservation.object_key
      AND NOT (
        TRUE
        ${LEGACY_ARTIFACT_UPLOAD_INDEX_PROOF}
      )`,
  // A settled object with no durable publication proof is not safe to expose. Keep
  // its quota coordinates and exact bytes so bounded two-pass cleanup can refund it.
  `UPDATE cloud_artifact_upload_reservations
    SET cleanup_reason = CASE
          WHEN status = 'expired' THEN COALESCE(cleanup_reason, 'expired')
          ELSE COALESCE(cleanup_reason, 'failed')
        END,
        cleanup_requested_at = COALESCE(cleanup_requested_at, updated_at),
        next_cleanup_attempt_at = CASE
          WHEN status = 'settled'
            THEN GREATEST(COALESCE(next_cleanup_attempt_at, expires_at), expires_at)
          ELSE next_cleanup_attempt_at
        END,
        quota_key = CASE WHEN status IN ('expired', 'failed') THEN NULL ELSE quota_key END,
        quota_window_ms = CASE WHEN status IN ('expired', 'failed') THEN NULL ELSE quota_window_ms END,
        quota_window_started_at_ms = CASE
          WHEN status IN ('expired', 'failed') THEN NULL
          ELSE quota_window_started_at_ms
        END,
        status = 'cleanup_pending'
    WHERE status IN ('settled', 'expired', 'failed')`,
  `UPDATE cloud_artifact_upload_reservations
    SET staging_object_key = COALESCE(staging_object_key, object_key),
        final_object_key = COALESCE(final_object_key, object_key)
    WHERE staging_object_key IS NULL OR final_object_key IS NULL`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ALTER COLUMN staging_object_key SET NOT NULL`,
  `ALTER TABLE cloud_artifact_upload_reservations
    ALTER COLUMN final_object_key SET NOT NULL`,
  `ALTER TABLE cloud_artifact_upload_reservations
    DROP COLUMN IF EXISTS settled_bytes`,
  `DROP INDEX IF EXISTS cloud_artifact_upload_reservations_expiry_idx`,
  `CREATE INDEX cloud_artifact_upload_reservations_expiry_idx
    ON cloud_artifact_upload_reservations (expires_at, status)
    WHERE status IN ('reserved', 'finalizing')
       OR (status = 'finalized' AND staging_cleaned_at IS NULL)`,
  `CREATE INDEX IF NOT EXISTS cloud_artifact_upload_reservations_reconcile_idx
    ON cloud_artifact_upload_reservations (
      status, next_cleanup_attempt_at, claim_expires_at, expires_at, cleanup_requested_at
    )`,
  `CREATE INDEX IF NOT EXISTS cloud_artifact_upload_reservations_terminal_retention_idx
    ON cloud_artifact_upload_reservations (updated_at)
    WHERE status = 'cleaned'
       OR (status = 'finalized' AND staging_cleaned_at IS NOT NULL)`,
] as const
