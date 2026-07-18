import {
  openWikiDerivedRecordFromUnknown,
  openWikiIndexedRecordJsonFromUnknown,
  openWikiWorkspaceConfigFromUnknown,
  type OpenWikiConfig,
  type OpenWikiDerivedRecordType,
} from "@openwiki/core";

export function indexStoreRecordFromJson<T>(json: unknown, type: OpenWikiDerivedRecordType): T {
  return openWikiDerivedRecordFromUnknown<T>(parseJsonObject(json), type, `index-store ${type} record`);
}

export function indexStoreWorkspaceConfigFromJson(json: unknown): OpenWikiConfig & Record<string, unknown> {
  return openWikiWorkspaceConfigFromUnknown<OpenWikiConfig & Record<string, unknown>>(parseJsonObject(json), "index-store workspace config");
}

export function indexStoreIndexedRecordJsonFromJson(json: unknown, type: string): Record<string, unknown> {
  return openWikiIndexedRecordJsonFromUnknown(parseJsonObject(json), type, `index-store ${type} record`);
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return parseJsonObject(parsed);
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
