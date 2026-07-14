import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  provisionPostgresRuntimeRole,
  validatePostgresRuntimeRoleInput,
  type PostgresRuntimeRoleExecutor,
} from '../packages/cloud-server/src/postgres-runtime-role.ts'

const POSTGRES_URL = process.env.OPEN_COWORK_TEST_POSTGRES_URL
  || process.env.OPEN_COWORK_CLOUD_TEST_POSTGRES_URL
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'Set OPEN_COWORK_TEST_POSTGRES_URL to run real PostgreSQL role-integrity regressions.'

const safeRuntimeRole = {
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolcanlogin: false,
  rolinherit: true,
  rolreplication: false,
  rolbypassrls: false,
}

const safeRuntimePrincipal = {
  ...safeRuntimeRole,
  rolcanlogin: true,
}

const safeMembershipOptions = {
  admin_option: false,
  inherit_option: true,
  set_option: true,
  membership_options_supported: true,
}

function infrastructureResult(text: string) {
  if (text.includes('FROM pg_catalog.pg_shdepend dependency')) return { rows: [] }
  if (text.includes('AS can_mutate_migration_ledger')) {
    return { rows: [{
      can_mutate_migration_ledger: false,
      can_execute_user_routine: false,
    }] }
  }
  if (text.includes('FROM pg_catalog.pg_namespace namespace')) return { rows: [{ schema_name: 'public' }] }
  if (text.includes("current_setting('server_version_num')")) return { rows: [{ server_version_num: '170000' }] }
  return null
}

test('runtime database role input rejects unsafe identifiers', () => {
  assert.throws(
    () => validatePostgresRuntimeRoleInput({ role: 'runtime"; DROP ROLE owner; --', principal: 'runtime@example.iam' }),
    /lowercase PostgreSQL role identifier/,
  )
  assert.throws(
    () => validatePostgresRuntimeRoleInput({ role: 'open_cowork_runtime', principal: '' }),
    /must name the dedicated runtime IAM database user/,
  )
  assert.throws(
    () => validatePostgresRuntimeRoleInput({ role: 'open_cowork_runtime', principal: 'open_cowork_runtime' }),
    /must be distinct PostgreSQL roles/,
  )
})

test('runtime database role provisioning creates a non-login role and grants only data access', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const executor: PostgresRuntimeRoleExecutor = {
    async query(text, values) {
      calls.push({ text, values })
      const infrastructure = infrastructureResult(text)
      if (infrastructure) return infrastructure
      if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
      if (text.includes('WHERE rolname = $1') && values?.[0] === 'open_cowork_runtime') return { rows: [] }
      if (text.includes('WHERE rolname = $1') && values?.[0] === 'runtime@project.iam') return { rows: [safeRuntimePrincipal] }
      return { rows: [] }
    },
  }

  await provisionPostgresRuntimeRole(executor, {
    role: 'open_cowork_runtime',
    principal: 'runtime@project.iam',
  })

  const sql = calls.map((call) => call.text).join('\n')
  assert.match(sql, /CREATE ROLE "open_cowork_runtime" NOLOGIN NOSUPERUSER/)
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/)
  assert.match(sql, /GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES/)
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.cloud_schema_migrations FROM PUBLIC, "open_cowork_runtime", "runtime@project\.iam"/)
  assert.match(sql, /GRANT SELECT ON TABLE public\.cloud_schema_migrations TO "open_cowork_runtime"/)
  assert.ok(
    sql.indexOf('REVOKE ALL PRIVILEGES ON TABLE public.cloud_schema_migrations')
      > sql.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES'),
    'the migration-ledger read-only override must follow the broad table grant',
  )
  assert.match(sql, /ALTER DEFAULT PRIVILEGES/)
  assert.match(sql, /REVOKE ALL PRIVILEGES ON DATABASE "open_cowork_cloud" FROM "open_cowork_runtime", "runtime@project\.iam"/)
  assert.match(sql, /REVOKE ALL PRIVILEGES ON SCHEMA "public" FROM "open_cowork_runtime", "runtime@project\.iam"/)
  assert.match(sql, /REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA "public" FROM PUBLIC, "open_cowork_runtime", "runtime@project\.iam"/)
  assert.match(sql, /GRANT "open_cowork_runtime" TO "runtime@project\.iam" WITH INHERIT TRUE, SET FALSE/)
  assert.doesNotMatch(sql, /GRANT ALL/)
  assert.doesNotMatch(sql, /cloudsqlsuperuser/)
})

