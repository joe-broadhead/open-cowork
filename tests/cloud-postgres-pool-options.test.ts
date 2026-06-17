import test from 'node:test'
import assert from 'node:assert/strict'

import { cloudPostgresPoolPlan } from '../apps/desktop/src/main/cloud/postgres-pool-options.ts'

test('cloud postgres pool plan defaults preserve behaviour with a safe idle-in-transaction guard', () => {
  const { config, lockTimeoutMs } = cloudPostgresPoolPlan('postgres://db/main', {})
  assert.equal(config.connectionString, 'postgres://db/main')
  assert.equal(config.max, 10)
  assert.equal(config.connectionTimeoutMillis, 10_000)
  assert.equal(config.idleTimeoutMillis, 30_000)
  assert.equal(config.application_name, 'open-cowork-cloud')
  // statement_timeout stays opt-in so migrations / long reads are never truncated.
  assert.equal(config.statement_timeout, undefined)
  // idle-in-transaction guard is on by default to bound leaked-transaction lock holds.
  assert.equal(config.idle_in_transaction_session_timeout, 120_000)
  assert.equal(lockTimeoutMs, 0)
})

test('cloud postgres pool plan is fully operator-tunable via env', () => {
  const { config, lockTimeoutMs } = cloudPostgresPoolPlan('postgres://db/main', {
    OPEN_COWORK_CLOUD_PG_POOL_MAX: '40',
    OPEN_COWORK_CLOUD_PG_CONNECTION_TIMEOUT_MS: '5000',
    OPEN_COWORK_CLOUD_PG_IDLE_TIMEOUT_MS: '15000',
    OPEN_COWORK_CLOUD_PG_STATEMENT_TIMEOUT_MS: '30000',
    OPEN_COWORK_CLOUD_PG_IDLE_TX_TIMEOUT_MS: '60000',
    OPEN_COWORK_CLOUD_PG_LOCK_TIMEOUT_MS: '10000',
    OPEN_COWORK_CLOUD_PG_APP_NAME: 'open-cowork-cloud-web',
  })
  assert.equal(config.max, 40)
  assert.equal(config.connectionTimeoutMillis, 5000)
  assert.equal(config.idleTimeoutMillis, 15000)
  assert.equal(config.statement_timeout, 30000)
  assert.equal(config.idle_in_transaction_session_timeout, 60000)
  assert.equal(config.application_name, 'open-cowork-cloud-web')
  assert.equal(lockTimeoutMs, 10000)
})

test('cloud postgres pool plan allows disabling the idle-in-transaction guard explicitly', () => {
  const { config } = cloudPostgresPoolPlan('postgres://db/main', { OPEN_COWORK_CLOUD_PG_IDLE_TX_TIMEOUT_MS: '0' })
  assert.equal(config.idle_in_transaction_session_timeout, undefined)
})

test('cloud postgres pool plan ignores invalid env and falls back to safe defaults', () => {
  const { config, lockTimeoutMs } = cloudPostgresPoolPlan('postgres://db/main', {
    OPEN_COWORK_CLOUD_PG_POOL_MAX: 'not-a-number',
    OPEN_COWORK_CLOUD_PG_LOCK_TIMEOUT_MS: '-5',
    OPEN_COWORK_CLOUD_PG_CONNECTION_TIMEOUT_MS: '0',
  })
  assert.equal(config.max, 10)
  assert.equal(config.connectionTimeoutMillis, 10_000)
  assert.equal(lockTimeoutMs, 0)
})
