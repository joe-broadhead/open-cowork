import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'scripts/dependency-snapshot.mjs')

describe('dependency snapshot', () => {
  it('generates a stable source dependency budget without private absolute paths', () => {
    const { output, snapshot } = parsedSnapshot('--json')

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      sourceRoot: 'src',
      includeTests: false,
      moduleCount: expect.any(Number),
      edgeCount: expect.any(Number),
      cycleBudget: {
        status: expect.stringMatching(/^(acyclic|cycles_present)$/),
        stronglyConnectedComponentCount: expect.any(Number),
        maxComponentSize: expect.any(Number),
      },
      cycles: expect.any(Array),
      highFanOut: expect.any(Array),
      highFanIn: expect.any(Array),
      isolatedModules: expect.any(Array),
      unresolvedRelativeImports: expect.any(Array),
    })
    expect(snapshot.moduleCount).toBeGreaterThan(50)
    expect(snapshot.edgeCount).toBeGreaterThan(snapshot.moduleCount)
    expect(snapshot.highFanOut[0].id).toMatch(/^src\//)
    expect(output).not.toContain(ROOT)
  }, 60_000)

  it('can include test modules for broader cleanup audits', () => {
    const { snapshot: sourceOnly } = parsedSnapshot('--json')
    const { snapshot: withTests } = parsedSnapshot('--include-tests', '--json')

    expect(withTests.includeTests).toBe(true)
    expect(withTests.moduleCount).toBeGreaterThan(sourceOnly.moduleCount)
    expect(withTests.edgeCount).toBeGreaterThan(sourceOnly.edgeCount)
  }, 60_000)
})

const snapshotCache = new Map<string, { output: string; snapshot: any }>()

function parsedSnapshot(...args: string[]): { output: string; snapshot: any } {
  const key = args.join('\0')
  const cached = snapshotCache.get(key)
  if (cached) return cached
  const output = execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const result = { output, snapshot: JSON.parse(output) }
  snapshotCache.set(key, result)
  return result
}
