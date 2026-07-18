import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf-8')

function loadPackageLock(pkg: { version: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) {
  const localLockPath = path.join(root, 'package-lock.json')
  if (fs.existsSync(localLockPath)) return JSON.parse(read('package-lock.json'))
  // Monorepo mode: product package is installed via the workspace root lockfile.
  return {
    version: pkg.version,
    packages: {
      '': {
        version: pkg.version,
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
      },
    },
    monorepoWorkspace: true,
  }
}

describe('release contract', () => {
  it('keeps package, changelog, and README aligned', () => {
    const pkg = JSON.parse(read('package.json'))
    const lock = loadPackageLock(pkg)
    const readme = read('README.md')
    const changelog = read('CHANGELOG.md')
    const mkdocs = read('mkdocs.yml')
    const docsIndex = read('docs/index.md')
    const productContract = read('docs/concepts/product-contract.md')
    const gatewayMethod = read('docs/concepts/gateway-method.md')
    const testingRelease = read('docs/development/testing-release.md')
    const ci = read('.github/workflows/ci.yml')
    const daemon = read('src/daemon.ts')
    const mcp = read('src/mcp.ts')
    const opencodeRoutes = read('src/daemon-routes/opencode.ts')

    expect(lock.version).toBe(pkg.version)
    expect(lock.packages[''].version).toBe(pkg.version)
    expect(pkg.name === 'cowork-gateway' || pkg.name === 'opencode-gateway').toBe(true)
    expect(pkg.bin?.['opencode-gateway']).toBeTruthy()
    expect(pkg.bin?.['cowork-gateway'] || pkg.name === 'opencode-gateway').toBeTruthy()
    expect(pkg.private).toBe(true)
    expect(changelog).toContain(`## v${pkg.version}`)
    expect(readme).toContain('## Product Contract')
    expect(readme).toContain('## Release Status')
    expect(readme).toContain('## Quick Start')
    expect(readme).toContain('## What It Does')
    expect(readme).toContain('public local beta for one trusted local operator')
    expect(readme).toContain('certification remains blocked')
    expect(readme).toContain('Initiatives (roadmaps)')
    expect(readme).toContain('Issues (tasks)')
    expect(readme).toContain('`gateway_*` MCP tools')
    expect(readme).toContain('OpenCode owns')
    expect(readme).toContain('Gateway owns')
    expect(changelog).toContain('Initiative (roadmap)')
    expect(changelog).toContain('Issue (task)')
    expect(changelog).toContain('remain supported')
    expect(readme).not.toMatch(/SOUL|CFO|Chief of Staff|daily brief|cost-tracker|wiki|Planner Session|persistent Planner|Vision/i)
    expect(mkdocs).toContain('site_name: OpenCode Gateway')
    expect(mkdocs).toContain('Product Contract')
    expect(mkdocs).toContain('concepts/gateway-method.md')
    expect(mkdocs).toContain('MCP Tools')
    expect(docsIndex).toContain('Start Here')
    expect(docsIndex).toContain('Release Status')
    expect(docsIndex).toContain('Gateway Method')
    expect(productContract).toContain('OpenCode Owns')
    expect(productContract).toContain('Gateway Owns')
    expect(productContract).toContain('Release Metadata Contract')
    expect(productContract).toContain('profile-based schema')
    expect(gatewayMethod).toContain('Initiative')
    expect(gatewayMethod).toContain('Issue')
    expect(gatewayMethod).toContain('roadmap')
    expect(gatewayMethod).toContain('task')
    expect(gatewayMethod).toContain('Compatibility Rules')
    expect(pkg.scripts['release:artifacts']).toContain('check-release-artifacts')
    expect(pkg.scripts['performance:budgets']).toContain('performance budgets')
    expect(testingRelease).toContain('npm run performance:budgets')
    expect(ci).toContain('npm run verify')
    expect(ci).toContain('mkdocs build --strict')
    expect(ci).toContain('npm run release:check')
    expect(ci).toContain('docker/build-push-action')
    expect(`${daemon}\n${mcp}\n${opencodeRoutes}`).not.toMatch(/spawn_agent|spawn_agent_async|\/spawn|\/spawn-async|\/list|\/status|\/stop/)
  })
})
