import type { PostgresRuntimeOptions } from "./types.ts";

export function resolvePostgresDatabaseUrl(options: PostgresRuntimeOptions = {}): string {
  const env = options.databaseUrlEnv ?? process.env;
  const value = options.databaseUrl ?? env.OPENWIKI_DATABASE_URL ?? env.DATABASE_URL;
  if (!value || !value.trim()) {
    throw new Error("Postgres runtime requires OPENWIKI_DATABASE_URL or DATABASE_URL");
  }
  return value.trim();
}

export function postgresRuntimeReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENWIKI_READ_BACKEND === "postgres" || env.OPENWIKI_RUNTIME_BACKEND === "postgres";
}

export function postgresRuntimeSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENWIKI_SEARCH_BACKEND === "postgres" || env.OPENWIKI_RUNTIME_BACKEND === "postgres";
}

export function postgresRuntimeWriteSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.OPENWIKI_POSTGRES_SYNC_ON_WRITE === "1" ||
    env.OPENWIKI_RUNTIME_BACKEND === "postgres" ||
    postgresRuntimeReadEnabled(env) ||
    postgresRuntimeSearchEnabled(env)
  );
}

export function postgresRuntimeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENWIKI_DATABASE_URL?.trim() || env.DATABASE_URL?.trim());
}

export function postgresRuntimeHealthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    postgresRuntimeConfigured(env) &&
    (postgresRuntimeReadEnabled(env) ||
      postgresRuntimeSearchEnabled(env) ||
      postgresRuntimeWriteSyncEnabled(env) ||
      env.OPENWIKI_QUEUE_BACKEND === "postgres")
  );
}

export function databaseUrlSource(env: NodeJS.ProcessEnv): string {
  if (env.OPENWIKI_DATABASE_URL?.trim()) {
    return "OPENWIKI_DATABASE_URL";
  }
  if (env.DATABASE_URL?.trim()) {
    return "DATABASE_URL";
  }
  return "missing";
}
