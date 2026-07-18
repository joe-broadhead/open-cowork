import { rebuildIndexStore } from "@openwiki/index-store";
import { postgresRuntimeWriteSyncEnabled, syncPostgresRuntimeIndex } from "@openwiki/postgres-runtime";
import { buildSearchIndex } from "@openwiki/search";

export async function rebuildDerivedIndexes(root: string): Promise<void> {
  await Promise.all([buildSearchIndex(root), rebuildIndexStore(root)]);
  if (postgresRuntimeWriteSyncEnabled()) {
    await syncPostgresRuntimeIndex(root);
  }
}
