import type { HttpRouteResult } from "./types.ts";
import type { PageRecord } from "@openwiki/core";
import { loadRepository, renderPageMarkdown } from "@openwiki/repo";
import { pageLegacyRoute, pagePublicRoute } from "./renderers/graph.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function pageRepresentation(page: PageRecord, format: "json" | "md"): HttpRouteResult {
  if (format === "json") {
    return { status: 200, body: page };
  }
  return {
    status: 200,
    body: renderPageMarkdown(page),
    contentType: "text/markdown; charset=utf-8",
  };
}

export function adjacentPageId(pathname: string, prefix: string): { id: string; format: "json" | "md" } | undefined {
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const value = pathname.slice(prefix.length);
  if (value.includes("/")) {
    return undefined;
  }
  const parsed = stripRepresentationSuffix(value);
  return parsed === undefined ? undefined : { id: decodeURIComponent(parsed.stem), format: parsed.format };
}

export function adjacentJsonId(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const value = pathname.slice(prefix.length);
  if (value.includes("/") || !value.endsWith(".json")) {
    return undefined;
  }
  return decodeURIComponent(value.slice(0, -".json".length));
}

export async function publicPageRoute(
  root: string,
  pathname: string,
): Promise<{ page: PageRecord; format: "json" | "md" } | undefined> {
  const parsed = stripRepresentationSuffix(pathname.replace(/^\/+/, ""));
  if (parsed === undefined) {
    return undefined;
  }
  const parts = parsed.stem.split("/");
  if (parts.length !== 2) {
    return undefined;
  }
  const [rawType, rawSlug] = parts;
  if (!rawType || !rawSlug || rawType === "api" || rawType === "pages" || rawType === "proposals") {
    return undefined;
  }
  const repo = await loadRepository(root);
  const page = repo.pages.find((candidate) => pagePublicRoute(candidate).slice(1) === parsed.stem || pageLegacyRoute(candidate.id) === parsed.stem);
  return page === undefined ? undefined : { page, format: parsed.format };
}

function stripRepresentationSuffix(value: string): { stem: string; format: "json" | "md" } | undefined {
  if (value.endsWith(".json")) {
    return { stem: value.slice(0, -".json".length), format: "json" };
  }
  if (value.endsWith(".md")) {
    return { stem: value.slice(0, -".md".length), format: "md" };
  }
  return undefined;
}

export function pathId(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const value = pathname.slice(prefix.length);
  if (value.includes("/")) {
    return undefined;
  }
  return value ? decodeURIComponent(value) : undefined;
}

export function webActionId(
  pathname: string,
  prefix: string,
  action: "edit" | "propose" | "review" | "apply" | "comment" | "close" | "diff" | "revoke" | "rotate" | "process" | "ignore" | "retry",
): string | undefined {
  const suffix = `/${action}`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return undefined;
  }
  const value = pathname.slice(prefix.length, -suffix.length);
  if (!value || value.includes("/")) {
    return undefined;
  }
  return decodeURIComponent(value);
}

export function recordActionId(pathname: string, prefix: string, action: "history" | "diff" | "trace" | "content"): string | undefined {
  const suffix = `/${action}`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return undefined;
  }
  const value = pathname.slice(prefix.length, -suffix.length);
  return value ? decodeURIComponent(value) : undefined;
}

export function graphActionId(pathname: string, action: "neighbors" | "backlinks" | "related"): string | undefined {
  const prefix = "/api/v1/graph/";
  const suffix = "/" + action;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return undefined;
  }
  const value = pathname.slice(prefix.length, -suffix.length);
  return value ? decodeURIComponent(value) : undefined;
}

export function proposalActionId(
  pathname: string,
  action: "review" | "close" | "apply" | "detail" | "diff" | "snapshot" | "validation" | "comments",
): string | undefined {
  const prefix = "/api/v1/proposals/";
  const suffix = `/${action}`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return undefined;
  }
  const value = pathname.slice(prefix.length, -suffix.length);
  return value ? decodeURIComponent(value) : undefined;
}
