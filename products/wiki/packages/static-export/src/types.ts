import { appendEvent, loadRepository } from "@openwiki/repo";

export interface StaticExportOptions {
  root: string;
  outDir?: string;
  baseUrl?: string;
  htmlPageCeiling?: number;
  sitemapShardSize?: number;
  llmsFullMaxBytes?: number;
}

export interface StaticExportResult {
  root: string;
  outDir: string;
  files: string[];
  html_mode: "full" | "machine-only";
  html_page_count: number;
  html_page_ceiling: number;
  sitemap_files: string[];
  warnings: string[];
}

export interface PublishStaticSiteOptions extends StaticExportOptions {
  actorId?: string;
}

export interface PublishStaticSiteResult extends StaticExportResult {
  event: Awaited<ReturnType<typeof appendEvent>>;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, unknown>;
  components?: Record<string, unknown>;
}

export interface McpManifestDocument {
  name: string;
  version: string;
  transport: string[];
  http_endpoint: string;
  http_transport: Record<string, unknown>;
  default_tool_mode: string;
  tool_output: Record<string, unknown>;
  tool_modes: Record<string, unknown>;
  resources: string[];
  prompts: string[];
}

export const DEFAULT_STATIC_HTML_PAGE_CEILING = 10_000;
export const DEFAULT_SITEMAP_SHARD_SIZE = 45_000;
export const DEFAULT_LLMS_FULL_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_STATIC_EXPORT_OUT_DIR = "public";
export const RESERVED_EXPORT_TOP_LEVEL_DIRS = new Set([
  ".git",
  ".openwiki",
  "claims",
  "decisions",
  "events",
  "policy",
  "proposals",
  "runs",
  "sources",
  "wiki",
]);

export type StaticRepo = Awaited<ReturnType<typeof loadRepository>>;
