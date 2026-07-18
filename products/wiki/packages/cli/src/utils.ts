import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { CliOptions } from "./args.ts";
import { findWorkspaceRoot } from "@openwiki/repo";
import { openWikiPathExists } from "@openwiki/core";
import type { SearchRequest } from "@openwiki/core";

export { OPENWIKI_VERSION } from "@openwiki/core";
export const AUDIT_SOURCE_LIMIT = Number.POSITIVE_INFINITY;
export const MIN_NODE_VERSION = "22.22.3";
export const execFileAsync = promisify(execFile);

export async function resolveRoot(options: CliOptions): Promise<string> {
  if (options.root) {
    return path.resolve(options.root);
  }
  return findWorkspaceRoot(process.cwd());
}

export function searchFiltersFromOptions(options: CliOptions): Pick<SearchRequest, "filters"> {
  const filters: NonNullable<SearchRequest["filters"]> = {};
  if (options.topics.length > 0) {
    filters.topics = options.topics;
  }
  if (options.statuses.length > 0) {
    filters.status = options.statuses;
  }
  if (options.updatedAfter !== undefined) {
    filters.updated_after = options.updatedAfter;
  }
  return Object.keys(filters).length === 0 ? {} : { filters };
}

export const exists = openWikiPathExists;
