import { describe, expect, it } from 'vitest'
import { checkNodeSqliteRuntime, describeCliStartupFailure, isMissingBuildError, nodeSqliteSupported } from '../../bin/preflight.mjs'

describe('bin wrapper preflight', () => {
  it('knows the node:sqlite unflagged boundary (22.13 in 22.x, 23.4+, 24+)', () => {
    expect(nodeSqliteSupported('22.5.0')).toBe(false)
    expect(nodeSqliteSupported('22.12.0')).toBe(false)
    expect(nodeSqliteSupported('22.13.0')).toBe(true)
    expect(nodeSqliteSupported('23.3.0')).toBe(false)
    expect(nodeSqliteSupported('23.4.0')).toBe(true)
    expect(nodeSqliteSupported('24.0.0')).toBe(true)
    expect(nodeSqliteSupported('18.19.0')).toBe(false)
  })

  it('prints a friendly requirement instead of a stack trace on unsupported runtimes', () => {
    const message = checkNodeSqliteRuntime('22.5.0')
    expect(message).toContain('requires Node.js >= 22.13')
    expect(message).toContain('Current: v22.5.0')
    expect(checkNodeSqliteRuntime('22.13.1')).toBeUndefined()
  })

  it('only blames a missing build when dist/cli.js itself is missing', () => {
    const missingBuild = Object.assign(new Error("Cannot find module '/opt/gateway/dist/cli.js' imported from /opt/gateway/bin/opencode-gateway"), { code: 'ERR_MODULE_NOT_FOUND' })
    const missingDependency = Object.assign(new Error("Cannot find module 'zod' imported from /opt/gateway/dist/cli.js"), { code: 'ERR_MODULE_NOT_FOUND' })
    const runtimeCrash = new Error('boom at module scope')

    expect(isMissingBuildError(missingBuild)).toBe(true)
    expect(isMissingBuildError(missingDependency)).toBe(false)
    expect(isMissingBuildError(runtimeCrash)).toBe(false)

    expect(describeCliStartupFailure(missingBuild)).toContain('npm run build')
    // The real error is preserved instead of the misleading rebuild hint.
    expect(describeCliStartupFailure(missingDependency)).toContain("Cannot find module 'zod'")
    expect(describeCliStartupFailure(missingDependency)).not.toContain('npm run build &&')
    expect(describeCliStartupFailure(runtimeCrash)).toContain('boom at module scope')
  })
})
