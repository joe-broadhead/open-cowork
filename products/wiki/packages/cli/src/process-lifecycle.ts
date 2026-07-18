import type { StartedHttpApi } from "@openwiki/http-api";
import { openWikiCliExitCodeForError } from "@openwiki/core";

const DEFAULT_CLI_SHUTDOWN_TIMEOUT_MS = 10_000;
const cliShutdownHooks = new Set<() => Promise<void>>();
let cliProcessHandlersInstalled = false;
let cliShutdownStarted = false;

export function installCliProcessHandlers(): void {
  if (cliProcessHandlersInstalled) {
    return;
  }
  cliProcessHandlersInstalled = true;
  process.once("SIGTERM", (signal) => {
    void runCliShutdown(signal, 0).finally(() => process.exit(process.exitCode ?? 0));
  });
  process.once("SIGINT", (signal) => {
    void runCliShutdown(signal, 130).finally(() => process.exit(process.exitCode ?? 130));
  });
  process.once("unhandledRejection", (reason) => {
    console.error(`openwiki: unhandled rejection: ${cliErrorMessage(reason)}`);
    void runCliShutdown("unhandledRejection", 1).finally(() => process.exit(process.exitCode ?? 1));
  });
  process.once("uncaughtException", (error) => {
    console.error(`openwiki: uncaught exception: ${cliErrorMessage(error)}`);
    void runCliShutdown("uncaughtException", openWikiCliExitCodeForError(error)).finally(() => process.exit(process.exitCode ?? 1));
  });
}

export function registerCliShutdownHook(hook: () => Promise<void>): () => void {
  cliShutdownHooks.add(hook);
  return () => {
    cliShutdownHooks.delete(hook);
  };
}

export function registerHttpApiShutdown(started: StartedHttpApi): void {
  const unregister = registerCliShutdownHook(() => started.close({ timeoutMs: cliShutdownTimeoutMs() }));
  started.server.once("close", unregister);
}

export function cliErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCliShutdown(reason: string, exitCode: number): Promise<void> {
  if (cliShutdownStarted) {
    process.exitCode = process.exitCode ?? exitCode;
    return;
  }
  cliShutdownStarted = true;
  process.exitCode = exitCode;
  if (cliShutdownHooks.size > 0) {
    console.error(`openwiki: received ${reason}; shutting down`);
  }
  for (const hook of Array.from(cliShutdownHooks)) {
    try {
      await hook();
    } catch (error) {
      process.exitCode = 1;
      console.error(`openwiki: shutdown hook failed: ${cliErrorMessage(error)}`);
    }
  }
}

function cliShutdownTimeoutMs(): number {
  const raw = process.env.OPENWIKI_SHUTDOWN_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CLI_SHUTDOWN_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 120_000) {
    throw new Error("OPENWIKI_SHUTDOWN_TIMEOUT_MS must be an integer between 100 and 120000");
  }
  return parsed;
}
