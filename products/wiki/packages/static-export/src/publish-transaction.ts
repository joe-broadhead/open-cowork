import { promises as fs } from "node:fs";
import path from "node:path";
import type { EventRecord } from "@openwiki/core";
import type { appendEvent } from "@openwiki/repo";
import type { PublishStaticSiteOptions, PublishStaticSiteResult, StaticExportOptions, StaticExportResult } from "./types.ts";
import { resolveStaticExportOutDir } from "./paths.ts";

export interface StaticPublishTransactionDependencies {
  exportStaticSite(options: StaticExportOptions): Promise<StaticExportResult>;
  loadRepository(root: string): Promise<{ config: { workspace_id: string } }>;
  appendEvent(root: string, input: Parameters<typeof appendEvent>[1]): Promise<EventRecord>;
}

export async function runStaticPublishTransaction(
  options: PublishStaticSiteOptions,
  dependencies: StaticPublishTransactionDependencies,
): Promise<PublishStaticSiteResult> {
  const actorId = options.actorId ?? "actor:user:local";
  // Publish artifacts must include the publish.completed event they report. Keep the
  // current double-export contract explicit: first render validates publication in
  // an isolated output directory, then append the canonical event, then render the
  // derived artifact snapshot into the requested publish directory.
  const finalOutDir = await resolveStaticExportOutDir(options.root, options.outDir);
  const validationOutDir = path.relative(path.resolve(options.root), temporaryStaticExportDir(finalOutDir));
  let validationResult: StaticExportResult | undefined;
  try {
    validationResult = await dependencies.exportStaticSite({ ...options, outDir: validationOutDir });
  } finally {
    if (validationResult !== undefined) {
      await fs.rm(validationResult.outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const initial = validationResult;
  const repo = await dependencies.loadRepository(initial.root);
  const event = await dependencies.appendEvent(initial.root, {
    type: "publish.completed",
    actor_id: actorId,
    operation: "wiki.publish",
    record_id: repo.config.workspace_id,
    record_type: "workspace",
    subject_paths: ["openwiki.json"],
    data: {
      out_dir: finalOutDir,
      file_count: initial.files.length,
      files: initial.files,
      ...(options.baseUrl === undefined ? {} : { base_url: options.baseUrl }),
    },
  });
  let published: StaticExportResult;
  try {
    published = await dependencies.exportStaticSite(options);
  } catch (error) {
    await dependencies.appendEvent(initial.root, {
      type: "publish.failed",
      actor_id: actorId,
      operation: "wiki.publish",
      record_id: repo.config.workspace_id,
      record_type: "workspace",
      subject_paths: ["openwiki.json"],
      data: {
        out_dir: finalOutDir,
        completed_event_id: event.id,
        stage: "final_export",
        failure: "final_export_failed",
      },
    }).catch(() => undefined);
    throw error;
  }
  return { ...published, event };
}

export function temporaryStaticExportDir(outDir: string, input: { pid?: number; now?: number } = {}): string {
  const parent = path.dirname(outDir);
  const name = path.basename(outDir);
  return path.join(parent, `.${name}.${input.pid ?? process.pid}.${input.now ?? Date.now()}.tmp`);
}

export interface StaticExportFileSystem {
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export async function replaceStaticExportDirectory(
  sourceDir: string,
  outDir: string,
  fileSystem: StaticExportFileSystem = fs,
): Promise<void> {
  const previousDir = `${outDir}.${process.pid}.${Date.now()}.previous`;
  await fileSystem.rm(previousDir, { recursive: true, force: true });
  let movedPrevious = false;
  try {
    await fileSystem.rename(outDir, previousDir);
    movedPrevious = true;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await fileSystem.rename(sourceDir, outDir);
  } catch (error) {
    if (movedPrevious) {
      await fileSystem.rename(previousDir, outDir).catch(() => undefined);
    }
    throw error;
  }
  if (movedPrevious) {
    await fileSystem.rm(previousDir, { recursive: true, force: true });
  }
}
