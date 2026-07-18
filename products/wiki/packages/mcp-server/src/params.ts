
import type { DecisionValue, ProposalStatus, SearchPersona, SearchRequest } from "@openwiki/core";
import { SOURCE_FETCH_CONNECTOR_KIND_LABEL, isSourceFetchConnectorKind, type SourceFetchConnectorKind } from "@openwiki/connectors";
import type { GovernanceDetectorKind } from "@openwiki/workflows";

export function optionalGraphDirectionParam(args: Record<string, unknown>, name: string): "in" | "out" | "both" | undefined {
  const value = optionalStringParam(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (value === "in" || value === "out" || value === "both") {
    return value;
  }
  throw new Error("Expected " + name + " to be in, out, or both");
}

export function objectParams(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected string parameter '${key}'`);
  }
  return value;
}

export function optionalNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric parameter '${key}'`);
  }
  return value;
}

export function boundedOptionalNumberParam(params: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = optionalNumberParam(params, key);
  if (value === undefined) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

export function optionalBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean parameter '${key}'`);
  }
  return value;
}

export function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string parameter '${key}'`);
  }
  return value;
}

export function optionalStringObjectProperty<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string>> {
  const value = optionalStringParam(params, inputKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<Key, string>>);
}

export function optionalConnectorKindParam(params: Record<string, unknown>, key: string): SourceFetchConnectorKind | undefined {
  const value = optionalStringParam(params, key);
  if (value === undefined) {
    return undefined;
  }
  if (!isSourceFetchConnectorKind(value)) {
    throw new Error(`Expected connector kind parameter '${key}' to be ${SOURCE_FETCH_CONNECTOR_KIND_LABEL}`);
  }
  return value;
}

export function optionalStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Expected string array parameter '${key}'`);
  }
  return value;
}

export function stringArrayParam(params: Record<string, unknown>, key: string): string[] {
  const value = optionalStringArrayParam(params, key);
  if (value === undefined || value.length === 0) {
    throw new Error(`Expected non-empty string array parameter '${key}'`);
  }
  return value;
}

export function optionalGovernanceDetectorsParam(params: Record<string, unknown>): { detectors?: GovernanceDetectorKind[] } {
  const values = optionalStringArrayParam(params, "detectors");
  if (values === undefined || values.length === 0) {
    return {};
  }
  return { detectors: values.map(governanceDetectorKindParam) };
}

function governanceDetectorKindParam(value: string): GovernanceDetectorKind {
  if (value === "stale_claim" || value === "missing_source" || value === "broken_link" || value === "orphan_page") {
    return value;
  }
  throw new Error(`Invalid governance detector '${value}'`);
}

export function optionalStaleAfterDaysParam(params: Record<string, unknown>): { staleAfterDays?: number } {
  const value = optionalNumberParam(params, "stale_after_days");
  return value === undefined ? {} : { staleAfterDays: value };
}

export function optionalVisibilityParam(params: Record<string, unknown>, key: string): "public" | "internal" | "private" | undefined {
  const value = optionalStringParam(params, key);
  if (value === undefined) {
    return undefined;
  }
  if (value === "public" || value === "internal" || value === "private") {
    return value;
  }
  throw new Error(`Expected visibility parameter '${key}' to be public, internal, or private`);
}

export function optionalCloseResolutionParam(params: Record<string, unknown>, key: string): "closed" | "superseded" | "withdrawn" | "duplicate" | "stale" | "invalid" | undefined {
  const value = optionalStringParam(params, key);
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "closed" ||
    value === "superseded" ||
    value === "withdrawn" ||
    value === "duplicate" ||
    value === "stale" ||
    value === "invalid"
  ) {
    return value;
  }
  throw new Error(`Invalid proposal close resolution '${value}'`);
}

export function optionalProposalStatusArrayParam(params: Record<string, unknown>, key: string): ProposalStatus[] | undefined {
  const values = optionalStringArrayParam(params, key);
  return values === undefined ? undefined : values.map(proposalStatusParam);
}

function proposalStatusParam(value: string): ProposalStatus {
  if (value === "open" || value === "accepted" || value === "rejected" || value === "applied" || value === "closed") {
    return value;
  }
  throw new Error(`Invalid proposal status '${value}'`);
}

export function optionalObjectParam(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object parameter '${key}'`);
  }
  return value as Record<string, unknown>;
}

export function optionalSearchStringArrayParam<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string[]>> {
  const value = optionalStringArrayParam(params, inputKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<Key, string[]>>);
}

export function optionalSearchBooleanParam<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, boolean>> {
  const value = optionalBooleanParam(params, inputKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<Key, boolean>>);
}

export function optionalSearchPersonaParam(params: Record<string, unknown>): Pick<SearchRequest, "persona"> {
  const value = optionalStringParam(params, "persona");
  if (value === undefined) {
    return {};
  }
  return { persona: searchPersona(value) };
}

export function optionalSearchModeParam(params: Record<string, unknown>): Pick<SearchRequest, "mode"> {
  const value = optionalStringParam(params, "mode");
  if (value === undefined) {
    return {};
  }
  if (value === "lexical" || value === "hybrid") {
    return { mode: value };
  }
  throw new Error(`Invalid search mode '${value}'`);
}

export function optionalSearchFiltersParam(params: Record<string, unknown>): Pick<SearchRequest, "filters"> {
  const value = params.filters;
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object parameter 'filters'");
  }
  const filtersParam = value as Record<string, unknown>;
  const filters: NonNullable<SearchRequest["filters"]> = {};
  const topics = optionalStringArrayParam(filtersParam, "topics");
  const status = optionalStringArrayParam(filtersParam, "status");
  const updatedAfter = optionalStringParam(filtersParam, "updated_after");
  if (topics !== undefined) {
    filters.topics = topics;
  }
  if (status !== undefined) {
    filters.status = status;
  }
  if (updatedAfter !== undefined) {
    filters.updated_after = updatedAfter;
  }
  return Object.keys(filters).length === 0 ? {} : { filters };
}

export function searchPersona(value: string): SearchPersona {
  if (
    value === "default" ||
    value === "researcher" ||
    value === "editor" ||
    value === "reviewer" ||
    value === "governance"
  ) {
    return value;
  }
  throw new Error(`Invalid search persona '${value}'`);
}

export function policyFileParam(params: Record<string, unknown>, key: string): "sections" | "grants" | "approval-rules" | "approval_rules" {
  const value = stringParam(params, key);
  if (value === "sections" || value === "grants" || value === "approval-rules" || value === "approval_rules") {
    return value;
  }
  throw new Error("Invalid policy file '" + value + "'");
}

export function decisionParam(params: Record<string, unknown>, key: string): DecisionValue {
  const value = stringParam(params, key);
  if (value === "accepted" || value === "rejected" || value === "needs_changes") {
    return value;
  }
  throw new Error(`Invalid proposal decision '${value}'`);
}
