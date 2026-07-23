/**
 * Shared loader for the monorepo distributed-ownership proving registry.
 * Used by readiness + doctor so path resolution does not drift.
 *
 * Override with GATEWAY_PROVING_REGISTRY_PATH when the monorepo docs tree
 * is not co-located with the package (packaged installs soft-fail cleanly).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DistributedOwnershipProvingRegistry {
  status?: string
  openMigrateHazards?: string[]
}

export type ProvingRegistryLoadResult =
  | { ok: true; registry: DistributedOwnershipProvingRegistry; registryPath: string }
  | { ok: false; reason: string; registryPath?: string }

/**
 * Resolve and load the proving registry JSON.
 * Walks up from this package (`src/`) toward repo root looking for
 * `docs/development/distributed-ownership-proving-registry.json`.
 */
export function loadDistributedOwnershipProvingRegistry(): ProvingRegistryLoadResult {
  const envPath = process.env['GATEWAY_PROVING_REGISTRY_PATH']?.trim()
  if (envPath) {
    return readRegistryFile(path.resolve(envPath))
  }

  const startDir = path.dirname(fileURLToPath(import.meta.url))
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'docs', 'development', 'distributed-ownership-proving-registry.json')
    if (fs.existsSync(candidate)) return readRegistryFile(candidate)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return {
    ok: false,
    reason: 'proving registry not found near package (assume single-daemon production only)',
  }
}

function readRegistryFile(registryPath: string): ProvingRegistryLoadResult {
  try {
    const raw = fs.readFileSync(registryPath, 'utf8')
    const registry = JSON.parse(raw) as DistributedOwnershipProvingRegistry
    return { ok: true, registry, registryPath }
  } catch (err: any) {
    return {
      ok: false,
      reason: err?.message || String(err),
      registryPath,
    }
  }
}
