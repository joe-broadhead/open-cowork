type QueryRow = Record<string, unknown>
type QueryResult<Row extends QueryRow = QueryRow> = { rows: Row[] }

export type PostgresRuntimeRoleExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

export type PostgresRuntimeRoleInput = {
  role: string
  principal: string
}

const POSTGRES_ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/
// Managed PostgreSQL IAM authentication necessarily grants these narrowly
// scoped, non-login marker roles to the login principal. They do not confer
// database administration or data access by themselves. Every other existing
// membership remains fail-closed below.
const SAFE_PROVIDER_LOGIN_ROLES = new Set(['cloudsqliamuser', 'rds_iam'])

type PostgresRoleAttributes = {
  rolsuper: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  rolcanlogin: boolean
  rolinherit: boolean
  rolreplication: boolean
  rolbypassrls: boolean
}

type PostgresRoleMembership = PostgresRoleAttributes & {
  origin_name: string
  inherited_role_name: string
  depth: number | string
  admin_option: boolean
  inherit_option: boolean
  set_option: boolean
  membership_options_supported: boolean
}

type PostgresOwnedObject = {
  owner_name: string
  object_identity: string
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

export function validatePostgresRuntimeRoleInput(input: PostgresRuntimeRoleInput) {
  if (!POSTGRES_ROLE_NAME.test(input.role)) {
    throw new Error('OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE must be a lowercase PostgreSQL role identifier no longer than 63 characters.')
  }
  if (!input.principal.trim() || input.principal.includes('\0')) {
    throw new Error('OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL must name the dedicated runtime IAM database user.')
  }
  if (input.principal.trim() === input.role) {
    throw new Error('The Cloud runtime database principal and non-login runtime role must be distinct PostgreSQL roles.')
  }
}

function hasElevatedAttributes(attributes: PostgresRoleAttributes) {
  return attributes.rolsuper
    || attributes.rolcreaterole
    || attributes.rolcreatedb
    || attributes.rolreplication
    || attributes.rolbypassrls
}

async function roleMemberships(
  executor: PostgresRuntimeRoleExecutor,
  roots: readonly string[],
) {
  return (await executor.query<PostgresRoleMembership>(
    `WITH RECURSIVE membership_tree AS (
       SELECT origin.oid AS origin_oid,
              origin.rolname AS origin_name,
              inherited.oid AS inherited_role_oid,
              inherited.rolname AS inherited_role_name,
              1 AS depth,
              ARRAY[origin.oid, inherited.oid] AS visited,
              membership.admin_option,
              COALESCE((to_jsonb(membership)->>'inherit_option')::boolean, true) AS inherit_option,
              COALESCE((to_jsonb(membership)->>'set_option')::boolean, true) AS set_option,
              to_jsonb(membership) ? 'inherit_option' AS membership_options_supported
       FROM pg_catalog.pg_roles origin
       JOIN pg_catalog.pg_auth_members membership ON membership.member = origin.oid
       JOIN pg_catalog.pg_roles inherited ON inherited.oid = membership.roleid
       WHERE origin.rolname = ANY($1::text[])
       UNION ALL
       SELECT membership_tree.origin_oid,
              membership_tree.origin_name,
              inherited.oid,
              inherited.rolname,
              membership_tree.depth + 1,
              membership_tree.visited || inherited.oid,
              membership.admin_option,
              COALESCE((to_jsonb(membership)->>'inherit_option')::boolean, true),
              COALESCE((to_jsonb(membership)->>'set_option')::boolean, true),
              to_jsonb(membership) ? 'inherit_option'
       FROM membership_tree
       JOIN pg_catalog.pg_auth_members membership
         ON membership.member = membership_tree.inherited_role_oid
       JOIN pg_catalog.pg_roles inherited ON inherited.oid = membership.roleid
       WHERE NOT inherited.oid = ANY(membership_tree.visited)
     )
     SELECT membership_tree.origin_name,
            membership_tree.inherited_role_name,
            membership_tree.depth,
            membership_tree.admin_option,
            membership_tree.inherit_option,
            membership_tree.set_option,
            membership_tree.membership_options_supported,
            inherited.rolsuper,
            inherited.rolcreaterole,
            inherited.rolcreatedb,
            inherited.rolcanlogin,
            inherited.rolinherit,
            inherited.rolreplication,
            inherited.rolbypassrls
     FROM membership_tree
     JOIN pg_catalog.pg_roles inherited
       ON inherited.oid = membership_tree.inherited_role_oid
     ORDER BY membership_tree.origin_name, membership_tree.depth, membership_tree.inherited_role_name`,
    [roots],
  )).rows
}

async function roleOwnedObjects(
  executor: PostgresRuntimeRoleExecutor,
  roles: readonly string[],
) {
  return (await executor.query<PostgresOwnedObject>(
    `SELECT owner.rolname AS owner_name,
            pg_catalog.pg_describe_object(
              dependency.classid,
              dependency.objid,
              dependency.objsubid
            ) AS object_identity
     FROM pg_catalog.pg_shdepend dependency
     JOIN pg_catalog.pg_roles owner ON owner.oid = dependency.refobjid
     JOIN pg_catalog.pg_database current_database_row
       ON current_database_row.datname = current_database()
     WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
       AND dependency.deptype = 'o'
       AND owner.rolname = ANY($1::text[])
       AND (
         dependency.dbid = current_database_row.oid
         OR (
           dependency.dbid = 0
           AND dependency.classid = 'pg_catalog.pg_database'::regclass
           AND dependency.objid = current_database_row.oid
         )
       )
     ORDER BY owner.rolname, object_identity`,
    [roles],
  )).rows
}

async function userSchemaNames(executor: PostgresRuntimeRoleExecutor) {
  const rows = (await executor.query<{ schema_name: string }>(
    `SELECT namespace.nspname AS schema_name
     FROM pg_catalog.pg_namespace namespace
     WHERE namespace.nspname <> 'information_schema'
       AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
     ORDER BY namespace.nspname`,
  )).rows
  // Runtime tables live in public today. Keep it in the normalization set even
  // for deliberately minimal fake catalogs and newly created databases.
  return [...new Set(['public', ...rows.map((row) => String(row.schema_name))])]
}

function membershipOptionsAreKnown(membership: PostgresRoleMembership) {
  return typeof membership.admin_option === 'boolean'
    && typeof membership.inherit_option === 'boolean'
    && typeof membership.set_option === 'boolean'
    && typeof membership.membership_options_supported === 'boolean'
}

async function assertRuntimePrincipalBoundary(
  executor: PostgresRuntimeRoleExecutor,
  principal: string,
) {
  const result = await executor.query<{
    can_mutate_migration_ledger: boolean
    can_execute_user_routine: boolean
  }>(
    `SELECT
       has_table_privilege($1, 'public.cloud_schema_migrations', 'INSERT')
         OR has_table_privilege($1, 'public.cloud_schema_migrations', 'UPDATE')
         OR has_table_privilege($1, 'public.cloud_schema_migrations', 'DELETE')
         OR has_table_privilege($1, 'public.cloud_schema_migrations', 'TRUNCATE')
         OR has_table_privilege($1, 'public.cloud_schema_migrations', 'REFERENCES')
         OR has_table_privilege($1, 'public.cloud_schema_migrations', 'TRIGGER')
         AS can_mutate_migration_ledger,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname <> 'information_schema'
           AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
           AND procedure.prokind IN ('f', 'p')
           AND has_function_privilege($1, procedure.oid, 'EXECUTE')
       ) AS can_execute_user_routine`,
    [principal],
  )
  const authority = result.rows[0]
  if (!authority || authority.can_mutate_migration_ledger !== false) {
    throw new Error(`Cloud runtime database principal ${principal} retains effective migration-ledger mutation privileges after normalization.`)
  }
  if (authority.can_execute_user_routine !== false) {
    throw new Error(`Cloud runtime database principal ${principal} retains effective function or procedure execution privileges after normalization.`)
  }
}

/**
 * Establish the least-privilege database boundary after the migrator has
 * applied the current baseline. The migrator owns schema DDL; long-running web,
 * worker, and scheduler processes only receive data/sequence access.
 */
export async function provisionPostgresRuntimeRole(
  executor: PostgresRuntimeRoleExecutor,
  input: PostgresRuntimeRoleInput,
) {
  validatePostgresRuntimeRoleInput(input)
  const role = quoteIdentifier(input.role)
  const principalName = input.principal.trim()
  const principal = quoteIdentifier(principalName)
  const databaseResult = await executor.query<{ database_name: string }>('SELECT current_database() AS database_name')
  const databaseName = String(databaseResult.rows[0]?.database_name || '').trim()
  if (!databaseName) throw new Error('Could not resolve the current PostgreSQL database while provisioning the runtime role.')

  const existingRole = await executor.query<PostgresRoleAttributes>(
    `SELECT rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolinherit, rolreplication, rolbypassrls
     FROM pg_roles
     WHERE rolname = $1`,
    [input.role],
  )
  const attributes = existingRole.rows[0]
  if (!attributes) {
    await executor.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
  } else if (
    hasElevatedAttributes(attributes)
    || attributes.rolcanlogin
  ) {
    throw new Error(`Refusing to use privileged or login-capable PostgreSQL role ${input.role} as the Cloud runtime role.`)
  }

  const runtimePrincipal = await executor.query<PostgresRoleAttributes>(
    `SELECT rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolinherit, rolreplication, rolbypassrls
     FROM pg_roles
     WHERE rolname = $1`,
    [principalName],
  )
  const principalAttributes = runtimePrincipal.rows[0]
  if (!principalAttributes) {
    throw new Error(`Cloud runtime database principal ${principalName} does not exist. Apply the runtime IAM database user before running migrations.`)
  }
  if (hasElevatedAttributes(principalAttributes)) {
    throw new Error(`Cloud runtime database principal ${principalName} has privileged PostgreSQL role attributes.`)
  }
  if (!principalAttributes.rolcanlogin) {
    throw new Error(`Cloud runtime database principal ${principalName} must be a dedicated login role.`)
  }
  if (!principalAttributes.rolinherit) {
    throw new Error(`Cloud runtime database principal ${principalName} must inherit its least-privilege group role.`)
  }

  // Attribute checks alone are insufficient on managed providers: roles such
  // as cloudsqlsuperuser, rds_superuser, and azure_pg_admin can confer broad
  // administrative power through membership without marking the IAM/login
  // principal itself as SUPERUSER. Permit only a direct, idempotent membership
  // in the exact runtime role or a direct membership in the provider's minimal
  // IAM-auth marker role. This also walks each role's ancestry so an indirect
  // admin membership cannot be hidden behind an innocuously named group.
  const memberships = await roleMemberships(executor, [principalName, input.role])
  const unsafeMemberships = memberships.filter((membership) => {
    const directMembership = membership.origin_name === principalName
      && Number(membership.depth) === 1
      && !hasElevatedAttributes(membership)
      && membership.rolcanlogin === false
      && membershipOptionsAreKnown(membership)
      && membership.admin_option === false
    const normalizableRuntimeMembership = directMembership
      && membership.inherited_role_name === input.role
      // PG15 has no per-membership INHERIT/SET columns; the catalog projection
      // above maps its fixed historical behavior to TRUE/TRUE. PG16+ options
      // are normalized by the revoke/re-grant below after ADMIN is proven off.
      && (
        membership.membership_options_supported
        || (membership.inherit_option === true && membership.set_option === true)
      )
    const safeProviderMarkerMembership = directMembership
      && SAFE_PROVIDER_LOGIN_ROLES.has(membership.inherited_role_name)
      && membership.inherit_option === true
      && membership.set_option === true
    return !normalizableRuntimeMembership && !safeProviderMarkerMembership
  })
  if (unsafeMemberships.length > 0) {
    const summary = unsafeMemberships
      .slice(0, 5)
      .map((membership) => (
        `${membership.origin_name}->${membership.inherited_role_name} (depth ${membership.depth}, `
        + `admin=${String(membership.admin_option)}, inherit=${String(membership.inherit_option)}, set=${String(membership.set_option)})`
      ))
      .join(', ')
    throw new Error(
      `Cloud runtime database roles have pre-existing provider/admin or unverified role memberships: ${summary}.`,
    )
  }

  const ownedObjects = await roleOwnedObjects(executor, [input.role, principalName])
  if (ownedObjects.length > 0) {
    const summary = ownedObjects
      .slice(0, 5)
      .map((object) => `${object.owner_name}: ${object.object_identity}`)
      .join(', ')
    throw new Error(
      `Cloud runtime database roles own database objects and cannot be reduced to grants safely: ${summary}. Transfer ownership to the migrator before provisioning runtime access.`,
    )
  }

  const database = quoteIdentifier(databaseName)
  const grantees = `${role}, ${principal}`
  const safeProviderRoleNames = [...new Set(memberships
    .map((membership) => membership.inherited_role_name)
    .filter((roleName) => SAFE_PROVIDER_LOGIN_ROLES.has(roleName)))]
  const ambientGrantees = [
    'PUBLIC',
    role,
    principal,
    ...safeProviderRoleNames.map(quoteIdentifier),
  ].join(', ')
  // Normalize both the group and login principal instead of assuming they were
  // born empty. Ownership was rejected above because ACL revocation cannot
  // constrain an owner; all remaining direct authority can now be removed and
  // rebuilt deterministically.
  await executor.query(`ALTER ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`)
  await executor.query(`REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${grantees}`)
  await executor.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
  for (const schemaName of await userSchemaNames(executor)) {
    const schema = quoteIdentifier(schemaName)
    await executor.query(`REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${grantees}`)
    await executor.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${grantees}`)
    await executor.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${grantees}`)
    // PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Remove
    // that ambient path as well as direct grants, otherwise a SECURITY DEFINER
    // function could bypass the table ACL boundary below.
    await executor.query(`REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA ${schema} FROM ${ambientGrantees}`)
    await executor.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL PRIVILEGES ON TABLES FROM ${grantees}`)
    await executor.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${grantees}`)
    await executor.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE EXECUTE ON ROUTINES FROM ${ambientGrantees}`)
  }
  await executor.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)
  await executor.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
  await executor.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
  await executor.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
  // Readiness verifies the migration ledger, so runtime needs SELECT but must
  // never be able to forge, delete, or otherwise mutate migration history.
  await executor.query(`REVOKE ALL PRIVILEGES ON TABLE public.cloud_schema_migrations FROM ${ambientGrantees}`)
  await executor.query(`GRANT SELECT ON TABLE public.cloud_schema_migrations TO ${role}`)
  // These defaults intentionally cover ordinary tables created by future
  // migrations. A migration that introduces another security/metadata table
  // must add an explicit least-privilege override here, with a regression test.
  await executor.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`)
  await executor.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`)
  // Recreate the one application membership so PG16+ cannot SET ROLE to the
  // group identity. The version branch keeps the migration compatible with
  // PG15, where INHERIT/SET membership options do not exist and the historical
  // semantics are equivalent to INHERIT TRUE, SET TRUE.
  const versionResult = await executor.query<{ server_version_num: string }>(
    `SELECT current_setting('server_version_num') AS server_version_num`,
  )
  const serverVersion = Number(versionResult.rows[0]?.server_version_num)
  if (!Number.isInteger(serverVersion) || serverVersion < 120000) {
    throw new Error('Could not verify the PostgreSQL server version before granting runtime-role membership.')
  }
  await executor.query(`REVOKE ${role} FROM ${principal}`)
  await executor.query(serverVersion >= 160000
    ? `GRANT ${role} TO ${principal} WITH INHERIT TRUE, SET FALSE`
    : `GRANT ${role} TO ${principal}`)
  await assertRuntimePrincipalBoundary(executor, principalName)
}
