import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPackageVersion } from '../version.js'

describe('version', () => {
  it('reports the package.json version (no hardcoded drift)', () => {
    const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const expected = JSON.parse(fs.readFileSync(packageFile, 'utf-8')).version
    expect(readPackageVersion()).toBe(expected)
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
