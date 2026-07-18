import type { OpenWikiAuthBoundsConfig } from "@openwiki/core";
import type { OpenWikiMcpToolMode, OpenWikiOperation, PolicyBounds } from "./types.ts";
import { operationNames, uniqueOperations } from "./operations.ts";

const OPERATION_NAMES = new Set<OpenWikiOperation>(operationNames());
const TOOL_MODES = new Set<OpenWikiMcpToolMode>(["read", "proposal", "write"]);

export function policyBoundsFromConfig(bounds: OpenWikiAuthBoundsConfig | undefined): PolicyBounds | undefined {
  if (bounds === undefined) {
    return undefined;
  }
  const operations = uniqueOperations((bounds.operations ?? []).filter(isOpenWikiOperation));
  const toolModes = uniqueToolModes((bounds.tool_modes ?? []).filter(isOpenWikiMcpToolMode));
  const dailyBudget = positiveInteger(bounds.daily_budget);
  const maxConcurrentRequests = positiveInteger(bounds.max_concurrent_requests);
  return emptyBounds({
    ...(operations.length === 0 ? {} : { operations }),
    ...(toolModes.length === 0 ? {} : { toolModes }),
    ...optionalStringList(bounds.path_prefixes, "pathPrefixes"),
    ...optionalStringList(bounds.section_ids, "sectionIds"),
    ...optionalStringList(bounds.source_ids, "sourceIds"),
    ...optionalStringList(bounds.inbox_providers, "inboxProviders"),
    ...(dailyBudget === undefined ? {} : { dailyBudget }),
    ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
    ...(bounds.expires_at === undefined ? {} : { expiresAt: bounds.expires_at }),
  });
}

export function mergePolicyBounds(
  outer: PolicyBounds | undefined,
  inner: PolicyBounds | undefined,
): PolicyBounds | undefined {
  if (outer === undefined) {
    return inner;
  }
  if (inner === undefined) {
    return outer;
  }
  return emptyBounds({
    ...intersectOperations(outer.operations, inner.operations, "operations"),
    ...intersectToolModes(outer.toolModes, inner.toolModes, "toolModes"),
    ...intersectPathPrefixes(outer.pathPrefixes, inner.pathPrefixes),
    ...intersectStrings(outer.sectionIds, inner.sectionIds, "sectionIds"),
    ...intersectStrings(outer.sourceIds, inner.sourceIds, "sourceIds"),
    ...intersectStrings(outer.inboxProviders, inner.inboxProviders, "inboxProviders"),
    ...minNumber(outer.dailyBudget, inner.dailyBudget, "dailyBudget"),
    ...minNumber(outer.maxConcurrentRequests, inner.maxConcurrentRequests, "maxConcurrentRequests"),
    ...earliestTimestamp(outer.expiresAt, inner.expiresAt, "expiresAt"),
  });
}

function optionalStringList<Key extends keyof PolicyBounds>(
  values: string[] | undefined,
  key: Key,
): Partial<Record<Key, string[]>> {
  const normalized = uniqueStrings((values ?? []).map((value) => value.trim()).filter(Boolean));
  return normalized.length === 0 ? {} : ({ [key]: normalized } as Partial<Record<Key, string[]>>);
}

function emptyBounds(bounds: PolicyBounds): PolicyBounds | undefined {
  return Object.keys(bounds).length === 0 ? undefined : bounds;
}

function intersectOperations(
  left: OpenWikiOperation[] | undefined,
  right: OpenWikiOperation[] | undefined,
  key: "operations",
): Partial<PolicyBounds> {
  const values = intersectValues(left, right);
  return values === undefined ? {} : { [key]: uniqueOperations(values) };
}

function intersectToolModes(
  left: OpenWikiMcpToolMode[] | undefined,
  right: OpenWikiMcpToolMode[] | undefined,
  key: "toolModes",
): Partial<PolicyBounds> {
  const values = intersectValues(left, right);
  return values === undefined ? {} : { [key]: uniqueToolModes(values) };
}

function intersectStrings<Key extends "sectionIds" | "sourceIds" | "inboxProviders">(
  left: string[] | undefined,
  right: string[] | undefined,
  key: Key,
): Partial<PolicyBounds> {
  const values = intersectValues(left, right);
  return values === undefined ? {} : { [key]: uniqueStrings(values) };
}

function intersectPathPrefixes(
  left: string[] | undefined,
  right: string[] | undefined,
): Partial<PolicyBounds> {
  if (left === undefined) {
    return right === undefined ? {} : { pathPrefixes: right };
  }
  if (right === undefined) {
    return { pathPrefixes: left };
  }
  if (left.length === 0 || right.length === 0) {
    return { pathPrefixes: [] };
  }
  const values = left.flatMap((leftPrefix) =>
    right
      .map((rightPrefix) => intersectPathPrefixPair(leftPrefix, rightPrefix))
      .filter((value): value is string => value !== undefined),
  );
  return { pathPrefixes: uniqueStrings(values) };
}

function intersectPathPrefixPair(left: string, right: string): string | undefined {
  const normalizedLeft = normalizePathPrefix(left);
  const normalizedRight = normalizePathPrefix(right);
  if (normalizedLeft === normalizedRight) {
    return normalizedLeft;
  }
  if (normalizedLeft.length === 0) {
    return normalizedRight;
  }
  if (normalizedRight.length === 0) {
    return normalizedLeft;
  }
  if (normalizedLeft.startsWith(`${normalizedRight}/`)) {
    return normalizedLeft;
  }
  if (normalizedRight.startsWith(`${normalizedLeft}/`)) {
    return normalizedRight;
  }
  return undefined;
}

function intersectValues<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  if (left.length === 0 || right.length === 0) {
    return [];
  }
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function minNumber<Key extends "dailyBudget" | "maxConcurrentRequests">(
  left: number | undefined,
  right: number | undefined,
  key: Key,
): Partial<PolicyBounds> {
  if (left === undefined) {
    return right === undefined ? {} : { [key]: right };
  }
  if (right === undefined) {
    return { [key]: left };
  }
  return { [key]: Math.min(left, right) };
}

function earliestTimestamp<Key extends "expiresAt">(
  left: string | undefined,
  right: string | undefined,
  key: Key,
): Partial<PolicyBounds> {
  if (left === undefined) {
    return right === undefined ? {} : { [key]: right };
  }
  if (right === undefined) {
    return { [key]: left };
  }
  return { [key]: Date.parse(left) <= Date.parse(right) ? left : right };
}

function positiveInteger(value: number | undefined): number | undefined {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? undefined : value;
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index, array) => array.indexOf(value) === index);
}

function normalizePathPrefix(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
}

function uniqueToolModes(values: OpenWikiMcpToolMode[]): OpenWikiMcpToolMode[] {
  return values.filter((value, index, array) => array.indexOf(value) === index);
}

function isOpenWikiOperation(value: string): value is OpenWikiOperation {
  return OPERATION_NAMES.has(value as OpenWikiOperation);
}

function isOpenWikiMcpToolMode(value: string): value is OpenWikiMcpToolMode {
  return TOOL_MODES.has(value as OpenWikiMcpToolMode);
}