test('runtime database role provisioning rejects every privileged or login-capable group-role attribute', async () => {
  for (const attribute of [
    'rolsuper',
    'rolcreaterole',
    'rolcreatedb',
    'rolcanlogin',
    'rolreplication',
    'rolbypassrls',
  ] as const) {
    const executor: PostgresRuntimeRoleExecutor = {
      async query(text, values) {
        const infrastructure = infrastructureResult(text)
        if (infrastructure) return infrastructure
        if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
        if (values?.[0] === 'open_cowork_runtime') {
          return { rows: [{ ...safeRuntimeRole, [attribute]: true }] }
        }
        return { rows: [safeRuntimePrincipal] }
      },
    }

    await assert.rejects(
      provisionPostgresRuntimeRole(executor, {
        role: 'open_cowork_runtime',
        principal: 'runtime@project.iam',
      }),
      /Refusing to use privileged or login-capable PostgreSQL role/,
      attribute,
    )
  }
})

test('runtime database role provisioning rejects every elevated principal attribute', async () => {
  for (const attribute of [
    'rolsuper',
    'rolcreaterole',
    'rolcreatedb',
    'rolreplication',
    'rolbypassrls',
  ] as const) {
    const executor: PostgresRuntimeRoleExecutor = {
      async query(text, values) {
        const infrastructure = infrastructureResult(text)
        if (infrastructure) return infrastructure
        if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
        if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
        if (values?.[0] === 'runtime@project.iam') {
          return { rows: [{ ...safeRuntimePrincipal, [attribute]: true }] }
        }
        return { rows: [] }
      },
    }

    await assert.rejects(
      provisionPostgresRuntimeRole(executor, {
        role: 'open_cowork_runtime',
        principal: 'runtime@project.iam',
      }),
      /has privileged PostgreSQL role attributes/,
      attribute,
    )
  }
})

test('runtime database role provisioning requires a login principal that inherits grants', async () => {
  for (const [attributes, error] of [
    [{ ...safeRuntimePrincipal, rolcanlogin: false }, /must be a dedicated login role/],
    [{ ...safeRuntimePrincipal, rolinherit: false }, /must inherit its least-privilege group role/],
  ] as const) {
    const executor: PostgresRuntimeRoleExecutor = {
      async query(text, values) {
        const infrastructure = infrastructureResult(text)
        if (infrastructure) return infrastructure
        if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
        if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
        if (values?.[0] === 'runtime@project.iam') return { rows: [attributes] }
        return { rows: [] }
      },
    }
    await assert.rejects(
      provisionPostgresRuntimeRole(executor, {
        role: 'open_cowork_runtime',
        principal: 'runtime@project.iam',
      }),
      error,
    )
  }
})

