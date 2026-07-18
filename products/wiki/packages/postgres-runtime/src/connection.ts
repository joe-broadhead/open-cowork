import postgres from "postgres";
import { resolvePostgresDatabaseUrl } from "./config.ts";
import type { PostgresRuntimeOptions, PostgresSql } from "./types.ts";

interface OpenedPostgresSql {
  sql: PostgresSql;
  close(): Promise<void>;
}

const pooledSqlByUrl = new Map<string, PostgresSql>();

export function openPostgresSql(options: PostgresRuntimeOptions = {}, connection: { pooled?: boolean; max?: number } = {}): OpenedPostgresSql {
  const databaseUrl = resolvePostgresDatabaseUrl(options);
  const pooled = connection.pooled ?? options.pooled ?? false;
  if (pooled) {
    let sql = pooledSqlByUrl.get(databaseUrl);
    if (sql === undefined) {
      sql = postgres(databaseUrl, {
        max: boundedPoolSize(connection.max),
        idle_timeout: boundedIdleTimeoutSeconds(process.env.OPENWIKI_POSTGRES_POOL_IDLE_SECONDS),
      });
      pooledSqlByUrl.set(databaseUrl, sql);
    }
    return {
      sql,
      close: async () => {},
    };
  }
  const sql = postgres(databaseUrl, { max: connection.max ?? 1 });
  return {
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

export async function closePostgresSqlPools(): Promise<void> {
  const pools = [...pooledSqlByUrl.values()];
  pooledSqlByUrl.clear();
  await Promise.all(pools.map((sql) => sql.end({ timeout: 5 })));
}

function boundedPoolSize(value: number | undefined): number {
  const parsed = Math.trunc(value ?? Number(process.env.OPENWIKI_POSTGRES_POOL_MAX ?? "4"));
  return Math.min(Math.max(parsed, 1), 20);
}

function boundedIdleTimeoutSeconds(value: string | undefined): number {
  const parsed = Math.trunc(Number(value ?? "15"));
  if (!Number.isFinite(parsed)) {
    return 15;
  }
  return Math.min(Math.max(parsed, 1), 300);
}
