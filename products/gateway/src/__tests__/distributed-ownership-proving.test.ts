import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * JOE-949: Distributed ownership proving suite gate.
 *
 * Does not enable multi-replica by itself. Asserts the hazard inventory,
 * design doc, registry, Helm fail-closed wording, and required tests exist
 * so experimentalDistributedOwnership cannot be marketed as production HA.
 */
const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const registryPath = path.join(monorepoRoot, 'docs/development/distributed-ownership-proving-registry.json')

describe('distributed ownership proving suite (JOE-949)', () => {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
    status: string
    openMigrateHazards: string[]
    requiredTests: Array<{ id: string; path: string }>
    requiredScripts: Array<{ id: string; path: string }>
    marketingForbiddenClaims: string[]
  }

  it('registry is present and not falsely marked ready while migrate hazards remain', () => {
    expect(registry.openMigrateHazards.length).toBeGreaterThan(0)
    expect(registry.status).not.toBe('ready')
  })

  it('required tests and scripts exist on disk', () => {
    for (const entry of registry.requiredTests) {
      const abs = path.join(monorepoRoot, entry.path)
      expect(fs.existsSync(abs), `missing required test ${entry.id}: ${entry.path}`).toBe(true)
    }
    for (const entry of registry.requiredScripts) {
      const abs = path.join(monorepoRoot, entry.path)
      expect(fs.existsSync(abs), `missing required script ${entry.id}: ${entry.path}`).toBe(true)
    }
  })

  it('hazard inventory documents migrate items H1/H3/H4', () => {
    const inventory = fs.readFileSync(
      path.join(monorepoRoot, 'products/gateway/docs/concepts/multi-writer-hazards.md'),
      'utf8',
    )
    for (const id of ['H1', 'H3', 'H4', 'H8', 'H13']) {
      expect(inventory, `inventory missing ${id}`).toContain(`| ${id} `)
    }
    expect(inventory).toMatch(/channel-sync\.json/)
    expect(inventory).toMatch(/sessions\.json/)
    expect(inventory).toMatch(/events\.json/)
  })

  it('design doc links fencing + proving suite and forbids multi-AZ claims until ready', () => {
    const design = fs.readFileSync(
      path.join(monorepoRoot, 'products/gateway/docs/concepts/distributed-ownership-design.md'),
      'utf8',
    )
    expect(design).toMatch(/fencing_token/)
    expect(design).toMatch(/experimentalDistributedOwnership/)
    expect(design).toMatch(/No multi-AZ HA/)
    expect(design).toMatch(/JOE-949/)
  })

  it('Helm deployment template still fails closed for multi-replica without experimental flag', () => {
    const deployment = fs.readFileSync(
      path.join(monorepoRoot, 'helm/open-cowork-gateway/templates/deployment.yaml'),
      'utf8',
    )
    expect(deployment).toMatch(/replicaCount/)
    expect(deployment).toMatch(/experimentalDistributedOwnership/)
    expect(deployment).toMatch(/unsafe while stream\/replay state is process-local/)
  })

  it('values default experimentalDistributedOwnership to false', () => {
    const values = fs.readFileSync(
      path.join(monorepoRoot, 'helm/open-cowork-gateway/values.yaml'),
      'utf8',
    )
    expect(values).toMatch(/experimentalDistributedOwnership:\s*false/)
  })
})