test('runtime database role provisioning rejects direct and indirect provider/admin memberships', async () => {
  for (const memberships of [
    [{
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'cloudsqlsuperuser',
      depth: 1,
      ...safeMembershipOptions,
      ...safeRuntimeRole,
    }],
    [{
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'application_group',
      depth: 1,
      ...safeMembershipOptions,
      ...safeRuntimeRole,
    }],
    [{
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'application_group',
      depth: 1,
      ...safeMembershipOptions,
      ...safeRuntimeRole,
    }, {
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'rds_superuser',
      depth: 2,
      ...safeMembershipOptions,
      ...safeRuntimeRole,
    }],
    [{
      origin_name: 'open_cowork_runtime',
      inherited_role_name: 'azure_pg_admin',
      depth: 1,
      ...safeMembershipOptions,
      ...safeRuntimeRole,
    }],
    [{
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'cloudsqliamuser',
      depth: 1,
      ...safeMembershipOptions,
      ...safeRuntimeRole,
    }, {
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'runtime@project.iam',
      depth: 2,
      ...safeMembershipOptions,
      ...safeRuntimePrincipal,
    }],
  ]) {
    const executor: PostgresRuntimeRoleExecutor = {
      async query(text, values) {
        const infrastructure = infrastructureResult(text)
        if (infrastructure) return infrastructure
        if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
        if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
        if (values?.[0] === 'runtime@project.iam') return { rows: [safeRuntimePrincipal] }
        if (text.includes('WITH RECURSIVE membership_tree')) return { rows: memberships }
        return { rows: [] }
      },
    }
    await assert.rejects(
      provisionPostgresRuntimeRole(executor, {
        role: 'open_cowork_runtime',
        principal: 'runtime@project.iam',
      }),
      /pre-existing provider\/admin or unverified role memberships/,
    )
  }
})

test('runtime database role provisioning permits direct non-privileged provider IAM login roles', async () => {
  for (const providerRole of ['cloudsqliamuser', 'rds_iam']) {
    const calls: string[] = []
    const executor: PostgresRuntimeRoleExecutor = {
      async query(text, values) {
        calls.push(text)
        const infrastructure = infrastructureResult(text)
        if (infrastructure) return infrastructure
        if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
        if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
        if (values?.[0] === 'runtime@project.iam') return { rows: [safeRuntimePrincipal] }
        if (text.includes('WITH RECURSIVE membership_tree')) {
          return { rows: [{
            origin_name: 'runtime@project.iam',
            inherited_role_name: providerRole,
            depth: 1,
            ...safeMembershipOptions,
            ...safeRuntimeRole,
          }] }
        }
        return { rows: [] }
      },
    }

    await provisionPostgresRuntimeRole(executor, {
      role: 'open_cowork_runtime',
      principal: 'runtime@project.iam',
    })
    assert.equal(calls.some((sql) => (
      sql.includes('REVOKE ALL PRIVILEGES ON TABLE public.cloud_schema_migrations')
      && sql.includes(`"${providerRole}"`)
    )), true)
    assert.equal(calls.some((sql) => (
      sql.includes('REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA')
      && sql.includes(`"${providerRole}"`)
    )), true)
  }
})

test('runtime database role provisioning permits only an existing direct membership in the exact safe runtime role', async () => {
  const calls: string[] = []
  const executor: PostgresRuntimeRoleExecutor = {
    async query(text, values) {
      calls.push(text)
      const infrastructure = infrastructureResult(text)
      if (infrastructure) return infrastructure
      if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
      if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
      if (values?.[0] === 'runtime@project.iam') return { rows: [safeRuntimePrincipal] }
      if (text.includes('WITH RECURSIVE membership_tree')) {
        return { rows: [{
          origin_name: 'runtime@project.iam',
          inherited_role_name: 'open_cowork_runtime',
          depth: 1,
          ...safeMembershipOptions,
          ...safeRuntimeRole,
        }] }
      }
      return { rows: [] }
    },
  }

  await provisionPostgresRuntimeRole(executor, {
    role: 'open_cowork_runtime',
    principal: 'runtime@project.iam',
  })
  assert.equal(calls.some((sql) => sql.includes('pg_catalog.pg_auth_members')), true)
})

