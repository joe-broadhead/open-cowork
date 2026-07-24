/**
 * JOE-994 Phase 1: monorepo-side dual-stack protocol contract helpers.
 * Compares gateway-channel capability snapshots to the shared vocabulary in
 * `@open-cowork/shared` without requiring Durable Gateway imports.
 */
import {
  CHANNEL_ADAPTER_CAPABILITY_KEYS,
  isCompleteAdapterCategoryStatusMap,
  mapMonorepoCapabilitiesToAdapterCategories,
  monorepoCapabilitiesMissingKeys,
  type AdapterCategoryStatusMap,
  type MonorepoCapabilitySnapshot,
} from "@open-cowork/shared";
import type { ChannelCapabilities } from "./provider.js";
import { normalizeChannelCapabilities } from "./provider.js";

export type DualStackMonorepoCapabilityReport = {
  providerLabel: string;
  missingKeys: string[];
  categoryMap: AdapterCategoryStatusMap;
  ok: boolean;
  violations: string[];
};

export function reportMonorepoProviderCapabilities(
  providerLabel: string,
  capabilities: ChannelCapabilities,
): DualStackMonorepoCapabilityReport {
  const normalized = normalizeChannelCapabilities(capabilities);
  const snapshot = normalized as MonorepoCapabilitySnapshot;
  const missingKeys = monorepoCapabilitiesMissingKeys(snapshot);
  const categoryMap = mapMonorepoCapabilitiesToAdapterCategories(snapshot);
  const violations: string[] = [];
  if (missingKeys.length) {
    violations.push(`missing monorepo capability keys: ${missingKeys.join(", ")}`);
  }
  if (!isCompleteAdapterCategoryStatusMap(categoryMap)) {
    violations.push("mapped adapter category matrix is incomplete");
  }
  for (const key of CHANNEL_ADAPTER_CAPABILITY_KEYS) {
    if (!categoryMap[key]) violations.push(`missing mapped category ${key}`);
  }
  // Overlap providers should expose basic chat delivery surface.
  if (!normalized.maxTextLength || normalized.maxTextLength < 1) {
    violations.push("maxTextLength must be positive");
  }
  return {
    providerLabel,
    missingKeys,
    categoryMap,
    ok: violations.length === 0,
    violations,
  };
}

export function assertMonorepoProviderCapabilities(
  providerLabel: string,
  capabilities: ChannelCapabilities,
): void {
  const report = reportMonorepoProviderCapabilities(providerLabel, capabilities);
  if (!report.ok) {
    throw new Error(
      `dual-stack monorepo capability contract failed for ${providerLabel}: ${report.violations.join("; ")}`,
    );
  }
}
