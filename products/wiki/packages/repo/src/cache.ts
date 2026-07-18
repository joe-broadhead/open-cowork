import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { LoadedOpenWikiRepo } from "./types.ts";

export interface RepositoryReadCacheEntry {
  loaded: Promise<LoadedOpenWikiRepo>;
  fingerprint: string;
  mutationToken: number;
}

export interface RepositoryProcessReadCacheEntry extends RepositoryReadCacheEntry {
  expiresAt: number;
}

export const repositoryReadCache = new AsyncLocalStorage<Map<string, RepositoryReadCacheEntry>>();
export const repositoryProcessReadCache = new Map<string, RepositoryProcessReadCacheEntry>();

const repositoryMutationTokens = new Map<string, number>();

export function repositoryMutationToken(root: string): number {
  return repositoryMutationTokens.get(path.resolve(root)) ?? 0;
}

export function markRepositoryChanged(root: string): void {
  const resolved = path.resolve(root);
  repositoryMutationTokens.set(resolved, repositoryMutationToken(resolved) + 1);
  repositoryProcessReadCache.delete(resolved);
  repositoryReadCache.getStore()?.delete(resolved);
}

export function clearRepositoryProcessReadCache(root?: string): void {
  if (root === undefined) {
    repositoryProcessReadCache.clear();
    return;
  }
  repositoryProcessReadCache.delete(path.resolve(root));
}
