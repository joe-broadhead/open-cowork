import { promises as fs } from "node:fs";
import { createRun } from "@openwiki/jobs";
import {
  ignoreInboxItem,
  listInboxWorkflow,
  processInboxItem,
  readInboxWorkflow,
  retryInboxItem,
  submitInboxItem,
  watchInboxOnce,
} from "@openwiki/workflows";
import type { InboxItemStatus } from "@openwiki/core";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { resolveRoot } from "../utils.ts";
import { parseAutomationIntervalSeconds, runForegroundWatcher } from "./watch.ts";

export async function inboxCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id] = args;
  switch (subcommand) {
    case "add":
      await inboxAddCommand(options);
      return;
    case "list":
    case undefined:
      await inboxListCommand(options);
      return;
    case "read":
      await inboxReadCommand(id, options);
      return;
    case "ignore":
      await inboxIgnoreCommand(id, options);
      return;
    case "retry":
      await inboxRetryCommand(id, options);
      return;
    case "process":
      await inboxProcessCommand(id, options);
      return;
    case "watch":
      await inboxWatchCommand(options);
      return;
    default:
      throw new Error(inboxUsage());
  }
}

async function inboxAddCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const content = options.contentFile === undefined ? undefined : await fs.readFile(options.contentFile, "utf8");
  const result = await submitInboxItem({
    root,
    title: options.title ?? inferTitle(options.contentFile) ?? "Inbox item",
    ...(content === undefined ? {} : { content }),
    ...(options.sourceType === undefined ? {} : { inboxKind: options.sourceType }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.inboxAdapter === undefined ? {} : { adapter: options.inboxAdapter }),
    ...(options.actor === undefined ? {} : { ownerActorId: options.actor, submittedBy: options.actor }),
    ...(options.sectionId === undefined ? {} : { targetSpaceId: options.sectionId }),
    ...(options.targetPath === undefined ? {} : { targetPath: options.targetPath }),
    ...(options.externalId === undefined ? {} : { externalId: options.externalId }),
    ...(options.url === undefined ? {} : { sourceUrl: options.url }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.visibility === undefined ? {} : { sensitivity: options.visibility }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(result.duplicate ? `duplicate ${result.item.id}` : `submitted ${result.item.id}`);
  if (result.payload_path !== undefined) {
    console.log(result.payload_path);
  }
}

async function inboxListCommand(options: CliOptions): Promise<void> {
  const statuses = inboxStatuses(options.statuses);
  const result = await listInboxWorkflow({
    root: await resolveRoot(options),
    ...(statuses === undefined ? {} : { statuses }),
    ...(options.actor === undefined ? {} : { ownerActorId: options.actor }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.sourceType === undefined ? {} : { inboxKind: options.sourceType }),
    ...(options.sectionId === undefined ? {} : { targetSpaceId: options.sectionId }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  for (const item of result.items) {
    console.log(`${item.updated_at}  ${item.status}  ${item.provider}/${item.inbox_kind}  ${item.id}  ${item.title}`);
  }
}

async function inboxReadCommand(id: string | undefined, options: CliOptions): Promise<void> {
  if (id === undefined) {
    throw new Error("Usage: openwiki [--root <path>] inbox read <inbox-id> [--max-bytes N] [--json]");
  }
  const result = await readInboxWorkflow({
    root: await resolveRoot(options),
    id,
    includeContent: true,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`${result.item.status} ${result.item.id} ${result.item.title}`);
  console.log(`provider=${result.item.provider} kind=${result.item.inbox_kind}`);
  if (result.content !== undefined) {
    console.log("");
    console.log(result.content.body);
  }
}

async function inboxIgnoreCommand(id: string | undefined, options: CliOptions): Promise<void> {
  if (id === undefined) {
    throw new Error("Usage: openwiki [--root <path>] inbox ignore <inbox-id> [--reason text] [--actor actor:user:local] [--json]");
  }
  const result = await ignoreInboxItem({
    root: await resolveRoot(options),
    id,
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`ignored ${result.item.id}`);
}

async function inboxRetryCommand(id: string | undefined, options: CliOptions): Promise<void> {
  if (id === undefined) {
    throw new Error("Usage: openwiki [--root <path>] inbox retry <inbox-id> [--actor actor:user:local] [--json]");
  }
  const result = await retryInboxItem({
    root: await resolveRoot(options),
    id,
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`retried ${result.item.id}`);
}

async function inboxProcessCommand(id: string | undefined, options: CliOptions): Promise<void> {
  if (id === undefined) {
    throw new Error("Usage: openwiki [--root <path>] inbox process <inbox-id> [--dry-run] [--enqueue] [--actor actor:user:local] [--json]");
  }
  if (options.enqueue) {
    const run = await createRun({
      root: await resolveRoot(options),
      runType: "inbox.process",
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      input: {
        id,
        ...(options.dryRun === true ? { dry_run: true } : {}),
      },
    });
    if (options.json) {
      printJson({ run });
      return;
    }
    console.log(`queued ${run.id} ${run.run_type} ${id}`);
    return;
  }
  const result = await processInboxItem({
    root: await resolveRoot(options),
    id,
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    dryRun: options.dryRun === true,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`${result.dry_run ? "would process" : "processed"} ${result.item.id}`);
  for (const step of result.plan) {
    console.log(`- ${step}`);
  }
  if (result.source !== undefined) {
    console.log(`source=${result.source.id}`);
  }
}

async function inboxWatchCommand(options: CliOptions): Promise<void> {
  if (options.inboxDir === undefined) {
    throw new Error("Usage: openwiki [--root <path>] inbox watch --dir <folder> [--adapter file] [--provider source-name] [--source-type meeting_transcript] [--every 30s] [--once] [--json]");
  }
  const root = await resolveRoot(options);
  const watchDir = options.inboxDir;
  const everySeconds = parseAutomationIntervalSeconds(options.every ?? "30s");
  const result = await runForegroundWatcher({
    root,
    kind: "inbox",
    everySeconds,
    once: options.once,
    runOnce: async () => {
      const scan = await watchInboxOnce({
        root,
        dir: watchDir,
        adapter: options.inboxAdapter ?? "file",
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.sourceType === undefined ? {} : { inboxKind: options.sourceType }),
        ...(options.actor === undefined ? {} : { ownerActorId: options.actor }),
        ...(options.sectionId === undefined ? {} : { targetSpaceId: options.sectionId }),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        ...(options.archiveDir === undefined ? {} : { archiveDir: options.archiveDir }),
        ...(options.quarantineDir === undefined ? {} : { quarantineDir: options.quarantineDir }),
      });
      return {
        status: "success",
        message: `scanned=${scan.scanned} submitted=${scan.submitted} duplicates=${scan.duplicates} failed=${scan.failed}`,
        details: scan as unknown as Record<string, unknown>,
      };
    },
    ...(options.json ? {} : { log: console.log }),
  });
  if (options.json) {
    printJson(result);
  }
}

function inboxStatuses(values: string[]): InboxItemStatus[] | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.map((value) => {
    if (
      value === "received" ||
      value === "queued" ||
      value === "processing" ||
      value === "proposed" ||
      value === "applied" ||
      value === "ignored" ||
      value === "failed" ||
      value === "superseded"
    ) {
      return value;
    }
    throw new Error(`Invalid inbox status '${value}'`);
  });
}

function inferTitle(filePath: string | undefined): string | undefined {
  if (filePath === undefined) {
    return undefined;
  }
  const base = filePath.split(/[\\/]/).at(-1);
  if (base === undefined) {
    return undefined;
  }
  return base.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

function inboxUsage(): string {
  return "Usage: openwiki [--root <path>] inbox add|list|read|ignore|retry|process|watch ...";
}
