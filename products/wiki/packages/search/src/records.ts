export interface IndexRecord {
  id: string;
  type: string;
  title: string;
  summary: string;
  uri: string;
  path: string;
  body: string;
  topics: string[];
  source_ids: string[];
  status: string;
  updated_at: string;
  url?: string;
}

export function searchIndexRecordFromJson(json: string): IndexRecord {
  const parsed = JSON.parse(json) as unknown;
  if (!isIndexRecord(parsed)) {
    throw new Error("Invalid search index record JSON");
  }
  return parsed;
}

function isIndexRecord(value: unknown): value is IndexRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    typeof record.uri === "string" &&
    typeof record.path === "string" &&
    typeof record.body === "string" &&
    Array.isArray(record.topics) &&
    record.topics.every((topic) => typeof topic === "string") &&
    Array.isArray(record.source_ids) &&
    record.source_ids.every((sourceId) => typeof sourceId === "string") &&
    typeof record.status === "string" &&
    typeof record.updated_at === "string" &&
    (record.url === undefined || typeof record.url === "string")
  );
}
