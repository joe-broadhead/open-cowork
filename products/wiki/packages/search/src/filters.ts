import type { IndexRecord } from "./records.ts";
import type { SearchRequest } from "@openwiki/core";

export function typeAllowed(type: string, allowed: string[] | undefined): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(type);
}

export function filtersAllowed(record: IndexRecord, filters: SearchRequest["filters"]): boolean {
  if (!filters) {
    return true;
  }
  if (filters.status && filters.status.length > 0) {
    const statusSet = new Set(filters.status);
    if (!statusSet.has(record.status)) {
      return false;
    }
  }
  if (filters.topics && filters.topics.length > 0) {
    const topicSet = new Set(record.topics);
    if (!filters.topics.some((topic) => topicSet.has(topic))) {
      return false;
    }
  }
  if (filters.updated_after && record.updated_at && record.updated_at < filters.updated_after) {
    return false;
  }
  return true;
}
