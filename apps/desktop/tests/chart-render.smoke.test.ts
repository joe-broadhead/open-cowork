import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const desktopAppDir = resolve(thisDir, '..')
const repoRoot = resolve(desktopAppDir, '../..')

function createIsolatedConfig(tempRoot: string) {
  const sourcePath = join(repoRoot, 'open-cowork.config.json')
  const config = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, any>
  config.branding = {
    ...(config.branding || {}),
    name: 'Open Cowork E2E',
    appId: 'com.opencowork.desktop.e2e',
    dataDirName: 'open-cowork-e2e',
  }

  const targetPath = join(tempRoot, 'open-cowork.e2e.config.json')
  writeFileSync(targetPath, JSON.stringify(config, null, 2))
  return targetPath
}

test('chart renderer round-trips through preload and main IPC', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-e2e-'))
  const tempHome = join(tempRoot, 'home')
  const xdgConfigHome = join(tempRoot, 'xdg-config')
  const xdgDataHome = join(tempRoot, 'xdg-data')
  const xdgCacheHome = join(tempRoot, 'xdg-cache')
  const sandboxDir = join(tempRoot, 'sandbox')

  mkdirSync(tempHome, { recursive: true })
  mkdirSync(xdgConfigHome, { recursive: true })
  mkdirSync(xdgDataHome, { recursive: true })
  mkdirSync(xdgCacheHome, { recursive: true })
  mkdirSync(sandboxDir, { recursive: true })

  const configPath = createIsolatedConfig(tempRoot)
  const app = await electron.launch({
    cwd: desktopAppDir,
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      OPEN_COWORK_CONFIG_PATH: configPath,
      OPEN_COWORK_SANDBOX_DIR: sandboxDir,
      OPEN_COWORK_CHART_TIMEOUT_MS: '1500',
      OPEN_COWORK_E2E: '1',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => {
      return Boolean(
        document.querySelector('#root')
        && typeof window.openCowork?.chart?.renderSvg === 'function'
        && typeof window.openCowork?.app?.config === 'function',
      )
    })

    const svg = await page.evaluate(async () => {
      return window.openCowork.chart.renderSvg({
        $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
        data: {
          values: [
            { category: 'A', value: 3 },
            { category: 'B', value: 5 },
          ],
        },
        mark: 'bar',
        encoding: {
          x: { field: 'category', type: 'nominal' },
          y: { field: 'value', type: 'quantitative' },
        },
      })
    })

    assert.match(svg, /<svg[\s>]/)
    assert.match(svg, /A/)
    assert.match(svg, /B/)

    const blocked = await page.evaluate(async () => {
      try {
        await window.openCowork.chart.renderSvg({
          $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
          data: {
            url: 'https://example.com/remote.csv',
          },
          mark: 'bar',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'value', type: 'quantitative' },
          },
        })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })

    assert.match(blocked || '', /only supports local inline specs/i)
  } finally {
    await app.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