test('runtime database role provisioning rejects unsafe membership grant options', async () => {
  for (const membership of [
    {
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'open_cowork_runtime',
      depth: 1,
      ...safeMembershipOptions,
      admin_option: true,
      ...safeRuntimeRole,
    },
    {
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'cloudsqliamuser',
      depth: 1,
      ...safeMembershipOptions,
      inherit_option: false,
      ...safeRuntimeRole,
    },
    {
      origin_name: 'runtime@project.iam',
      inherited_role_name: 'rds_iam',
      depth: 1,
      ...safeMembershipOptions,
      set_option: false,
      ...safeRuntimeRole,
    },
  ]) {
    const executor: PostgresRuntimeRoleExecutor = {
      async query(text, values) {
        const infrastructure = infrastructureResult(text)
        if (infrastructure) return infrastructure
        if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
        if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
        if (values?.[0] === 'runtime@project.iam') return { rows: [safeRuntimePrincipal] }
        if (text.includes('WITH RECURSIVE membership_tree')) return { rows: [membership] }
        return { rows: [] }
      },
    }

    await assert.rejects(
      provisionPostgresRuntimeRole(executor, {
        role: 'open_cowork_runtime',
        principal: 'runtime@project.iam',
      }),
      /pre-existing provider\/admin or unverified role memberships/,
    )
  }
})

test('runtime database role provisioning rejects ownership before changing grants', async () => {
  const calls: string[] = []
  const executor: PostgresRuntimeRoleExecutor = {
    async query(text, values) {
      calls.push(text)
      if (text.includes('FROM pg_catalog.pg_shdepend dependency')) {
        return { rows: [{
          owner_name: 'runtime@project.iam',
          object_identity: 'table public.runtime_owned_fixture',
        }] }
      }
      const infrastructure = infrastructureResult(text)
      if (infrastructure) return infrastructure
      if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
      if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
      if (values?.[0] === 'runtime@project.iam') return { rows: [safeRuntimePrincipal] }
      return { rows: [] }
    },
  }

  await assert.rejects(
    provisionPostgresRuntimeRole(executor, {
      role: 'open_cowork_runtime',
      principal: 'runtime@project.iam',
    }),
    /own database objects and cannot be reduced to grants safely/,
  )
  assert.equal(calls.some((sql) => sql.startsWith('REVOKE ALL PRIVILEGES')), false)
})

test('runtime database role provisioning uses PostgreSQL 15-compatible membership syntax', async () => {
  const calls: string[] = []
  const executor: PostgresRuntimeRoleExecutor = {
    async query(text, values) {
      calls.push(text)
      if (text.includes("current_setting('server_version_num')")) {
        return { rows: [{ server_version_num: '150000' }] }
      }
      const infrastructure = infrastructureResult(text)
      if (infrastructure) return infrastructure
      if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
      if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
      if (values?.[0] === 'runtime@project.iam') return { rows: [safeRuntimePrincipal] }
      if (text.includes('WITH RECURSIVE membership_tree')) {
        return { rows: [{
          origin_name: 'runtime@project.iam',
          inherited_role_name: 'open_cowork_runtime',
          depth: 1,
          ...safeMembershipOptions,
          membership_options_supported: false,
          ...safeRuntimeRole,
        }] }
      }
      return { rows: [] }
    },
  }

  await provisionPostgresRuntimeRole(executor, {
    role: 'open_cowork_runtime',
    principal: 'runtime@project.iam',
  })
  assert.equal(calls.includes('GRANT "open_cowork_runtime" TO "runtime@project.iam"'), true)
  assert.equal(calls.some((sql) => sql.includes('WITH INHERIT TRUE')), false)
})

test('runtime database role provisioning fails closed when effective ambient authority remains', async () => {
  for (const [authority, error] of [
    [{ can_mutate_migration_ledger: true, can_execute_user_routine: false }, /retains effective migration-ledger mutation privileges/],
    [{ can_mutate_migration_ledger: false, can_execute_user_routine: true }, /retains effective function or procedure execution privileges/],
  ] as const) {
    const executor: PostgresRuntimeRoleExecutor = {
      async query(text, values) {
        if (text.includes('AS can_mutate_migration_ledger')) return { rows: [authority] }
        const infrastructure = infrastructureResult(text)
        if (infrastructure) return infrastructure
        if (text.includes('current_database()')) return { rows: [{ database_name: 'open_cowork_cloud' }] }
        if (values?.[0] === 'open_cowork_runtime') return { rows: [safeRuntimeRole] }
        if (values?.[0] === 'runtime@project.iam') return { rows: [safeRuntimePrincipal] }
        return { rows: [] }
      },
    }
    await assert.rejects(
      provisionPostgresRuntimeRole(executor, {
        role: 'open_cowork_runtime',
        principal: 'runtime@project.iam',
      }),
      error,
    )
  }
})

