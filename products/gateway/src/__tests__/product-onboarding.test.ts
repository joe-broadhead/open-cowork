import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { clearWorkStateForTest, loadWorkState } from '../work-store.js'
import { buildEnvironmentTemplate, buildProjectWizardBody, createDemoProject, explainWhyNotRunning, resolveArtifactContent, writeEnvironmentTemplate } from '../product-onboarding.js'

describe('product onboarding helpers', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-product-onboarding-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('generates and writes environment templates without overwriting by default', () => {
    const nodeTemplate = buildEnvironmentTemplate('node')
    expect(nodeTemplate).toContain('defaultEnvironment: node-local')
    expect(nodeTemplate).toContain('extends: local-process')
    expect(nodeTemplate).toContain('npm test')

    const containerTemplate = buildEnvironmentTemplate('container')
    expect(containerTemplate).toContain('extends: local-container')
    expect(containerTemplate).not.toContain('runtime: docker')

    const crabboxTemplate = buildEnvironmentTemplate('crabbox')
    expect(crabboxTemplate).toContain('extends: remote-crabbox')
    expect(crabboxTemplate).not.toContain('cli: crabbox')

    const first = writeEnvironmentTemplate('docs', testDir)
    const second = writeEnvironmentTemplate('node', testDir)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(fs.readFileSync(first.path, 'utf-8')).toContain('docs-local')
  })

  it('builds project wizard payloads with quality defaults', () => {
    const body = buildProjectWizardBody({ alias: 'release-plan', title: 'Release Plan', priority: 'HIGH', tasks: ['Ship docs'], acceptanceCriteria: ['Docs are reviewed'] })

    expect(body).toMatchObject({ alias: 'release-plan', title: 'Release Plan', priority: 'HIGH', profile: 'supervisor' })
    expect(body.qualitySpec.acceptanceCriteria).toEqual(['Docs are reviewed'])
    expect(body.tasks[0]).toMatchObject({ title: 'Ship docs', pipeline: ['implement', 'review', 'verify'] })
  })

  it('explains scheduler and task states in operator language', () => {
    const paused = explainWhyNotRunning({ scheduler: { enabled: false, maxConcurrent: 3 } as any, tasks: [{ id: 'task_1', status: 'pending', readiness: { status: 'runnable' } }] })
    const blocked = explainWhyNotRunning({ scheduler: { enabled: true, maxConcurrent: 3 } as any, tasks: [{ id: 'task_2', status: 'pending', readiness: { status: 'blocked', reason: 'Waiting for dependency: Build base' } }] })

    expect(paused.map(row => row.title)).toContain('Scheduler is paused')
    expect(blocked.map(row => row.summary).join('\n')).toContain('Waiting for dependency')
  })

  it('creates a local demo project with a known safe artifact ref', () => {
    const demo = createDemoProject({ stateDir: testDir, dashboardUrl: 'http://127.0.0.1:4097/dashboard#/overview' })
    const state = loadWorkState(path.join(testDir, 'gateway.db'))
    const content = resolveArtifactContent(`file:${demo.artifactPath}`, state)

    expect(demo.text).toContain('Project: demo')
    expect(state.roadmaps.find(row => row.id === demo.roadmap.id)).toBeDefined()
    expect(state.runs.find(row => row.result?.artifacts?.includes(`file:${demo.artifactPath}`))).toBeDefined()
    expect(content.content).toContain('No model tokens were spent')
  })

  it('refuses known artifact refs outside Gateway preview roots', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-product-onboarding-outside-'))
    const outsidePath = path.join(outsideDir, 'private-note.txt')
    fs.writeFileSync(outsidePath, 'do not preview\n')
    const state = loadWorkState(path.join(testDir, 'gateway.db')) as any
    state.runs = [{ environment: { artifacts: [`file:${outsidePath}`] } }]

    expect(() => resolveArtifactContent(`file:${outsidePath}`, state)).toThrow(/outside the Gateway preview roots/)
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  it('refuses artifact symlinks that escape Gateway preview roots', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-product-onboarding-outside-symlink-'))
    const outsidePath = path.join(outsideDir, 'secret.txt')
    const linkPath = path.join(testDir, 'demo-artifacts', 'secret-link.txt')
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.writeFileSync(outsidePath, 'escaped through symlink\n')
    fs.symlinkSync(outsidePath, linkPath)
    const state = loadWorkState(path.join(testDir, 'gateway.db')) as any
    state.runs = [{ environment: { artifacts: [`file:${linkPath}`] } }]

    expect(() => resolveArtifactContent(`file:${linkPath}`, state)).toThrow(/outside the Gateway preview roots/)
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

})