test('PostgreSQL 17 runtime provisioning rejects ownership and normalizes existing authority', { skip: POSTGRES_SKIP }, async (context) => {
  assert.ok(POSTGRES_URL)
  const { Client } = await import('pg')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
  const databaseName = `oc_role_${suffix}`
  const runtimeRole = `oc_runtime_${suffix}`
  const runtimePrincipal = `oc_principal_${suffix}`
  const ownedRole = `oc_owned_role_${suffix}`
  const ownedPrincipal = `oc_owned_user_${suffix}`
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  const targetUrl = new URL(POSTGRES_URL)
  targetUrl.pathname = `/${databaseName}`
  const admin = new Client({ connectionString: POSTGRES_URL })
  let target: InstanceType<typeof Client> | undefined
  let databaseCreated = false
  await admin.connect()
  try {
    const capabilities = await admin.query<{
      rolsuper: boolean
      rolcreatedb: boolean
      rolcreaterole: boolean
    }>(
      `SELECT rolsuper, rolcreatedb, rolcreaterole
       FROM pg_catalog.pg_roles
       WHERE rolname = current_user`,
    )
    const role = capabilities.rows[0]
    if (!role?.rolsuper && !(role?.rolcreatedb && role?.rolcreaterole)) {
      context.skip('Real role provisioning requires a PostgreSQL test user with CREATEDB and CREATEROLE.')
      return
    }

    await admin.query(`CREATE ROLE ${quote(runtimeRole)} NOLOGIN`)
    await admin.query(`CREATE ROLE ${quote(runtimePrincipal)} LOGIN`)
    await admin.query(`CREATE ROLE ${quote(ownedRole)} NOLOGIN`)
    await admin.query(`CREATE ROLE ${quote(ownedPrincipal)} LOGIN`)
    await admin.query(`CREATE DATABASE ${quote(databaseName)}`)
    databaseCreated = true
    target = new Client({ connectionString: targetUrl.toString() })
    await target.connect()
    await target.query('CREATE TABLE public.cloud_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL)')
    await target.query('CREATE TABLE public.runtime_fixture (id text PRIMARY KEY)')
    await target.query('CREATE TABLE public.owned_fixture (id text PRIMARY KEY)')
    await target.query(`ALTER TABLE public.owned_fixture OWNER TO ${quote(ownedPrincipal)}`)
    await target.query(`CREATE FUNCTION public.runtime_fixture_function() RETURNS integer
      LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`)
    await target.query(`CREATE PROCEDURE public.runtime_fixture_procedure()
      LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`)

    await assert.rejects(
      provisionPostgresRuntimeRole(target, {
        role: ownedRole,
        principal: ownedPrincipal,
      }),
      /own database objects and cannot be reduced to grants safely/,
    )

    await target.query(`GRANT ${quote(runtimeRole)} TO ${quote(runtimePrincipal)} WITH ADMIN OPTION`)
    await assert.rejects(
      provisionPostgresRuntimeRole(target, {
        role: runtimeRole,
        principal: runtimePrincipal,
      }),
      /admin=true/,
    )
    await target.query(`REVOKE ${quote(runtimeRole)} FROM ${quote(runtimePrincipal)} CASCADE`)
    // PG16+ defaults SET to true. Provisioning must accept this non-admin state
    // and then normalize it to SET FALSE.
    await target.query(`GRANT ${quote(runtimeRole)} TO ${quote(runtimePrincipal)}`)
    await target.query(`GRANT CREATE ON DATABASE ${quote(databaseName)} TO ${quote(runtimeRole)}, ${quote(runtimePrincipal)}`)
    await target.query(`GRANT CREATE ON SCHEMA public TO ${quote(runtimeRole)}, ${quote(runtimePrincipal)}`)
    await target.query(`GRANT ALL PRIVILEGES ON TABLE public.runtime_fixture TO ${quote(runtimePrincipal)}`)
    await target.query('GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.cloud_schema_migrations TO PUBLIC')
    await target.query(`GRANT EXECUTE ON FUNCTION public.runtime_fixture_function() TO ${quote(runtimeRole)}, ${quote(runtimePrincipal)}`)
    await target.query(`GRANT EXECUTE ON PROCEDURE public.runtime_fixture_procedure() TO ${quote(runtimeRole)}, ${quote(runtimePrincipal)}`)

    await provisionPostgresRuntimeRole(target, {
      role: runtimeRole,
      principal: runtimePrincipal,
    })

    const privileges = await target.query<{
      role_database_create: boolean
      principal_database_create: boolean
      role_schema_create: boolean
      principal_schema_create: boolean
      role_function_execute: boolean
      principal_function_execute: boolean
      role_procedure_execute: boolean
      principal_procedure_execute: boolean
      principal_table_select: boolean
      role_ledger_select: boolean
      role_ledger_update: boolean
      principal_ledger_insert: boolean
    }>(
      `SELECT
         has_database_privilege($1, current_database(), 'CREATE') AS role_database_create,
         has_database_privilege($2, current_database(), 'CREATE') AS principal_database_create,
         has_schema_privilege($1, 'public', 'CREATE') AS role_schema_create,
         has_schema_privilege($2, 'public', 'CREATE') AS principal_schema_create,
         has_function_privilege($1, 'public.runtime_fixture_function()', 'EXECUTE') AS role_function_execute,
         has_function_privilege($2, 'public.runtime_fixture_function()', 'EXECUTE') AS principal_function_execute,
         has_function_privilege($1, 'public.runtime_fixture_procedure()', 'EXECUTE') AS role_procedure_execute,
         has_function_privilege($2, 'public.runtime_fixture_procedure()', 'EXECUTE') AS principal_procedure_execute,
         has_table_privilege($2, 'public.runtime_fixture', 'SELECT') AS principal_table_select,
         has_table_privilege($1, 'public.cloud_schema_migrations', 'SELECT') AS role_ledger_select,
         has_table_privilege($1, 'public.cloud_schema_migrations', 'UPDATE') AS role_ledger_update,
         has_table_privilege($2, 'public.cloud_schema_migrations', 'INSERT') AS principal_ledger_insert`,
      [runtimeRole, runtimePrincipal],
    )
    assert.deepEqual(privileges.rows[0], {
      role_database_create: false,
      principal_database_create: false,
      role_schema_create: false,
      principal_schema_create: false,
      role_function_execute: false,
      principal_function_execute: false,
      role_procedure_execute: false,
      principal_procedure_execute: false,
      principal_table_select: true,
      role_ledger_select: true,
      role_ledger_update: false,
      principal_ledger_insert: false,
    })

    const membership = await target.query<{
      admin_option: boolean
      inherit_option: boolean
      set_option: boolean
    }>(
      `SELECT membership.admin_option,
              (to_jsonb(membership)->>'inherit_option')::boolean AS inherit_option,
              (to_jsonb(membership)->>'set_option')::boolean AS set_option
       FROM pg_catalog.pg_auth_members membership
       JOIN pg_catalog.pg_roles inherited ON inherited.oid = membership.roleid
       JOIN pg_catalog.pg_roles member ON member.oid = membership.member
       WHERE inherited.rolname = $1 AND member.rolname = $2`,
      [runtimeRole, runtimePrincipal],
    )
    assert.deepEqual(membership.rows[0], {
      admin_option: false,
      inherit_option: true,
      set_option: false,
    })
  } finally {
    await target?.end().catch(() => {})
    if (databaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`).catch(() => {})
    }
    await admin.query(
      `DROP ROLE IF EXISTS ${quote(runtimePrincipal)}, ${quote(runtimeRole)}, ${quote(ownedPrincipal)}, ${quote(ownedRole)}`,
    ).catch(() => {})
    await admin.end()
  }
})
